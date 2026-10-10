import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { RaffleDraw } from './raffle-draw.entity';
import { RaffleDrawOperation, RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleRingAward, RAFFLE_COPPER_FULFILLMENT_VERSION } from './raffle-ring-award.entity';
import { RafflePoolReward } from './raffle-pool-reward.entity';
import { RafflePool } from './raffle-pool.entity';
import { Reward, RewardType } from './reward.entity';
import { UserReward } from './user-reward.entity';

function tableFor(target: Function) {
  return getMetadataArgsStorage().tables.find((table) => table.target === target);
}

function databaseColumnNamesFor(target: Function) {
  return getMetadataArgsStorage()
    .columns
    .filter((column) => column.target === target)
    .map((column) => column.options.name ?? column.propertyName)
    .sort();
}

function columnFor(target: Function, name: string) {
  return getMetadataArgsStorage().columns.find((column) => column.target === target
    && (column.options.name ?? column.propertyName) === name);
}

function indexFor(target: Function, properties: string[]) {
  return getMetadataArgsStorage().indices.find((index) => {
    const columns = Array.isArray(index.columns) ? index.columns : [];
    return index.target === target && JSON.stringify(columns) === JSON.stringify(properties);
  });
}

function checkNamesFor(target: Function) {
  return getMetadataArgsStorage().checks
    .filter((check) => check.target === target)
    .map((check) => check.name)
    .sort();
}

function uniqueNamesFor(target: Function) {
  return getMetadataArgsStorage().uniques
    .filter((unique) => unique.target === target)
    .map((unique) => unique.name)
    .sort();
}

describe('raffle schema', () => {
  it('maps Reward to rewards with all MVP fields', () => {
    assert.equal(tableFor(Reward)?.name, 'rewards');
    assert.deepEqual(databaseColumnNamesFor(Reward), [
      'amount',
      'amount_exact',
      'code',
      'created_at',
      'daily_global_limit',
      'description',
      'id',
      'image_url',
      'is_active',
      'metadata',
      'per_user_limit',
      'stock_remaining',
      'stock_total',
      'title',
      'type',
      'updated_at',
    ].sort());
  });

  it('defines all MVP reward types', () => {
    assert.deepEqual(
      Object.values(RewardType).sort(),
      ['BADGE', 'COPPER_RING', 'ERT', 'ERU', 'ITEM', 'NFT_PLACEHOLDER'].sort(),
    );
  });

  it('stores authoritative raffle ERU values as exact scale-18 decimals', () => {
    for (const [target, name] of [
      [Reward, 'amount_exact'],
      [UserReward, 'amount_exact'],
      [UserReward, 'eru_balance_after'],
    ] as const) {
      const column = columnFor(target, name);
      assert.equal(column?.options.precision, 48, name);
      assert.equal(column?.options.scale, 18, name);
    }
    const rewardCheck = getMetadataArgsStorage().checks.find((check) => check.target === Reward
      && check.name === 'CHK_rewards_eru_amount_exact');
    assert.ok(!String(rewardCheck?.expression).includes('trunc'));
  });

  it('maps RafflePool to raffle_pools with cost and attempt limit', () => {
    assert.equal(tableFor(RafflePool)?.name, 'raffle_pools');
    assert.deepEqual(databaseColumnNamesFor(RafflePool), [
      'code',
      'cost_ert',
      'created_at',
      'daily_user_attempt_limit',
      'description',
      'id',
      'is_active',
      'title',
      'updated_at',
    ].sort());
  });

  it('maps RafflePoolReward to raffle_pool_rewards with unique pool/reward index', () => {
    assert.equal(tableFor(RafflePoolReward)?.name, 'raffle_pool_rewards');
    assert.deepEqual(databaseColumnNamesFor(RafflePoolReward), [
      'created_at',
      'ends_at',
      'id',
      'is_active',
      'pool_id',
      'reward_id',
      'starts_at',
      'updated_at',
      'weight',
    ].sort());
    assert.equal(indexFor(RafflePoolReward, ['poolId', 'rewardId'])?.unique, true);
  });

  it('maps RaffleDraw to raffle_draws with snapshots', () => {
    assert.equal(tableFor(RaffleDraw)?.name, 'raffle_draws');
    assert.deepEqual(databaseColumnNamesFor(RaffleDraw), [
      'cost_ert',
      'created_at',
      'id',
      'pool_id',
      'random_roll',
      'reward_id',
      'reward_snapshot',
      'user_id',
      'weights_snapshot',
    ].sort());
    assert.ok(indexFor(RaffleDraw, ['userId', 'createdAt']));
  });

  it('maps UserReward to user_rewards with draw reference', () => {
    assert.equal(tableFor(UserReward)?.name, 'user_rewards');
    assert.deepEqual(databaseColumnNamesFor(UserReward), [
      'amount',
      'amount_exact',
      'created_at',
      'eru_balance_after',
      'id',
      'metadata',
      'raffle_draw_id',
      'raffle_draw_result_v2_id',
      'reward_id',
      'title',
      'type',
      'user_id',
    ].sort());
    assert.ok(indexFor(UserReward, ['userId', 'createdAt']));
    assert.equal(indexFor(UserReward, ['raffleDrawResultV2Id'])?.unique, true);
    assert.deepEqual(checkNamesFor(UserReward), [
      'CHK_user_rewards_copper_ring_shape',
      'CHK_user_rewards_eru_amount_exact',
      'CHK_user_rewards_eru_balance_after',
      'CHK_user_rewards_source',
    ]);
  });

  it('maps the v2 singleton machine and immutable configuration identity', () => {
    assert.equal(tableFor(RaffleMachine)?.name, 'raffle_machines');
    assert.equal(tableFor(RaffleConfiguration)?.name, 'raffle_configurations');
    assert.deepEqual(databaseColumnNamesFor(RaffleMachine), [
      'code',
      'created_at',
      'id',
      'is_available',
      'paused_at',
      'singleton_key',
    ]);
    assert.deepEqual(databaseColumnNamesFor(RaffleConfiguration), [
      'activated_at',
      'contract_version',
      'cost_ert',
      'created_at',
      'created_by_user_id',
      'daily_user_attempt_limit',
      'description',
      'disabled_at',
      'id',
      'machine_id',
      'status',
      'title',
    ]);
    assert.deepEqual(Object.values(RaffleConfigurationStatus), ['DRAFT', 'ACTIVE', 'DISABLED']);
    assert.deepEqual(checkNamesFor(RaffleMachine), [
      'CHK_raffle_machines_availability',
      'CHK_raffle_machines_code',
      'CHK_raffle_machines_singleton',
    ]);
    assert.deepEqual(checkNamesFor(RaffleConfiguration), [
      'CHK_raffle_configurations_attempt_limit',
      'CHK_raffle_configurations_contract',
      'CHK_raffle_configurations_cost',
      'CHK_raffle_configurations_lifecycle_timestamps',
      'CHK_raffle_configurations_status',
      'CHK_raffle_configurations_title',
    ]);
    assert.equal(indexFor(RaffleConfiguration, ['machineId'])?.unique, true);
  });

  it('maps ordered v2 reward segments with immutable snapshots', () => {
    assert.equal(tableFor(RaffleConfigurationReward)?.name, 'raffle_configuration_rewards');
    assert.deepEqual(databaseColumnNamesFor(RaffleConfigurationReward), [
      'configuration_id',
      'created_at',
      'reward_id',
      'reward_snapshot',
      'segment_index',
      'weight',
    ]);
    assert.deepEqual(uniqueNamesFor(RaffleConfigurationReward), [
      'UQ_raffle_configuration_rewards_segment',
    ]);
    assert.deepEqual(checkNamesFor(RaffleConfigurationReward), [
      'CHK_raffle_configuration_rewards_segment',
      'CHK_raffle_configuration_rewards_snapshot',
      'CHK_raffle_configuration_rewards_weight',
    ]);
  });

  it('maps owner-scoped v2 draw operations with guarded completion snapshots', () => {
    assert.equal(tableFor(RaffleDrawOperation)?.name, 'raffle_draw_operations');
    assert.deepEqual(databaseColumnNamesFor(RaffleDrawOperation), [
      'completed_at',
      'configuration_id',
      'contract_version',
      'created_at',
      'id',
      'idempotency_key',
      'owner_user_id',
      'request_fingerprint',
      'response_snapshot',
      'status',
      'updated_at',
    ]);
    assert.deepEqual(Object.values(RaffleDrawOperationStatus), ['PENDING', 'COMPLETED']);
    assert.equal(indexFor(RaffleDrawOperation, ['ownerUserId', 'idempotencyKey'])?.unique, true);
    assert.deepEqual(checkNamesFor(RaffleDrawOperation), [
      'CHK_raffle_draw_operations_contract',
      'CHK_raffle_draw_operations_fingerprint',
      'CHK_raffle_draw_operations_idempotency_v4',
      'CHK_raffle_draw_operations_lifecycle',
      'CHK_raffle_draw_operations_status',
      'CHK_raffle_draw_operations_updated_at',
    ]);
  });

  it('maps immutable integer-ticket v2 draw result evidence', () => {
    assert.equal(tableFor(RaffleDrawResultV2)?.name, 'raffle_draw_results_v2');
    assert.deepEqual(databaseColumnNamesFor(RaffleDrawResultV2), [
      'algorithm',
      'configuration_id',
      'cost_ert',
      'created_at',
      'id',
      'machine_id',
      'operation_id',
      'owner_user_id',
      'ranges_snapshot',
      'selected_reward_id',
      'selected_segment_index',
      'ticket',
      'total_weight',
    ]);
    assert.equal(indexFor(RaffleDrawResultV2, ['operationId'])?.unique, true);
    assert.equal(indexFor(RaffleDrawResultV2, ['id', 'ownerUserId', 'selectedRewardId'])?.unique, true);
    assert.equal(
      indexFor(RaffleDrawResultV2, ['id', 'operationId', 'ownerUserId', 'selectedRewardId'])?.unique,
      true,
    );
    assert.ok(indexFor(RaffleDrawResultV2, ['ownerUserId', 'createdAt', 'id']));
    assert.deepEqual(checkNamesFor(RaffleDrawResultV2), [
      'CHK_raffle_draw_results_v2_algorithm',
      'CHK_raffle_draw_results_v2_cost',
      'CHK_raffle_draw_results_v2_ranges',
      'CHK_raffle_draw_results_v2_segment',
      'CHK_raffle_draw_results_v2_ticket',
    ]);
  });

  it('maps immutable raffle Copper award provenance', () => {
    assert.equal(tableFor(RaffleRingAward)?.name, 'raffle_ring_awards');
    assert.equal(RAFFLE_COPPER_FULFILLMENT_VERSION, 'raffle-copper-fulfillment-v1');
    assert.deepEqual(databaseColumnNamesFor(RaffleRingAward), [
      'award_utc_date',
      'created_at',
      'draw_result_id',
      'fulfillment_version',
      'id',
      'operation_id',
      'owner_user_id',
      'reward_id',
      'ring_event_id',
      'ring_id',
      'ruleset_version',
    ]);
    assert.equal(indexFor(RaffleRingAward, ['drawResultId'])?.unique, true);
    assert.equal(indexFor(RaffleRingAward, ['ringId'])?.unique, true);
    assert.equal(indexFor(RaffleRingAward, ['ringEventId'])?.unique, true);
    assert.equal(indexFor(RaffleRingAward, ['ownerUserId', 'awardUtcDate'])?.unique, true);
    assert.deepEqual(checkNamesFor(RaffleRingAward), [
      'CHK_raffle_ring_awards_fulfillment_version',
      'CHK_raffle_ring_awards_ruleset_version',
    ]);
  });
});
