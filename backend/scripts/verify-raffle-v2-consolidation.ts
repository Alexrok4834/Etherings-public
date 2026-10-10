import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  RAFFLE_V2_CONSOLIDATION_MANIFEST,
  RaffleV2ManifestReward,
  validateRaffleV2ConsolidationManifest,
} from '../src/raffle/raffle-v2-consolidation-manifest';
import { CreateRaffleV2SingletonSchema1787616000000 } from '../src/migrations/1787616000000-create-raffle-v2-singleton-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');
if (process.env.RAFFLE_V2_CONSOLIDATION_QA_CONFIRM !== 'disposable') {
  throw new Error('RAFFLE_V2_CONSOLIDATION_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'raffle-v2-consolidation-qa-secret-not-production';
process.env.MOBILE_AUTH_ENABLED = 'false';
process.env.MOBILE_REGISTRATION_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';

const migration = new CreateRaffleV2SingletonSchema1787616000000();
let dataSource: DataSource | undefined;

async function main() {
  const { AppModule } = await import('../dist/app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    dataSource = app.get(DataSource);
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await replaceSynchronizedSingletonWithMigrationSchema(runner);
      const fixture = await seedLegacyFixture(runner);
      const manifest = validateRaffleV2ConsolidationManifest(RAFFLE_V2_CONSOLIDATION_MANIFEST);
      const before = await stateFingerprint(runner);
      const activeLegacyPools = await activeLegacyPoolCount(runner.manager);
      assert.equal(activeLegacyPools, 3, 'fixture must prove multiple active legacy pools');

      await runner.startTransaction('SERIALIZABLE');
      try {
        const result = await consolidate(runner.manager, fixture.creatorId, manifest.rewards);
        assert.equal(result.detectedActiveLegacyPools, 3);
        await assertConsolidatedState(runner, result.configurationId);
        assert.deepEqual(await historyFingerprint(runner), before.history);
      } finally {
        await runner.rollbackTransaction();
      }

      assert.deepEqual(await stateFingerprint(runner), before);
      console.log(JSON.stringify({
        database: databaseName,
        multipleActiveLegacyPoolsDetected: activeLegacyPools,
        approvedRewardsCreated: 9,
        singletonActivatedInsideTransaction: true,
        supersededPoolsDisabledInsideTransaction: true,
        legacyHistoryUnchangedInsideTransaction: true,
        fullPreStateRestoredAfterRollback: true,
      }, null, 2));
    } finally {
      await runner.release();
    }
  } finally {
    if (dataSource?.isInitialized) await dataSource.dropDatabase();
    await app.close();
  }
}

async function replaceSynchronizedSingletonWithMigrationSchema(runner: QueryRunner) {
  await runner.query('DROP TABLE IF EXISTS raffle_configuration_rewards CASCADE');
  await runner.query('DROP TABLE IF EXISTS raffle_configurations CASCADE');
  await runner.query('DROP TABLE IF EXISTS raffle_machines CASCADE');
  await migration.up(runner);
}

async function seedLegacyFixture(runner: QueryRunner) {
  const creatorId = randomUUID();
  const rewardId = randomUUID();
  await runner.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin)
    VALUES ($1, $2, 'raffle_v2_consolidation_qa', 'Raffle v2 QA', true)
  `, [creatorId, `raffle-v2-consolidation-qa:${creatorId}`]);
  await runner.query(`
    INSERT INTO rewards (id, code, title, type, amount, is_active)
    VALUES ($1, 'legacy-ert-qa', 'Legacy 1 ERT', 'ERT', 1, true)
  `, [rewardId]);

  const poolIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, poolId] of poolIds.entries()) {
    await runner.query(`
      INSERT INTO raffle_pools (id, code, title, cost_ert, is_active, daily_user_attempt_limit)
      VALUES ($1, $2, $3, 5, true, 5)
    `, [poolId, `legacy-pool-qa-${index + 1}`, `Legacy Pool ${index + 1}`]);
    await runner.query(`
      INSERT INTO raffle_pool_rewards (pool_id, reward_id, weight, is_active)
      VALUES ($1, $2, 100, true)
    `, [poolId, rewardId]);
  }

  const drawId = randomUUID();
  await runner.query(`
    INSERT INTO raffle_draws (
      id, user_id, pool_id, reward_id, cost_ert, random_roll, weights_snapshot, reward_snapshot
    ) VALUES ($1, $2, $3, $4, 5, 0.25, $5::jsonb, $6::jsonb)
  `, [drawId, creatorId, poolIds[0], rewardId, JSON.stringify([{ rewardId, weight: 100 }]),
    JSON.stringify({ rewardId, type: 'ERT', amount: 1 })]);
  await runner.query(`
    INSERT INTO user_rewards (
      user_id, reward_id, raffle_draw_id, title, type, amount, metadata
    ) VALUES ($1, $2, $3, 'Legacy 1 ERT', 'ERT', 1, $4::jsonb)
  `, [creatorId, rewardId, drawId, JSON.stringify({ fixture: true })]);
  return { creatorId };
}

async function consolidate(manager: EntityManager, creatorId: string, rewards: readonly RaffleV2ManifestReward[]) {
  const detectedActiveLegacyPools = await activeLegacyPoolCount(manager);
  if (detectedActiveLegacyPools < 2) throw new Error('Expected approved multi-pool source state');
  const [{ existingMachineCount }] = await manager.query(`
    SELECT count(*)::int AS "existingMachineCount" FROM raffle_machines
  `);
  const [{ existingConfigurationCount }] = await manager.query(`
    SELECT count(*)::int AS "existingConfigurationCount" FROM raffle_configurations
  `);
  if (existingMachineCount !== 0 || existingConfigurationCount !== 0) {
    throw new Error('Raffle v2 target state is not empty');
  }

  const machineId = randomUUID();
  const configurationId = randomUUID();
  await manager.query(`
    INSERT INTO raffle_machines (singleton_key, id, code) VALUES (1, $1, $2)
  `, [machineId, RAFFLE_V2_CONSOLIDATION_MANIFEST.machineCode]);
  await manager.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, description, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8)
  `, [
    configurationId,
    machineId,
    RAFFLE_V2_CONSOLIDATION_MANIFEST.contractVersion,
    RAFFLE_V2_CONSOLIDATION_MANIFEST.title,
    RAFFLE_V2_CONSOLIDATION_MANIFEST.description,
    RAFFLE_V2_CONSOLIDATION_MANIFEST.costErtExact,
    RAFFLE_V2_CONSOLIDATION_MANIFEST.dailyUserAttemptLimit,
    creatorId,
  ]);

  for (const manifestReward of rewards) {
    const rewardId = randomUUID();
    await manager.query(`
      INSERT INTO rewards (
        id, code, title, type, amount, amount_exact, is_active,
        stock_total, stock_remaining, per_user_limit, daily_global_limit
      ) VALUES ($1, $2, $3, $4, $5, $6, true, NULL, NULL, NULL, NULL)
    `, [
      rewardId,
      manifestReward.code,
      manifestReward.title,
      manifestReward.type,
      manifestReward.type === 'ERT' ? manifestReward.amountExact : null,
      manifestReward.type === 'ERU' ? manifestReward.amountExact : null,
    ]);
    await manager.query(`
      INSERT INTO raffle_configuration_rewards (
        configuration_id, reward_id, segment_index, weight, reward_snapshot
      ) VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [configurationId, rewardId, manifestReward.segmentIndex, manifestReward.weight,
      JSON.stringify(snapshot(rewardId, manifestReward))]);
  }

  await manager.query(`UPDATE raffle_pools SET is_active = false WHERE is_active = true`);
  await manager.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
  return { configurationId, detectedActiveLegacyPools };
}

function snapshot(rewardId: string, reward: RaffleV2ManifestReward) {
  return {
    rewardId,
    code: reward.code,
    title: reward.title,
    type: reward.type,
    segmentIndex: reward.segmentIndex,
    weight: String(reward.weight),
    probability: { numerator: String(reward.weight), denominator: '100' },
    imageUrl: null,
    amountExact: reward.amountExact,
    ...(reward.type === 'COPPER_RING' ? {
      asset: { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 },
    } : {}),
  };
}

async function assertConsolidatedState(runner: QueryRunner, configurationId: string) {
  const [state] = await runner.query(`
    SELECT
      (SELECT count(*)::int FROM raffle_pools WHERE is_active) AS "activeLegacyPools",
      (SELECT count(*)::int FROM raffle_configurations WHERE status = 'ACTIVE') AS "activeConfigurations",
      (SELECT count(*)::int FROM raffle_configuration_rewards WHERE configuration_id = $1) AS "mappingCount",
      (SELECT sum(weight)::int FROM raffle_configuration_rewards WHERE configuration_id = $1) AS "totalWeight",
      (SELECT count(*)::int FROM rewards WHERE code LIKE 'raffle-v2-%-v1') AS "targetRewardCount"
  `, [configurationId]);
  assert.deepEqual(state, {
    activeLegacyPools: 0,
    activeConfigurations: 1,
    mappingCount: 9,
    totalWeight: 100,
    targetRewardCount: 9,
  });
}

async function activeLegacyPoolCount(manager: EntityManager) {
  const [{ count }] = await manager.query(`SELECT count(*)::int AS count FROM raffle_pools WHERE is_active`);
  return count as number;
}

async function stateFingerprint(runner: QueryRunner) {
  const tables = [
    'raffle_pools',
    'raffle_pool_rewards',
    'rewards',
    'raffle_machines',
    'raffle_configurations',
    'raffle_configuration_rewards',
  ];
  const state: Record<string, unknown> = {};
  for (const table of tables) state[table] = await runner.query(`SELECT * FROM ${table} ORDER BY 1`);
  return { state, history: await historyFingerprint(runner) };
}

async function historyFingerprint(runner: QueryRunner) {
  return {
    raffleDraws: await runner.query('SELECT * FROM raffle_draws ORDER BY id'),
    userRewards: await runner.query('SELECT * FROM user_rewards ORDER BY id'),
    ledgerTransactions: await runner.query('SELECT * FROM ledger_transactions ORDER BY id'),
  };
}

void main();
