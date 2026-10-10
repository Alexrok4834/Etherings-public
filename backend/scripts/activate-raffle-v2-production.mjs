import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import dataSourceModule from '/app/dist/database/data-source.js';
import {
  applyRaffleV2Consolidation,
  discoverRaffleV2LegacySource,
} from '/app/dist/raffle/raffle-v2-consolidation.js';
import {
  RAFFLE_V2_CONSOLIDATION_MANIFEST,
} from '/app/dist/raffle/raffle-v2-consolidation-manifest.js';

const mode = process.env.RAFFLE_V2_ACTIVATION_MODE;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const backupSha256 = requireSha256('RAFFLE_V2_BACKUP_SHA256');
const dataSource = dataSourceModule.default;
if (typeof dataSource?.initialize !== 'function') throw new Error('Compiled DataSource export is invalid');

if (mode === 'preflight') {
  requireExact('RAFFLE_V2_ACTIVATION_CONFIRM', 'preflight-production-singleton-v1');
  requireExactDatabase(databaseName, 'etherings_mvp');
} else if (mode === 'commit') {
  requireExact('RAFFLE_V2_ACTIVATION_CONFIRM', 'activate-production-singleton-v1');
  requireExactDatabase(databaseName, 'etherings_mvp');
} else {
  throw new Error('RAFFLE_V2_ACTIVATION_MODE must be preflight or commit');
}

await dataSource.initialize();
const runner = dataSource.createQueryRunner();
await runner.connect();

try {
  await runner.startTransaction('SERIALIZABLE');
  try {
    await runner.query(`SET LOCAL lock_timeout = '10s'`);
    await runner.query(`SET LOCAL statement_timeout = '30s'`);
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext('etherings:raffle-v2:activation'))`);
    await runner.query(`LOCK TABLE users IN SHARE MODE`);
    await runner.query(`LOCK TABLE raffle_pools, raffle_pool_rewards, rewards IN EXCLUSIVE MODE`);
    await runner.query(`
      LOCK TABLE raffle_machines, raffle_configurations, raffle_configuration_rewards IN EXCLUSIVE MODE
    `);

    const source = await activationSource(runner.manager);
    const sourceFingerprint = sha256(source);
    const legacyPoolIds = [...new Set(source.legacy.mappings.map((mapping) => mapping.poolId))].sort();
    const safePreState = {
      migrationCount: source.legacy.migrations.length,
      activeLegacyPoolCount: legacyPoolIds.length,
      machineCount: source.guards.machineCount,
      configurationCount: source.guards.configurationCount,
      targetCodeConflicts: source.guards.targetCodeConflicts,
      adminCount: source.guards.adminCount,
    };

    assert.deepEqual(safePreState, {
      migrationCount: 13,
      activeLegacyPoolCount: 2,
      machineCount: 0,
      configurationCount: 0,
      targetCodeConflicts: 0,
      adminCount: 1,
    });

    if (mode === 'preflight') {
      await runner.rollbackTransaction();
      console.log(JSON.stringify({
        mode,
        backupSha256,
        sourceFingerprint,
        safePreState,
        legacyPoolIdentityHash: sha256(legacyPoolIds),
        committed: false,
      }));
    } else {
      const expectedSourceFingerprint = requireSha256('RAFFLE_V2_EXPECTED_SOURCE_FINGERPRINT');
      assert.equal(sourceFingerprint, expectedSourceFingerprint, 'activation source drift');
      const historyBefore = await historyCounts(runner.manager);
      const result = await applyRaffleV2Consolidation(runner.manager, {
        creatorId: source.guards.creatorId,
        expectedActiveLegacyPools: 2,
      });
      const [state] = await runner.query(`
        SELECT
          (SELECT count(*)::int FROM raffle_pools WHERE is_active) AS "activeLegacyPools",
          (SELECT count(*)::int FROM raffle_machines) AS machines,
          (SELECT count(*)::int FROM raffle_configurations WHERE status = 'ACTIVE') AS "activeConfigurations",
          (SELECT count(*)::int FROM raffle_configuration_rewards
            WHERE configuration_id = $1) AS "mappingCount",
          (SELECT sum(weight)::int FROM raffle_configuration_rewards
            WHERE configuration_id = $1) AS "totalWeight",
          (SELECT count(*)::int FROM rewards WHERE code = ANY($2::varchar[])) AS "targetRewardCount"
      `, [result.configurationId, RAFFLE_V2_CONSOLIDATION_MANIFEST.rewards.map((reward) => reward.code)]);
      assert.deepEqual(state, {
        activeLegacyPools: 0,
        machines: 1,
        activeConfigurations: 1,
        mappingCount: 9,
        totalWeight: 100,
        targetRewardCount: 9,
      });
      assert.deepEqual(await historyCounts(runner.manager), historyBefore, 'legacy history changed');
      await runner.commitTransaction();
      console.log(JSON.stringify({
        mode,
        backupSha256,
        sourceFingerprint,
        safePreState,
        legacyPoolIdentityHash: sha256(legacyPoolIds),
        rollbackLegacyPoolIds: legacyPoolIds,
        state,
        historyUnchanged: true,
        committed: true,
      }));
    }
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  }
} finally {
  await runner.release();
  await dataSource.destroy();
}

async function activationSource(manager) {
  const legacy = await discoverRaffleV2LegacySource(manager);
  const [guards] = await manager.query(`
    SELECT
      (SELECT count(*)::int FROM raffle_machines) AS "machineCount",
      (SELECT count(*)::int FROM raffle_configurations) AS "configurationCount",
      (SELECT count(*)::int FROM rewards WHERE code = ANY($1::varchar[])) AS "targetCodeConflicts",
      (SELECT count(*)::int FROM users WHERE is_admin) AS "adminCount",
      (SELECT min(id::text) FROM users WHERE is_admin) AS "creatorId"
  `, [RAFFLE_V2_CONSOLIDATION_MANIFEST.rewards.map((reward) => reward.code)]);
  return { legacy, guards };
}

async function historyCounts(manager) {
  const [counts] = await manager.query(`
    SELECT
      (SELECT count(*)::int FROM raffle_draws) AS "raffleDraws",
      (SELECT count(*)::int FROM user_rewards) AS "userRewards",
      (SELECT count(*)::int FROM ledger_transactions) AS "ledgerTransactions"
  `);
  return counts;
}

function requireExact(name, expected) {
  if (process.env[name] !== expected) throw new Error(`${name} must equal ${expected}`);
}

function requireExactDatabase(actual, expected) {
  if (actual !== expected) throw new Error(`Refusing activation for database ${actual}`);
}

function requireSha256(name) {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
