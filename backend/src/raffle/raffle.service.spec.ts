import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RafflePoolReward } from './raffle-pool-reward.entity';
import { RafflePool } from './raffle-pool.entity';
import { RaffleSelectionService } from './raffle-selection.service';
import { RaffleService } from './raffle.service';
import { Reward, RewardType } from './reward.entity';

class FakeRepository<T> {
  constructor(private readonly rows: T[]) {}

  async find(_options?: unknown) {
    return this.rows;
  }
}

function pool(overrides: Partial<RafflePool> = {}): RafflePool {
  return {
    id: 'pool-1',
    code: 'daily',
    title: 'Daily Pool',
    description: 'Daily draw',
    costErt: 10,
    isActive: true,
    dailyUserAttemptLimit: 3,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as RafflePool;
}

function reward(overrides: Partial<Reward> = {}): Reward {
  return {
    id: 'reward-1',
    code: 'coins',
    title: 'Coins',
    description: 'ERT prize',
    type: RewardType.Ert,
    amount: 50,
    metadata: { tier: 'common' },
    imageUrl: 'https://example.test/coins.png',
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
    pool: pool(),
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

function createService(pools: RafflePool[], poolRewards: RafflePoolReward[]) {
  return new RaffleService(
    new FakeRepository(pools) as never,
    new FakeRepository(poolRewards) as never,
    new RaffleSelectionService(),
    {} as never,
  );
}

describe('RaffleService public pools', () => {
  it('returns active pools with visible rewards and probabilities', async () => {
    const service = createService(
      [pool(), pool({ id: 'pool-2', code: 'inactive', isActive: false })],
      [
        poolReward({ id: 'pool-reward-1', reward: reward({ id: 'reward-1', code: 'coins' }), weight: 10 }),
        poolReward({ id: 'pool-reward-2', rewardId: 'reward-2', reward: reward({ id: 'reward-2', code: 'badge', type: RewardType.Badge, amount: null }), weight: 30 }),
      ],
    );

    const pools = await service.listPublicPools(new Date('2026-06-20T12:00:00.000Z'));

    assert.equal(pools.length, 1);
    assert.equal(pools[0].code, 'daily');
    assert.equal(pools[0].costErtExact, '10');
    assert.equal(pools[0].costErtDisplay, '10.00');
    assert.equal(pools[0].rewards.length, 2);
    assert.equal(pools[0].rewards[0].amountExact, '50');
    assert.equal(pools[0].rewards[0].amountDisplay, '50.00');
    assert.equal(pools[0].rewards[1].amountExact, null);
    assert.equal(pools[0].rewards[1].amountDisplay, null);
    assert.equal(pools[0].rewards[0].probability, 0.25);
    assert.equal(pools[0].rewards[1].probability, 0.75);
  });

  it('filters inactive, zero-weight, out-of-stock, future, and expired rewards', async () => {
    const service = createService(
      [pool()],
      [
        poolReward({ id: 'visible', reward: reward({ id: 'visible', code: 'visible' }), weight: 5 }),
        poolReward({ id: 'inactive-link', rewardId: 'inactive-link', reward: reward({ id: 'inactive-link', code: 'inactive-link' }), isActive: false }),
        poolReward({ id: 'inactive-reward', rewardId: 'inactive-reward', reward: reward({ id: 'inactive-reward', code: 'inactive-reward', isActive: false }) }),
        poolReward({ id: 'zero-weight', rewardId: 'zero-weight', reward: reward({ id: 'zero-weight', code: 'zero-weight' }), weight: 0 }),
        poolReward({ id: 'out-of-stock', rewardId: 'out-of-stock', reward: reward({ id: 'out-of-stock', code: 'out-of-stock', stockRemaining: 0 }) }),
        poolReward({ id: 'future', rewardId: 'future', reward: reward({ id: 'future', code: 'future' }), startsAt: new Date('2026-06-21T00:00:00.000Z') }),
        poolReward({ id: 'expired', rewardId: 'expired', reward: reward({ id: 'expired', code: 'expired' }), endsAt: new Date('2026-06-20T11:00:00.000Z') }),
      ],
    );

    const pools = await service.listPublicPools(new Date('2026-06-20T12:00:00.000Z'));

    assert.deepEqual(pools[0].rewards.map((item) => item.code), ['visible']);
    assert.equal(pools[0].rewards[0].probability, 1);
  });

  it('returns an empty array when there are no active pools', async () => {
    const service = createService([], [poolReward()]);

    const pools = await service.listPublicPools();

    assert.deepEqual(pools, []);
  });
});
