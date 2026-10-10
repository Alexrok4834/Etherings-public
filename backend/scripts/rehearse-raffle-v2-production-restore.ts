import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import {
  applyRaffleV2Consolidation,
  discoverRaffleV2LegacySource,
  fingerprintRaffleV2LegacySource,
} from '../src/raffle/raffle-v2-consolidation';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^raffle_v2_prod_rehearsal(?:_[a-z0-9]+)*_qa$/.test(databaseName)) {
  throw new Error('Refusing to rehearse outside an approved Raffle v2 restore name');
}
if (process.env.RAFFLE_V2_REHEARSAL_CONFIRM !== 'rollback-only') {
  throw new Error('RAFFLE_V2_REHEARSAL_CONFIRM=rollback-only is required');
}
const expectedSourceFingerprint = process.env.RAFFLE_V2_EXPECTED_SOURCE_FINGERPRINT;
if (!expectedSourceFingerprint || !/^[a-f0-9]{64}$/.test(expectedSourceFingerprint)) {
  throw new Error('RAFFLE_V2_EXPECTED_SOURCE_FINGERPRINT is required');
}

async function main() {
  const migrationDataSource = await loadMigrationDataSource();
  await migrationDataSource.initialize();
  try {
    const source = await discoverRaffleV2LegacySource(migrationDataSource.manager);
    assert.equal(fingerprintRaffleV2LegacySource(source), expectedSourceFingerprint, 'source drift');
    assert.equal(source.counts.v2SchemaPresent, false);
    const historyBefore = await historyFingerprint(migrationDataSource);
    const applied = await migrationDataSource.runMigrations({ transaction: 'all' });
    assert.deepEqual(applied.map((migration) => migration.name), [
      'CreateRaffleV2SingletonSchema1787616000000',
      'CreateRaffleV2DrawEvidenceSchema1787702400000',
      'CreateRaffleCopperAwardSchema1787788800000',
      'CreateRingEquipmentOperationSchema1787875200000',
    ]);
    const [creator] = await migrationDataSource.query(`
      SELECT min(id::text) AS id, count(*)::int AS count FROM users WHERE is_admin
    `);
    assert.equal(creator.count, 1, 'rehearsal requires exactly one admin creator');

    const runner = migrationDataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('SERIALIZABLE');
      try {
        const result = await applyRaffleV2Consolidation(runner.manager, {
          creatorId: creator.id,
          expectedActiveLegacyPools: 2,
        });
        const [state] = await runner.query(`
          SELECT
            (SELECT count(*)::int FROM raffle_pools WHERE is_active) AS "activeLegacyPools",
            (SELECT count(*)::int FROM raffle_configurations WHERE status = 'ACTIVE') AS "activeConfigurations",
            (SELECT count(*)::int FROM raffle_configuration_rewards WHERE configuration_id = $1) AS "mappingCount",
            (SELECT sum(weight)::int FROM raffle_configuration_rewards WHERE configuration_id = $1) AS "totalWeight",
            (SELECT count(*)::int FROM rewards WHERE code LIKE 'raffle-v2-%-v1') AS "targetRewardCount"
        `, [result.configurationId]);
        assert.deepEqual(state, {
          activeLegacyPools: 0,
          activeConfigurations: 1,
          mappingCount: 9,
          totalWeight: 100,
          targetRewardCount: 9,
        });
        assert.deepEqual(await historyFingerprint(runner.manager), historyBefore);
      } finally {
        await runner.rollbackTransaction();
      }
    } finally {
      await runner.release();
    }

    const [post] = await migrationDataSource.query(`
      SELECT
        (SELECT count(*)::int FROM raffle_pools WHERE is_active) AS "activeLegacyPools",
        (SELECT count(*)::int FROM raffle_machines) AS "machines",
        (SELECT count(*)::int FROM raffle_configurations) AS "configurations",
        (SELECT count(*)::int FROM raffle_configuration_rewards) AS "mappings",
        (SELECT count(*)::int FROM rewards WHERE code LIKE 'raffle-v2-%-v1') AS "targetRewards",
        (SELECT count(*)::int FROM migrations) AS migrations
    `);
    assert.deepEqual(post, {
      activeLegacyPools: 2,
      machines: 0,
      configurations: 0,
      mappings: 0,
      targetRewards: 0,
      migrations: 13,
    });
    assert.deepEqual(await historyFingerprint(migrationDataSource), historyBefore);
    console.log(JSON.stringify({
      database: databaseName,
      sourceFingerprintMatched: true,
      migrationsApplied: 4,
      migrationCountAfter: 13,
      uniqueAdminCreatorBoundPrivately: true,
      newManifestRewardIdentities: 9,
      activeLegacyPoolsInsideTransaction: 0,
      singletonConfigurationsInsideTransaction: 1,
      legacyHistoryUnchanged: true,
      consolidationRolledBack: true,
      legacyPoolsRestoredAfterRollback: 2,
    }, null, 2));
  } finally {
    await migrationDataSource.destroy();
  }
}

async function loadMigrationDataSource(): Promise<DataSource> {
  const imported = await import('../dist/database/data-source.js');
  return imported.default;
}

async function historyFingerprint(source: DataSource | { query: DataSource['query'] }) {
  return {
    raffleDraws: await source.query(`
      SELECT id, user_id, pool_id, reward_id, cost_ert::text, random_roll::text,
        weights_snapshot, reward_snapshot, created_at
      FROM raffle_draws ORDER BY id
    `),
    userRewards: await source.query(`
      SELECT id, user_id, reward_id, raffle_draw_id, title, type::text, amount::text,
        amount_exact::text, eru_balance_after::text, metadata, created_at
      FROM user_rewards ORDER BY id
    `),
    ledgerTransactions: await source.query(`
      SELECT id, user_id, type::text, currency::text, amount::text, balance_after::text,
        reference_type, reference_id, metadata, created_at
      FROM ledger_transactions ORDER BY id
    `),
  };
}

void main();
