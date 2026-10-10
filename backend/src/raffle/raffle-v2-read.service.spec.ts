import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeRaffleV2HistoryCursor, RaffleV2ApiContractError } from './raffle-v2-api-contract';
import { RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleV2DrawCoreError, RaffleV2DrawCoreFailure } from './raffle-v2-draw-core.service';
import { RaffleV2CurrentReadSnapshot, RaffleV2HistoryReadRow, RaffleV2ReadPersistence } from './raffle-v2-read.repository';
import { RaffleV2ReadService } from './raffle-v2-read.service';
import { RewardType } from './reward.entity';

const ownerId = '10000000-0000-4000-8000-000000000001';
const machineId = '10000000-0000-4000-8000-000000000002';
const configurationId = '10000000-0000-4000-8000-000000000003';
const resultIds = [
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
];
const operationIds = [
  '10000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000022',
];

describe('RaffleV2ReadService', () => {
  it('assembles the exact account-specific Draw snapshot', async () => {
    const repository = new FakeReadRepository(currentSnapshot(false), []);
    const result = await new FixedReadService(repository).getCurrent(ownerId) as any;

    assert.equal(repository.currentOwner, ownerId);
    assert.equal(repository.currentDate, '2026-08-31');
    assert.equal(result.contractVersion, 'raffle-v2');
    assert.equal(result.serverTime, '2026-08-31T12:30:00.000Z');
    assert.deepEqual(result.draw.cost, { currency: 'ERT', amountExact: '5', amountDisplay: '5.00' });
    assert.deepEqual(result.draw.attempts, {
      limit: 5, used: 2, remaining: 3, day: '2026-08-31', resetsAt: '2026-09-01T00:00:00.000Z',
    });
    assert.equal(result.draw.totalWeight, '100');
    assert.deepEqual(result.draw.rewards.map((reward: any) => [
      reward.type, reward.probability.numerator, reward.probability.denominator,
    ]), [['ERT', '68', '100'], ['ERU', '31', '100'], ['COPPER_RING', '1', '100']]);
    assert.equal(Object.isFrozen(result.draw.rewards), true);
  });

  it('omits Cooper after the owner daily award and normalizes only the denominator', async () => {
    const result = await new FixedReadService(new FakeReadRepository(currentSnapshot(true), []))
      .getCurrent(ownerId) as any;
    assert.equal(result.draw.totalWeight, '99');
    assert.deepEqual(result.draw.rewards.map((reward: any) => [
      reward.type, reward.probability.numerator, reward.probability.denominator,
    ]), [['ERT', '68', '99'], ['ERU', '31', '99']]);
  });

  it('normalizes fixed-scale fractional ERU and exposes two-decimal display', async () => {
    const snapshot = currentSnapshot(false);
    snapshot.rewards[1].rewardSnapshot.amountExact = '1.235';
    snapshot.rewards[1].reward.amountExactValue = '1.235000000000000000';
    const result = await new FixedReadService(new FakeReadRepository(snapshot, [])).getCurrent(ownerId) as any;
    assert.equal(result.draw.rewards[1].amountExact, '1.235');
    assert.equal(result.draw.rewards[1].amountDisplay, '1.24');
  });

  it('clamps pre-activation legacy attempts to a consumed v2 daily limit', async () => {
    const snapshot = currentSnapshot(false);
    snapshot.attemptsUsed = 6;

    const result = await new FixedReadService(new FakeReadRepository(snapshot, []))
      .getCurrent(ownerId) as any;

    assert.deepEqual(result.draw.attempts, {
      limit: 5, used: 5, remaining: 0, day: '2026-08-31', resetsAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('uses the active configuration as the authority for cost and attempt limit', async () => {
    const snapshot = currentSnapshot(false);
    snapshot.configuration.costErtExact = '7.500000000000000000';
    snapshot.configuration.dailyUserAttemptLimit = 3;

    const result = await new FixedReadService(new FakeReadRepository(snapshot, []))
      .getCurrent(ownerId) as any;

    assert.deepEqual(result.draw.cost, { currency: 'ERT', amountExact: '7.5', amountDisplay: '7.50' });
    assert.deepEqual(result.draw.attempts, {
      limit: 3, used: 2, remaining: 1, day: '2026-08-31', resetsAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('returns unavailable for an inactive Draw and fails closed for corrupt persisted state', async () => {
    const inactive = { ...currentSnapshot(false), machine: null, configuration: null, rewards: [] };
    await assert.rejects(
      () => new FixedReadService(new FakeReadRepository(inactive, [])).getCurrent(ownerId),
      (error: unknown) => error instanceof RaffleV2DrawCoreError
        && error.reason === RaffleV2DrawCoreFailure.Unavailable,
    );
    const corrupt = currentSnapshot(false);
    corrupt.rewards[0].rewardSnapshot.amountExact = '999';
    await assert.rejects(
      () => new FixedReadService(new FakeReadRepository(corrupt, [])).getCurrent(ownerId),
      (error: unknown) => error instanceof RaffleV2ApiContractError && error.boundary === 'STATE',
    );
  });

  it('pages immutable owner history from persisted response snapshots', async () => {
    const rows = historyRows();
    const repository = new FakeReadRepository(currentSnapshot(false), rows);
    const result = await new FixedReadService(repository).getHistory(ownerId, { limit: '2' }) as any;

    assert.equal(repository.historyOwner, ownerId);
    assert.equal(repository.historyLimit, 2);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].operationId, operationIds[0]);
    assert.equal('idempotencyKey' in result.items[0], false);
    assert.deepEqual(decodeRaffleV2HistoryCursor(result.nextCursor), {
      createdAt: rows[1].createdAt.toISOString(), drawResultId: rows[1].drawResultId,
    });
  });

  it('rejects history whose immutable snapshot does not match its indexed evidence', async () => {
    const rows = historyRows();
    rows[0].responseSnapshot.draw.drawResultId = resultIds[2];
    await assert.rejects(
      () => new FixedReadService(new FakeReadRepository(currentSnapshot(false), rows))
        .getHistory(ownerId, { limit: '20' }),
      (error: unknown) => error instanceof RaffleV2ApiContractError && error.boundary === 'STATE',
    );
  });
});

class FixedReadService extends RaffleV2ReadService {
  protected currentTime() { return new Date('2026-08-31T12:30:00.000Z'); }
}

class FakeReadRepository implements RaffleV2ReadPersistence {
  currentOwner?: string;
  currentDate?: string;
  historyOwner?: string;
  historyLimit?: number;

  constructor(
    private readonly current: RaffleV2CurrentReadSnapshot,
    private readonly history: RaffleV2HistoryReadRow[],
  ) {}

  async readCurrent(owner: string, date: string) {
    this.currentOwner = owner;
    this.currentDate = date;
    return this.current;
  }

  async readHistory(owner: string, limit: number) {
    this.historyOwner = owner;
    this.historyLimit = limit;
    return this.history;
  }

  async readLegacyCurrent() {
    return {
      machine: this.current.machine,
      configuration: this.current.configuration,
      rewards: this.current.rewards,
    };
  }

  async readUserRewardsForResults() { return []; }
}

function currentSnapshot(copperAwarded: boolean): any {
  return {
    ownerExists: true,
    machine: { id: machineId, singletonKey: 1, isAvailable: true, pausedAt: null },
    configuration: {
      id: configurationId, machineId, contractVersion: 'raffle-v2', status: RaffleConfigurationStatus.Active,
      title: 'Daily Draw', description: null, costErtExact: '5.000000000000000000', dailyUserAttemptLimit: 5,
    },
    rewards: [
      mapping(0, 68, RewardType.Ert, '5'),
      mapping(1, 31, RewardType.Eru, '1'),
      mapping(2, 1, RewardType.CopperRing, null),
    ],
    attemptsUsed: 2,
    copperAwarded,
  };
}

function mapping(segmentIndex: number, weight: number, type: RewardType, amountExact: string | null): any {
  const rewardId = `20000000-0000-4000-8000-00000000000${segmentIndex}`;
  return {
    configurationId, rewardId, segmentIndex, weight,
    rewardSnapshot: {
      rewardId, segmentIndex, weight: String(weight), code: `reward-${segmentIndex}`, title: 'Reward',
      type, amountExact, imageUrl: null,
      ...(type === RewardType.CopperRing ? {
        asset: { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 },
      } : {}),
    },
    reward: {
      id: rewardId, type, isActive: true, stockTotal: null, stockRemaining: null,
      amount: type === RewardType.Ert ? Number(amountExact) : null,
      amountExactValue: type === RewardType.Eru ? amountExact : null,
    },
  };
}

function historyRows(): any[] {
  return resultIds.map((drawResultId, index) => {
    const createdAt = new Date(`2026-08-31T12:0${3 - index}:00.000Z`);
    const rewardId = '20000000-0000-4000-8000-000000000000';
    return {
      drawResultId, operationId: operationIds[index], createdAt,
      responseSnapshot: {
        contractVersion: 'raffle-v2',
        operation: {
          operationId: operationIds[index], idempotencyKey: ownerId, status: 'COMPLETED', replayed: false,
        },
        draw: { drawResultId, createdAt: createdAt.toISOString() },
        selection: { ticket: String(index), totalWeight: '30' },
        reward: {
          rewardId, code: 'reward-0', title: '5 ERT', type: 'ERT', segmentIndex: 0,
          weight: '30', probability: { numerator: '30', denominator: '30' }, imageUrl: null,
          amountExact: '5', amountDisplay: null,
        },
        fulfillment: { type: 'ERT_CREDIT' },
      },
    };
  });
}
