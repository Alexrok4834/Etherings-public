import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RafflePoolReward } from './raffle-pool-reward.entity';
import { Reward, RewardType } from './reward.entity';
import { RaffleSelectionService } from './raffle-selection.service';

function reward(overrides: Partial<Reward> = {}): Reward {
  return {
    id: 'reward-1',
    code: 'coins',
    title: 'Coins',
    description: null,
    type: RewardType.Ert,
    amount: 10,
    metadata: null,
    imageUrl: null,
    isActive: true,
    stockTotal: null,
    stockRemaining: null,
    perUserLimit: null,
    dailyGlobalLimit: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as Reward;
}

function poolReward(overrides: Partial<RafflePoolReward> = {}): RafflePoolReward {
  return {
    id: 'pool-reward-1',
    poolId: 'pool-1',
    rewardId: 'reward-1',
    reward: reward(),
    weight: 10,
    isActive: true,
    startsAt: null,
    endsAt: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as RafflePoolReward;
}

describe('RaffleSelectionService', () => {
  it('selects by deterministic weighted ranges', () => {
    const service = new RaffleSelectionService();
    const rewards = [
      poolReward({ id: 'a', rewardId: 'a', reward: reward({ id: 'a', code: 'a' }), weight: 10 }),
      poolReward({ id: 'b', rewardId: 'b', reward: reward({ id: 'b', code: 'b' }), weight: 30 }),
      poolReward({ id: 'c', rewardId: 'c', reward: reward({ id: 'c', code: 'c' }), weight: 60 }),
    ];

    assert.equal(service.selectWeighted(rewards, 0).selected.id, 'a');
    assert.equal(service.selectWeighted(rewards, 0.099).selected.id, 'a');
    assert.equal(service.selectWeighted(rewards, 0.1).selected.id, 'b');
    assert.equal(service.selectWeighted(rewards, 0.399).selected.id, 'b');
    assert.equal(service.selectWeighted(rewards, 0.4).selected.id, 'c');
    assert.equal(service.selectWeighted(rewards, 0.999999).selected.id, 'c');
  });

  it('uses the same persisted weight ranges for ERU as every existing reward type', () => {
    const service = new RaffleSelectionService();
    const rewards = [
      poolReward({ id: 'ert', rewardId: 'ert', reward: reward({ id: 'ert', type: RewardType.Ert }), weight: 3 }),
      poolReward({ id: 'eru', rewardId: 'eru', reward: reward({ id: 'eru', type: RewardType.Eru, amount: null, amountExactValue: '30' }), weight: 1 }),
    ];

    assert.equal(service.selectWeighted(rewards, 0.749).selected.id, 'ert');
    assert.equal(service.selectWeighted(rewards, 0.75).selected.id, 'eru');
  });

  it('excludes inactive, expired, future, zero-weight, and out-of-stock rewards', () => {
    const service = new RaffleSelectionService();
    const now = new Date('2026-06-20T12:00:00.000Z');
    const rewards = [
      poolReward({ id: 'visible', rewardId: 'visible', reward: reward({ id: 'visible', code: 'visible' }), weight: 5 }),
      poolReward({ id: 'inactive-link', rewardId: 'inactive-link', reward: reward({ id: 'inactive-link' }), isActive: false }),
      poolReward({ id: 'inactive-reward', rewardId: 'inactive-reward', reward: reward({ id: 'inactive-reward', isActive: false }) }),
      poolReward({ id: 'zero-weight', rewardId: 'zero-weight', reward: reward({ id: 'zero-weight' }), weight: 0 }),
      poolReward({ id: 'out-of-stock', rewardId: 'out-of-stock', reward: reward({ id: 'out-of-stock', stockRemaining: 0 }) }),
      poolReward({ id: 'future', rewardId: 'future', reward: reward({ id: 'future' }), startsAt: new Date('2026-06-21T00:00:00.000Z') }),
      poolReward({ id: 'expired', rewardId: 'expired', reward: reward({ id: 'expired' }), endsAt: new Date('2026-06-20T11:00:00.000Z') }),
    ];

    const eligibleRewards = service.getEligiblePoolRewards(rewards, now);

    assert.deepEqual(eligibleRewards.map((item) => item.id), ['visible']);
    assert.equal(service.selectWeighted(rewards, 0.5, now).selected.id, 'visible');
  });

  it('throws when active weight sum is zero', () => {
    const service = new RaffleSelectionService();

    assert.throws(
      () => service.selectWeighted([
        poolReward({ id: 'zero', weight: 0 }),
        poolReward({ id: 'inactive', isActive: false }),
      ], 0.5),
      BadRequestException,
    );
  });

  it('clamps random rolls outside the expected range', () => {
    const service = new RaffleSelectionService();
    const rewards = [
      poolReward({ id: 'a', rewardId: 'a', reward: reward({ id: 'a' }), weight: 1 }),
      poolReward({ id: 'b', rewardId: 'b', reward: reward({ id: 'b' }), weight: 1 }),
    ];

    assert.equal(service.selectWeighted(rewards, -1).selected.id, 'a');
    assert.equal(service.selectWeighted(rewards, 1).selected.id, 'b');
  });
});
