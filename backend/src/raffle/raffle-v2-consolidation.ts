import { createHash, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  RAFFLE_V2_CONSOLIDATION_MANIFEST,
  RaffleV2ManifestReward,
  validateRaffleV2ConsolidationManifest,
} from './raffle-v2-consolidation-manifest';

export type RaffleV2LegacySource = Readonly<{
  migrations: readonly Record<string, unknown>[];
  mappings: readonly Record<string, unknown>[];
  counts: Readonly<Record<string, unknown>>;
}>;

export async function discoverRaffleV2LegacySource(manager: EntityManager): Promise<RaffleV2LegacySource> {
  const migrations = await manager.query(`
    SELECT timestamp::text AS timestamp, name FROM migrations ORDER BY timestamp
  `);
  const mappings = await manager.query(`
    SELECT
      pool.id::text AS "poolId",
      pool.code AS "poolCode",
      pool.title AS "poolTitle",
      pool.cost_ert::text AS "costErt",
      pool.daily_user_attempt_limit::text AS "dailyUserAttemptLimit",
      reward.id::text AS "rewardId",
      reward.code AS "rewardCode",
      reward.title AS "rewardTitle",
      reward.type::text AS "rewardType",
      reward.amount::text AS amount,
      reward.amount_exact::text AS "amountExact",
      mapping.weight::text AS weight,
      mapping.is_active AS "mappingActive"
    FROM raffle_pools pool
    JOIN raffle_pool_rewards mapping ON mapping.pool_id = pool.id
    JOIN rewards reward ON reward.id = mapping.reward_id
    WHERE pool.is_active
    ORDER BY pool.code, mapping.weight DESC, reward.code
  `);
  const [counts] = await manager.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM balances) AS balances,
      (SELECT count(*)::int FROM game_rings) AS rings,
      (SELECT count(*)::int FROM raffle_pools) AS "rafflePools",
      (SELECT count(*)::int FROM rewards) AS rewards,
      (SELECT count(*)::int FROM raffle_draws) AS "raffleDraws",
      (SELECT count(*)::int FROM user_rewards) AS "userRewards",
      (SELECT count(*)::int FROM ledger_transactions) AS "ledgerTransactions",
      to_regclass('public.raffle_configurations') IS NOT NULL AS "v2SchemaPresent"
  `);
  return { migrations, mappings, counts };
}

export function fingerprintRaffleV2LegacySource(source: RaffleV2LegacySource) {
  return sha256(source);
}

export async function applyRaffleV2Consolidation(
  manager: EntityManager,
  input: { creatorId: string; expectedActiveLegacyPools: number },
) {
  const manifest = validateRaffleV2ConsolidationManifest(RAFFLE_V2_CONSOLIDATION_MANIFEST);
  if (!Number.isSafeInteger(input.expectedActiveLegacyPools) || input.expectedActiveLegacyPools < 1) {
    throw new Error('Invalid expected active legacy pool count');
  }
  const [precondition] = await manager.query(`
    SELECT
      (SELECT count(*)::int FROM raffle_pools WHERE is_active) AS "activeLegacyPools",
      (SELECT count(*)::int FROM raffle_machines) AS "machineCount",
      (SELECT count(*)::int FROM raffle_configurations) AS "configurationCount",
      (SELECT count(*)::int FROM rewards WHERE code = ANY($1::varchar[])) AS "targetCodeConflicts"
  `, [manifest.rewards.map((reward) => reward.code)]);
  if (precondition.activeLegacyPools !== input.expectedActiveLegacyPools
    || precondition.machineCount !== 0
    || precondition.configurationCount !== 0
    || precondition.targetCodeConflicts !== 0) {
    throw new Error('Raffle v2 consolidation precondition mismatch');
  }

  const machineId = randomUUID();
  const configurationId = randomUUID();
  await manager.query(`
    INSERT INTO raffle_machines (singleton_key, id, code) VALUES (1, $1, $2)
  `, [machineId, manifest.machineCode]);
  await manager.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, description, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8)
  `, [
    configurationId,
    machineId,
    manifest.contractVersion,
    manifest.title,
    manifest.description,
    manifest.costErtExact,
    manifest.dailyUserAttemptLimit,
    input.creatorId,
  ]);

  for (const manifestReward of manifest.rewards) {
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
    `, [
      configurationId,
      rewardId,
      manifestReward.segmentIndex,
      manifestReward.weight,
      JSON.stringify(rewardSnapshot(rewardId, manifestReward)),
    ]);
  }

  const disabled = await manager.query(`
    UPDATE raffle_pools SET is_active = false WHERE is_active = true RETURNING id
  `);
  if (disabled.length !== input.expectedActiveLegacyPools) {
    throw new Error('Raffle v2 consolidation disabled an unexpected pool count');
  }
  await manager.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
  return { machineId, configurationId, disabledLegacyPoolCount: disabled.length };
}

function rewardSnapshot(rewardId: string, reward: RaffleV2ManifestReward) {
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

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
