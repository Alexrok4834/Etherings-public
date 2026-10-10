import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const expectedMigrations = [
  'CreateStepSyncSchema1786406400000',
  'CreateMobileRefreshTokens1786492800000',
  'CreateMobileCredentials1786665600000',
  'CreateCopperRingSchema1787097600000',
  'CreateCopperLevelUpSchema1787184000000',
  'CreateCopperDeferredAllocationSchema1787270400000',
  'CreateM2eAccountingSchema1787356800000',
  'CreateEruAccountingSchema1787443200000',
  'AddEruRaffleRewards1787529600000',
  'CreateRaffleV2SingletonSchema1787616000000',
  'CreateRaffleV2DrawEvidenceSchema1787702400000',
  'CreateRaffleCopperAwardSchema1787788800000',
  'CreateRingEquipmentOperationSchema1787875200000',
  'ProtectActiveRaffleV2Rewards1787961600000',
  'CreateRaffleV2ActivationOperationSchema1788048000000',
  'CreateRaffleV2AvailabilityOperationSchema1788134400000',
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^raffle_v2_prod_restore(?:_[a-z0-9]+)*_qa$/.test(databaseName)) {
  throw new Error('Refusing to inspect a database outside the approved restored-copy name');
}
const backupSha256 = process.env.RAFFLE_V2_BACKUP_SHA256;
if (!backupSha256 || !/^[A-F0-9]{64}$/.test(backupSha256)) {
  throw new Error('RAFFLE_V2_BACKUP_SHA256 must be an uppercase SHA-256');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'false';
process.env.JWT_SECRET = 'raffle-v2-restored-copy-read-only-not-production';
process.env.MOBILE_AUTH_ENABLED = 'false';
process.env.MOBILE_REGISTRATION_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

let app: INestApplicationContext | undefined;

async function main() {
  const [
    { AppModule },
    { RaffleV2ReadService },
    { RaffleV2LegacyCompatibilityService },
  ] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/raffle/raffle-v2-read.service.js'),
    import('../dist/raffle/raffle-v2-legacy-compatibility.service.js'),
  ]);
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const dataSource = app.get(DataSource);
    const reads = app.get(RaffleV2ReadService);
    const compatibility = app.get(RaffleV2LegacyCompatibilityService);
    const [{ transactionReadOnly }] = await dataSource.query(
      `SELECT current_setting('transaction_read_only') AS "transactionReadOnly"`,
    );
    assert.equal(transactionReadOnly, 'on');

    const migrations = await dataSource.query(
      'SELECT name FROM migrations ORDER BY timestamp, name',
    ) as Array<{ name: string }>;
    assert.deepEqual(migrations.map(({ name }) => name), expectedMigrations);

    const [configuration] = await dataSource.query(`
      SELECT machine.id AS "machineId", configuration.id AS "configurationId",
        machine.is_available AS "available", configuration.cost_ert = 5 AS "costMatches",
        configuration.daily_user_attempt_limit AS "attemptLimit",
        count(mapping.reward_id)::int AS "outcomes", sum(mapping.weight)::int AS "totalWeight"
      FROM raffle_machines machine
      JOIN raffle_configurations configuration
        ON configuration.machine_id = machine.id AND configuration.status = 'ACTIVE'
      JOIN raffle_configuration_rewards mapping ON mapping.configuration_id = configuration.id
      WHERE machine.singleton_key = 1
      GROUP BY machine.id, machine.is_available, configuration.id,
        configuration.cost_ert, configuration.daily_user_attempt_limit
    `) as Array<Record<string, unknown>>;
    assert.deepEqual(configuration, {
      machineId: configuration.machineId,
      configurationId: configuration.configurationId,
      available: true,
      costMatches: true,
      attemptLimit: 5,
      outcomes: 9,
      totalWeight: 100,
    });
    const [{ activeLegacyPools }] = await dataSource.query(
      'SELECT count(*)::int AS "activeLegacyPools" FROM raffle_pools WHERE is_active',
    );
    assert.equal(activeLegacyPools, 0);

    const before = await databaseFingerprint(dataSource);
    const pools = await compatibility.listPools();
    assert.equal(pools.length, 1);
    assert.equal(pools[0].id, configuration.machineId);
    assert.equal(pools[0].costErtExact, '5');
    assert.equal(pools[0].dailyUserAttemptLimit, 5);
    assert.equal(pools[0].rewards.length, 9);
    assert.equal(pools[0].rewards.reduce((sum, reward) => sum + reward.weight, 0), 100);

    const owners = await dataSource.query(`
      SELECT DISTINCT owner_id AS id FROM (
        SELECT user_id AS owner_id FROM raffle_draws
        UNION ALL
        SELECT owner_user_id AS owner_id FROM raffle_draw_results_v2
      ) history_owners
      ORDER BY owner_id
    `) as Array<{ id: string }>;
    let mergedItemsChecked = 0;
    let v2ItemsChecked = 0;
    for (const owner of owners) {
      const expectedLegacy = await dataSource.query(
        'SELECT id FROM raffle_draws WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [owner.id],
      ) as Array<{ id: string }>;
      const expectedV2 = await dataSource.query(`
        SELECT result.id FROM raffle_draw_results_v2 result
        JOIN raffle_draw_operations operation ON operation.id = result.operation_id
        WHERE result.owner_user_id = $1 AND operation.owner_user_id = $1
          AND operation.status = 'COMPLETED' AND operation.response_snapshot IS NOT NULL
        ORDER BY result.created_at DESC, result.id DESC
      `, [owner.id]) as Array<{ id: string }>;
      assert.ok(expectedLegacy.length + expectedV2.length <= 50, 'restored-copy history exceeds compatibility page');

      const v2 = await reads.getHistory(owner.id, { limit: '50' });
      const v2Items = requireArray(v2.items);
      assert.deepEqual(
        v2Items.map((item) => requireObject(requireObject(item).draw).drawResultId),
        expectedV2.map(({ id }) => id),
      );
      const merged = await compatibility.listHistory({ id: owner.id } as never);
      const actualMergedIds = merged.map((item) => String((item.draw as { id: string }).id)).sort();
      const expectedMergedIds = [...expectedLegacy, ...expectedV2].map(({ id }) => id).sort();
      assert.deepEqual(actualMergedIds, expectedMergedIds);
      v2ItemsChecked += v2Items.length;
      mergedItemsChecked += merged.length;
    }
    const after = await databaseFingerprint(dataSource);
    assert.deepEqual(after, before);

    console.log(JSON.stringify({
      restoredProductionCopy: true,
      backupSha256,
      transactionReadOnly: true,
      migrationsApplied: migrations.length,
      singletonConfigurationValid: true,
      legacyPoolAdapterValid: true,
      historyOwnersChecked: owners.length,
      v2HistoryItemsChecked: v2ItemsChecked,
      crossVersionHistoryItemsChecked: mergedItemsChecked,
      protectedTableCount: before.tableCount,
      protectedStateFingerprintUnchanged: true,
    }, null, 2));
  } finally {
    await app.close();
  }
}

async function databaseFingerprint(dataSource: DataSource) {
  const tables = await dataSource.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  const tableDigests: string[] = [];
  for (const { table_name: tableName } of tables) {
    const identifier = `"${tableName.replaceAll('"', '""')}"`;
    const [row] = await dataSource.query(`
      SELECT count(*)::text AS count,
        coalesce(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM ${identifier} t
    `) as Array<{ count: string; digest: string }>;
    tableDigests.push(`${tableName}:${row.count}:${row.digest}`);
  }
  return {
    tableCount: tables.length,
    digest: createHash('sha256').update(tableDigests.join('\n')).digest('hex'),
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

void main();
