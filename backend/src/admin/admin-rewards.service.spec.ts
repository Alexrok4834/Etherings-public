import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reward, RewardType } from '../raffle/reward.entity';
import { AdminRewardsService } from './admin-rewards.service';

class FakeRewardRepository {
  rows = new Map<string, Reward>();
  nextId = 1;

  async find() {
    return Array.from(this.rows.values()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  async findOne(options: { where: Partial<Reward> }) {
    return Array.from(this.rows.values()).find((row) => {
      return Object.entries(options.where).every(([key, value]) => row[key as keyof Reward] === value);
    }) ?? null;
  }

  create(input: Partial<Reward>) {
    return input as Reward;
  }

  async save(reward: Reward) {
    const now = new Date('2026-06-22T00:00:00.000Z');
    const saved = {
      ...reward,
      id: reward.id ?? `reward-${this.nextId++}`,
      createdAt: reward.createdAt ?? now,
      updatedAt: now,
    } as Reward;
    this.rows.set(saved.id, saved);

    return saved;
  }
}

function createService() {
  const repository = new FakeRewardRepository();
  const activeRewardIds = new Set<string>();
  const dataSource = {
    async query(_sql: string, parameters: unknown[]) {
      return [{ referenced: activeRewardIds.has(String(parameters[0])) }];
    },
  };
  const service = new AdminRewardsService(repository as never, dataSource as never);

  return { activeRewardIds, repository, service };
}

function reward(overrides: Partial<Reward> = {}) {
  return {
    id: 'reward-1',
    code: 'coins',
    title: 'Coins',
    description: 'ERT prize',
    type: RewardType.Ert,
    amount: 25,
    amountExactValue: '25',
    metadata: { tier: 'common' },
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

describe('AdminRewardsService', () => {
  it('lists rewards including disabled rewards', async () => {
    const { repository, service } = createService();
    repository.rows.set('active', reward({ id: 'active', code: 'active', isActive: true, createdAt: new Date('2026-06-21T00:00:00.000Z') }));
    repository.rows.set('disabled', reward({ id: 'disabled', code: 'disabled', isActive: false, createdAt: new Date('2026-06-20T00:00:00.000Z') }));

    const rewards = await service.listRewards();

    assert.deepEqual(rewards.map((item) => item.code), ['active', 'disabled']);
    assert.equal(rewards[0].amountExact, '25');
    assert.equal(rewards[0].amountDisplay, '25.00');
  });

  it('creates rewards with normalized optional fields', async () => {
    const { service } = createService();

    const created = await service.createReward({
      code: ' smoke_ert ',
      title: ' Smoke ERT ',
      description: '',
      type: RewardType.Ert,
      amount: 10,
      metadata: { source: 'test' },
      imageUrl: null,
      stockTotal: 100,
      stockRemaining: 100,
      perUserLimit: 1,
      dailyGlobalLimit: 20,
    });

    assert.equal(created.id, 'reward-1');
    assert.equal(created.code, 'smoke_ert');
    assert.equal(created.title, 'Smoke ERT');
    assert.equal(created.description, null);
    assert.equal(created.type, RewardType.Ert);
    assert.equal(created.amount, 10);
    assert.equal(created.amountExact, '10');
    assert.equal(created.amountDisplay, '10.00');
    assert.equal(created.isActive, true);
    assert.equal(created.stockRemaining, 100);
  });

  it('creates exact decimal ERU rewards with safe compatibility and two-decimal display', async () => {
    const { service } = createService();

    const created = await service.createReward({
      code: 'eru_30',
      title: '30 ERU',
      type: RewardType.Eru,
      amountExact: '9007199254740993',
    });

    assert.equal(created.type, RewardType.Eru);
    assert.equal(created.amount, null);
    assert.equal(created.amountExact, '9007199254740993');
    assert.equal(created.amountDisplay, '9007199254740993.00');
    assert.equal('amountExactValue' in created, false);

    const fractional = await service.createReward({
      code: 'eru_fractional', title: 'Fractional ERU', type: RewardType.Eru, amountExact: '1.235',
    });
    assert.equal(fractional.amount, null);
    assert.equal(fractional.amountExact, '1.235');
    assert.equal(fractional.amountDisplay, '1.24');
  });

  it('rejects ERU number input, zero, excess precision, unsafe syntax, and missing exact amount', async () => {
    const { service } = createService();

    for (const input of [
      { code: 'eru_number', title: 'ERU', type: RewardType.Eru, amount: 30 },
      { code: 'eru_zero', title: 'ERU', type: RewardType.Eru, amountExact: '0' },
      { code: 'eru_precision', title: 'ERU', type: RewardType.Eru, amountExact: '1.1234567890123456789' },
      { code: 'eru_leading', title: 'ERU', type: RewardType.Eru, amountExact: '030' },
      { code: 'eru_missing', title: 'ERU', type: RewardType.Eru },
    ]) {
      await assert.rejects(() => service.createReward(input), BadRequestException);
    }
  });

  it('rejects duplicate reward codes', async () => {
    const { repository, service } = createService();
    repository.rows.set('reward-1', reward());

    await assert.rejects(
      () => service.createReward({ code: 'coins', title: 'Coins 2', type: RewardType.Ert }),
      ConflictException,
    );
  });

  it('updates reward fields and checks code conflicts', async () => {
    const { repository, service } = createService();
    repository.rows.set('reward-1', reward({ id: 'reward-1', code: 'coins' }));
    repository.rows.set('reward-2', reward({ id: 'reward-2', code: 'badge', type: RewardType.Badge, amount: null }));

    const updated = await service.updateReward('reward-1', {
      code: 'coins_updated',
      title: 'Updated Coins',
      amount: 30,
      isActive: false,
    });

    assert.equal(updated.code, 'coins_updated');
    assert.equal(updated.title, 'Updated Coins');
    assert.equal(updated.amount, 30);
    assert.equal(updated.amountExact, '30');
    assert.equal(updated.amountDisplay, '30.00');
    assert.equal(updated.isActive, false);

    await assert.rejects(
      () => service.updateReward('reward-1', { code: 'badge' }),
      ConflictException,
    );
  });

  it('soft-disables rewards instead of deleting them', async () => {
    const { repository, service } = createService();
    repository.rows.set('reward-1', reward({ isActive: true }));

    const disabled = await service.softDisableReward('reward-1');

    assert.equal(disabled.isActive, false);
    assert.equal(repository.rows.has('reward-1'), true);
  });

  it('rejects updates and disabling when a reward belongs to the active Raffle v2 configuration', async () => {
    const { activeRewardIds, repository, service } = createService();
    repository.rows.set('reward-1', reward({ isActive: true }));
    activeRewardIds.add('reward-1');

    await assert.rejects(
      () => service.updateReward('reward-1', { title: 'Changed' }),
      (error: unknown) => error instanceof ConflictException
        && error.message.includes('Active Raffle v2 rewards are immutable'),
    );
    await assert.rejects(
      () => service.softDisableReward('reward-1'),
      (error: unknown) => error instanceof ConflictException
        && error.message.includes('Active Raffle v2 rewards are immutable'),
    );
    assert.equal(repository.rows.get('reward-1')?.title, 'Coins');
    assert.equal(repository.rows.get('reward-1')?.isActive, true);
  });

  it('rejects invalid input and missing rewards', async () => {
    const { service } = createService();

    await assert.rejects(
      () => service.createReward({ code: '', title: 'Bad', type: RewardType.Ert }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createReward({ code: 'bad', title: 'Bad', type: 'UNKNOWN', amount: -1 }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createReward({
        code: 'unsafe', title: 'Unsafe', type: RewardType.Ert, amount: Number.MAX_SAFE_INTEGER + 1,
      }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.updateReward('missing', { title: 'Missing' }),
      NotFoundException,
    );
  });
});
