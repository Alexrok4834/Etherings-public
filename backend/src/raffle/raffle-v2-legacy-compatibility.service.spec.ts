import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { User } from '../auth/user.entity';
import { RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleV2LegacyCompatibilityService } from './raffle-v2-legacy-compatibility.service';
import { RaffleV2ReadPersistence } from './raffle-v2-read.repository';
import { RewardType } from './reward.entity';
import { UserReward } from './user-reward.entity';

const ownerId = '10000000-0000-4000-8000-000000000001';
const machineId = '10000000-0000-4000-8000-000000000002';
const configurationId = '10000000-0000-4000-8000-000000000003';
const rewardId = '10000000-0000-4000-8000-000000000004';
const resultId = '10000000-0000-4000-8000-000000000005';
const operationKey = '10000000-0000-4000-8000-000000000006';

describe('RaffleV2LegacyCompatibilityService', () => {
  it('preserves legacy pool reads until a v2 configuration is active', async () => {
    const state = setup(false);
    assert.deepEqual(await state.service.listPools(), [{ id: 'legacy-pool' }]);
    assert.equal(state.legacy.poolCalls, 1);
  });

  it('adapts one active v2 Draw to the installed APK pool shape', async () => {
    const state = setup(true);
    const pools = await state.service.listPools();
    assert.equal(pools.length, 1);
    assert.deepEqual(pools[0], {
      id: machineId,
      code: 'daily-draw',
      title: 'Daily Draw',
      description: null,
      costErt: 5,
      costErtExact: '5',
      costErtDisplay: '5.00',
      dailyUserAttemptLimit: 5,
      rewards: [{
        id: rewardId, code: 'ert-5', title: '5 ERT', description: null, type: RewardType.Ert,
        amount: 5, amountExact: '5', amountDisplay: '5.00', metadata: null, imageUrl: null,
        stockRemaining: null, weight: 100, probability: 1,
      }],
    });
    assert.equal(state.legacy.poolCalls, 0);
  });

  it('adapts fractional ERU to exact/display fields without an unsafe legacy number', async () => {
    const state = setup(true);
    const current = activeCurrent();
    current.rewards[0].rewardSnapshot = {
      ...current.rewards[0].rewardSnapshot,
      code: 'eru-fractional', title: 'Fractional ERU', type: RewardType.Eru,
      amountExact: '1.235',
    };
    current.rewards[0].reward = {
      ...current.rewards[0].reward,
      type: RewardType.Eru, amount: null, amountExactValue: '1.235000000000000000',
    };
    state.repository.currentOverride = current;

    const [pool] = await state.service.listPools();
    assert.deepEqual(pool.rewards[0], {
      id: rewardId, code: 'eru-fractional', title: 'Fractional ERU', description: null,
      type: RewardType.Eru, amount: null, amountExact: '1.235', amountDisplay: '1.24',
      metadata: null, imageUrl: null, stockRemaining: null, weight: 100, probability: 1,
    });
  });

  it('merges immutable v2 results with untouched legacy history and keeps the 50-item bound', async () => {
    const state = setup(true);
    const history = await state.service.listHistory(user()) as any[];
    assert.equal(history.length, 2);
    assert.equal(history[0].draw.id, resultId);
    assert.equal(history[1].draw.id, 'legacy-result');
    assert.equal(history[0].userReward.raffleDrawResultV2Id, resultId);
  });
});

class FakeRepository implements RaffleV2ReadPersistence {
  currentOverride: any = null;
  readonly userRewards = [Object.assign(new UserReward(), {
    id: '10000000-0000-4000-8000-000000000007', userId: ownerId, rewardId,
    raffleDrawId: null, raffleDrawResultV2Id: resultId, title: '5 ERT', type: RewardType.Ert,
    amount: 5, amountExactValue: null, eruBalanceAfterExact: null, metadata: null,
    createdAt: new Date('2026-09-01T12:00:01.000Z'),
  })];

  constructor(private readonly active: boolean) {}

  async readLegacyCurrent() {
    return this.currentOverride
      ?? (this.active ? activeCurrent() : { machine: null, configuration: null, rewards: [] } as any);
  }

  async readUserRewardsForResults(owner: string, ids: string[]) {
    return this.userRewards.filter((reward) => reward.userId === owner && ids.includes(reward.raffleDrawResultV2Id!));
  }

  async readCurrent(): Promise<any> { throw new Error('unused'); }
  async readHistory(): Promise<any[]> { throw new Error('unused'); }
}

class FakeReads {
  async getHistory() {
    const response = v2Response();
    const { idempotencyKey: _, ...operation } = response.operation;
    return {
      contractVersion: 'raffle-v2',
      items: [{ operationId: operation.operationId, draw: response.draw, selection: response.selection,
        reward: response.reward, fulfillment: response.fulfillment }],
      nextCursor: null,
    };
  }
}

class FakeLegacy {
  poolCalls = 0;

  async listPublicPools() { this.poolCalls += 1; return [{ id: 'legacy-pool' }]; }
  async listHistory() {
    return [{
      draw: { id: 'legacy-result', createdAt: '2026-09-01T11:00:00.000Z' },
      userReward: { title: 'Legacy' },
    }];
  }
}

function setup(active: boolean) {
  const repository = new FakeRepository(active);
  const reads = new FakeReads();
  const legacy = new FakeLegacy();
  return {
    repository, reads, legacy,
    service: new RaffleV2LegacyCompatibilityService(repository, reads as never, legacy as never),
  };
}

function activeCurrent(): any {
  return {
    machine: { id: machineId, code: 'daily-draw', isAvailable: true, pausedAt: null },
    configuration: {
      id: configurationId, machineId, contractVersion: 'raffle-v2', status: RaffleConfigurationStatus.Active,
      title: 'Daily Draw', description: null, costErtExact: '5.000000000000000000', dailyUserAttemptLimit: 5,
    },
    rewards: [{
      configurationId, rewardId, segmentIndex: 0, weight: 100,
      rewardSnapshot: {
        rewardId, code: 'ert-5', title: '5 ERT', type: RewardType.Ert, segmentIndex: 0,
        weight: '100', amountExact: '5', imageUrl: null,
      },
      reward: {
        id: rewardId, type: RewardType.Ert, isActive: true, amount: 5, amountExactValue: null,
        stockTotal: null, stockRemaining: null,
      },
    }],
  };
}

function v2Response(): any {
  return {
    contractVersion: 'raffle-v2',
    operation: { operationId: operationKey, idempotencyKey: operationKey, status: 'COMPLETED', replayed: false },
    draw: {
      drawResultId: resultId, drawId: machineId, configurationVersion: configurationId,
      createdAt: '2026-09-01T12:00:00.000Z',
      cost: { currency: 'ERT', amountExact: '5', amountDisplay: '5.00', ledgerTransactionId: operationKey },
      attempts: { limit: 5, used: 1, remaining: 4, day: '2026-09-01', resetsAt: '2026-09-02T00:00:00.000Z' },
    },
    selection: {
      algorithm: 'CSPRNG_UNBIASED_INT_V1', ticket: '42', totalWeight: '100', selectedSegmentIndex: 0,
      ranges: [{ segmentIndex: 0, rewardId, weight: '100', startInclusive: '0', endExclusive: '100' }],
    },
    reward: {
      rewardId, code: 'ert-5', title: '5 ERT', type: 'ERT', segmentIndex: 0, weight: '100',
      probability: { numerator: '100', denominator: '100' }, imageUrl: null,
      amountExact: '5', amountDisplay: '5.00',
    },
    fulfillment: { type: 'ERT_CREDIT', ledgerTransactionId: operationKey, balanceAfterExact: '10', balanceAfterDisplay: '10.00' },
  };
}

function user() { return Object.assign(new User(), { id: ownerId }); }
