import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RafflePoolReward } from '../raffle/raffle-pool-reward.entity';
import { RafflePool } from '../raffle/raffle-pool.entity';
import { Reward, RewardType } from '../raffle/reward.entity';
import { AdminRafflePoolsService } from './admin-raffle-pools.service';

class FakeRepository<T extends { id?: string; createdAt?: Date; updatedAt?: Date }> {
  nextId = 1;

  constructor(
    readonly rows: Map<string, T>,
    private readonly idPrefix: string,
  ) {}

  async find(options?: { where?: Partial<T> }) {
    let rows = Array.from(this.rows.values());

    if (options?.where) {
      rows = rows.filter((row) => {
        return Object.entries(options.where as Partial<T>).every(([key, value]) => row[key as keyof T] === value);
      });
    }

    return rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  async findOne(options: { where: Partial<T> }) {
    return Array.from(this.rows.values()).find((row) => {
      return Object.entries(options.where).every(([key, value]) => row[key as keyof T] === value);
    }) ?? null;
  }

  create(input: Partial<T>) {
    return input as T;
  }

  async save(entity: T) {
    const now = new Date('2026-06-22T00:00:00.000Z');
    const saved = {
      ...entity,
      id: entity.id ?? `${this.idPrefix}-${this.nextId++}`,
      createdAt: entity.createdAt ?? now,
      updatedAt: now,
    } as T;
    this.rows.set(saved.id as string, saved);

    return saved;
  }
}

function createService() {
  const poolRepository = new FakeRepository<RafflePool>(new Map(), 'pool');
  const poolRewardRepository = new FakeRepository<RafflePoolReward>(new Map(), 'pool-reward');
  const rewardRepository = new FakeRepository<Reward>(new Map(), 'reward');
  const service = new AdminRafflePoolsService(poolRepository as never, poolRewardRepository as never, rewardRepository as never);

  return { poolRepository, poolRewardRepository, rewardRepository, service };
}

function pool(overrides: Partial<RafflePool> = {}) {
  return {
    id: 'pool-1',
    code: 'daily',
    title: 'Daily Pool',
    description: 'Daily rewards',
    costErt: 5,
    isActive: true,
    dailyUserAttemptLimit: 3,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as RafflePool;
}

function reward(overrides: Partial<Reward> = {}) {
  return {
    id: 'reward-1',
    code: 'coins',
    title: 'Coins',
    description: 'ERT prize',
    type: RewardType.Ert,
    amount: 25,
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

function poolReward(overrides: Partial<RafflePoolReward> = {}) {
  return {
    id: 'pool-reward-1',
    poolId: 'pool-1',
    rewardId: 'reward-1',
    weight: 10,
    isActive: true,
    startsAt: null,
    endsAt: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as RafflePoolReward;
}

describe('AdminRafflePoolsService', () => {
  it('lists raffle pools including inactive pools', async () => {
    const { poolRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool({ code: 'older', createdAt: new Date('2026-06-20T00:00:00.000Z') }));
    poolRepository.rows.set('pool-2', pool({ id: 'pool-2', code: 'newer', isActive: false, createdAt: new Date('2026-06-21T00:00:00.000Z') }));

    const pools = await service.listPools();

    assert.deepEqual(pools.map((item) => item.code), ['newer', 'older']);
    assert.equal(pools[0].costErtExact, '5');
    assert.equal(pools[0].costErtDisplay, '5.00');
  });

  it('creates raffle pools with normalized defaults', async () => {
    const { service } = createService();

    const created = await service.createPool({
      code: ' daily ',
      title: ' Daily ',
      description: '',
      costErt: 5,
      dailyUserAttemptLimit: 2,
    });

    assert.equal(created.id, 'pool-1');
    assert.equal(created.code, 'daily');
    assert.equal(created.title, 'Daily');
    assert.equal(created.description, null);
    assert.equal(created.costErt, 5);
    assert.equal(created.costErtExact, '5');
    assert.equal(created.costErtDisplay, '5.00');
    assert.equal(created.isActive, true);
    assert.equal(created.dailyUserAttemptLimit, 2);
  });

  it('updates raffle pools and checks code conflicts', async () => {
    const { poolRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool({ id: 'pool-1', code: 'daily' }));
    poolRepository.rows.set('pool-2', pool({ id: 'pool-2', code: 'weekly' }));

    const updated = await service.updatePool('pool-1', { title: 'Updated Daily', costErt: 8, isActive: false });

    assert.equal(updated.title, 'Updated Daily');
    assert.equal(updated.costErt, 8);
    assert.equal(updated.costErtExact, '8');
    assert.equal(updated.costErtDisplay, '8.00');
    assert.equal(updated.isActive, false);

    await assert.rejects(
      () => service.updatePool('pool-1', { code: 'weekly' }),
      ConflictException,
    );
  });

  it('attaches rewards to raffle pools', async () => {
    const { poolRepository, poolRewardRepository, rewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    rewardRepository.rows.set('reward-1', reward());

    const attached = await service.attachReward('pool-1', {
      rewardId: 'reward-1',
      weight: 20,
      isActive: true,
      startsAt: '2026-06-22T00:00:00.000Z',
      endsAt: '2026-06-23T00:00:00.000Z',
    });

    assert.equal(attached.id, 'pool-reward-1');
    assert.equal(attached.poolId, 'pool-1');
    assert.equal(attached.rewardId, 'reward-1');
    assert.equal(attached.weight, 20);
    assert.equal(attached.startsAt?.toISOString(), '2026-06-22T00:00:00.000Z');
    assert.equal(poolRewardRepository.rows.size, 1);
  });

  it('rejects duplicate pool reward attachments', async () => {
    const { poolRepository, poolRewardRepository, rewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    rewardRepository.rows.set('reward-1', reward());
    poolRewardRepository.rows.set('pool-reward-1', poolReward());

    await assert.rejects(
      () => service.attachReward('pool-1', { rewardId: 'reward-1', weight: 1 }),
      ConflictException,
    );
  });

  it('updates pool reward weight, active flag, and windows', async () => {
    const { poolRepository, poolRewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    poolRewardRepository.rows.set('pool-reward-1', poolReward());

    const updated = await service.updatePoolReward('pool-1', 'pool-reward-1', {
      weight: 30,
      isActive: false,
      startsAt: null,
      endsAt: '2026-06-24T00:00:00.000Z',
    });

    assert.equal(updated.weight, 30);
    assert.equal(updated.isActive, false);
    assert.equal(updated.startsAt, null);
    assert.equal(updated.endsAt?.toISOString(), '2026-06-24T00:00:00.000Z');
  });

  it('returns probability rows with active, stock, and date window states', async () => {
    const { poolRepository, poolRewardRepository, rewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    rewardRepository.rows.set('reward-1', reward({ id: 'reward-1', code: 'available', title: 'Available', stockRemaining: null }));
    rewardRepository.rows.set('reward-2', reward({ id: 'reward-2', code: 'stocked', title: 'Stocked', stockRemaining: 5 }));
    rewardRepository.rows.set('reward-3', reward({ id: 'reward-3', code: 'out', title: 'Out', stockRemaining: 0 }));
    rewardRepository.rows.set('reward-4', reward({ id: 'reward-4', code: 'future', title: 'Future', stockRemaining: null }));
    poolRewardRepository.rows.set('pool-reward-1', poolReward({ id: 'pool-reward-1', rewardId: 'reward-1', reward: rewardRepository.rows.get('reward-1'), weight: 10 }));
    poolRewardRepository.rows.set('pool-reward-2', poolReward({ id: 'pool-reward-2', rewardId: 'reward-2', reward: rewardRepository.rows.get('reward-2'), weight: 30 }));
    poolRewardRepository.rows.set('pool-reward-3', poolReward({ id: 'pool-reward-3', rewardId: 'reward-3', reward: rewardRepository.rows.get('reward-3'), weight: 50 }));
    poolRewardRepository.rows.set('pool-reward-4', poolReward({ id: 'pool-reward-4', rewardId: 'reward-4', reward: rewardRepository.rows.get('reward-4'), weight: 10, startsAt: new Date('2026-06-23T00:00:00.000Z') }));

    const result = await service.getPoolProbabilities('pool-1', new Date('2026-06-22T12:00:00.000Z'));

    assert.equal(result.pool.code, 'daily');
    assert.equal(result.pool.costErt, 5);
    assert.equal(result.pool.costErtExact, '5');
    assert.equal(result.pool.costErtDisplay, '5.00');
    assert.equal(result.totalEligibleWeight, 40);
    assert.equal(result.rewards.length, 4);
    assert.equal(result.rewards[0].rewardCode, 'available');
    assert.equal(result.rewards[0].probabilityPercent, 25);
    assert.equal(result.rewards[0].stockState, 'unlimited');
    assert.equal(result.rewards[0].dateWindowState, 'active');
    assert.equal(result.rewards[1].probabilityPercent, 75);
    assert.equal(result.rewards[1].stockState, 'available');
    assert.equal(result.rewards[2].probabilityPercent, 0);
    assert.equal(result.rewards[2].eligible, false);
    assert.equal(result.rewards[2].stockState, 'out_of_stock');
    assert.equal(result.rewards[3].probabilityPercent, 0);
    assert.equal(result.rewards[3].dateWindowState, 'upcoming');
  });

  it('marks disabled links and disabled rewards as ineligible in probability rows', async () => {
    const { poolRepository, poolRewardRepository, rewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    rewardRepository.rows.set('reward-1', reward({ id: 'reward-1', code: 'available', title: 'Available' }));
    rewardRepository.rows.set('reward-2', reward({ id: 'reward-2', code: 'disabled_link', title: 'Disabled Link' }));
    rewardRepository.rows.set('reward-3', reward({ id: 'reward-3', code: 'disabled_reward', title: 'Disabled Reward', isActive: false }));
    poolRewardRepository.rows.set('pool-reward-1', poolReward({ id: 'pool-reward-1', rewardId: 'reward-1', reward: rewardRepository.rows.get('reward-1'), weight: 10 }));
    poolRewardRepository.rows.set('pool-reward-2', poolReward({ id: 'pool-reward-2', rewardId: 'reward-2', reward: rewardRepository.rows.get('reward-2'), weight: 90, isActive: false }));
    poolRewardRepository.rows.set('pool-reward-3', poolReward({ id: 'pool-reward-3', rewardId: 'reward-3', reward: rewardRepository.rows.get('reward-3'), weight: 90 }));

    const result = await service.getPoolProbabilities('pool-1', new Date('2026-06-22T12:00:00.000Z'));

    assert.equal(result.totalEligibleWeight, 10);
    assert.equal(result.rewards[0].rewardCode, 'available');
    assert.equal(result.rewards[0].eligible, true);
    assert.equal(result.rewards[0].probabilityPercent, 100);
    assert.equal(result.rewards[1].rewardCode, 'disabled_link');
    assert.equal(result.rewards[1].eligible, false);
    assert.equal(result.rewards[1].probabilityPercent, 0);
    assert.deepEqual(result.rewards[1].activeState, { poolRewardActive: false, rewardActive: true });
    assert.equal(result.rewards[2].rewardCode, 'disabled_reward');
    assert.equal(result.rewards[2].eligible, false);
    assert.equal(result.rewards[2].probabilityPercent, 0);
    assert.deepEqual(result.rewards[2].activeState, { poolRewardActive: true, rewardActive: false });
  });
  it('rejects invalid input and missing records', async () => {
    const { poolRepository, rewardRepository, service } = createService();
    poolRepository.rows.set('pool-1', pool());
    rewardRepository.rows.set('reward-1', reward());

    await assert.rejects(
      () => service.createPool({ code: '', title: 'Bad' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createPool({ code: 'bad', title: 'Bad', costErt: -1 }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createPool({ code: 'unsafe', title: 'Unsafe', costErt: Number.MAX_SAFE_INTEGER + 1 }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.attachReward('missing', { rewardId: 'reward-1', weight: 1 }),
      NotFoundException,
    );
    await assert.rejects(
      () => service.attachReward('pool-1', { rewardId: 'missing', weight: 1 }),
      NotFoundException,
    );
    await assert.rejects(
      () => service.updatePoolReward('pool-1', 'missing', { weight: 1 }),
      NotFoundException,
    );
    await assert.rejects(
      () => service.attachReward('pool-1', { rewardId: 'reward-1', weight: 1, startsAt: 'bad-date' }),
      BadRequestException,
    );
  });
});
