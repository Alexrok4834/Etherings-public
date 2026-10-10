import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager } from 'typeorm';
import { EruLedgerService } from '../balance/eru-ledger.service';
import { LedgerService } from '../balance/ledger.service';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleCopperAwardService } from './raffle-copper-award.service';
import { RaffleDrawOperation, RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleV2IntegerSelection } from './raffle-v2-integer-selection.service';
import { RaffleV2FulfillmentRepository } from './raffle-v2-fulfillment.repository';
import {
  RaffleV2FulfillmentError,
  RaffleV2FulfillmentFailure,
  RaffleV2FulfillmentService,
} from './raffle-v2-fulfillment.service';
import { Reward, RewardType } from './reward.entity';

class FakeRepository {
  calls: string[] = [];
  balance = '100';
  attempts = 0;
  equipmentValid = true;
  copperAwarded = false;
  userRewards: Array<Record<string, unknown>> = [];

  async lockBalance() { this.calls.push('balance'); return { ertBalanceExact: this.balance }; }
  async lockDailyStats() {
    this.calls.push('limits');
    return Object.assign(new DailyUserStats(), { raffleAttempts: this.attempts });
  }
  async hasValidEquipment() { this.calls.push('equipment'); return this.equipmentValid; }
  async hasCopperAward() { this.calls.push('copper-guard'); return this.copperAwarded; }
  async saveUserReward(_manager: EntityManager, input: Record<string, unknown>) {
    this.calls.push('user-reward'); this.userRewards.push(input); return input;
  }
  async incrementAttempt(_manager: EntityManager, stats: DailyUserStats) {
    this.calls.push('attempt'); this.attempts = stats.raffleAttempts + 1; stats.raffleAttempts = this.attempts; return stats;
  }
}

class FixedService extends RaffleV2FulfillmentService {
  protected currentTime() { return new Date('2026-08-31T18:00:00.000Z'); }
}

function fixture(type: RewardType = RewardType.CopperRing) {
  const repository = new FakeRepository();
  const ledgerCalls: string[] = [];
  const ledger = {
    async debitDecimalInTransaction(_manager: EntityManager, input: { amount: string }) {
      ledgerCalls.push(`debit:${input.amount}`);
      return { balance: { ertBalance: '95' }, ledgerTransaction: { id: randomUUID() } };
    },
    async creditDecimalInTransaction() {
      ledgerCalls.push('ert-credit');
      return { balance: { ertBalance: '105' }, ledgerTransaction: { id: randomUUID() } };
    },
  } as unknown as LedgerService;
  const eruLedger = {
    async creditInTransaction(_manager: EntityManager, input: { amount: string }) {
      ledgerCalls.push(`eru-credit:${input.amount}`);
      return { ledgerTransaction: { id: randomUUID(), balanceAfter: '100.000000000000000001' } };
    },
  } as unknown as EruLedgerService;
  const copperCalls: string[] = [];
  const ringId = randomUUID();
  const copper = {
    async awardInTransaction() {
      copperCalls.push('copper');
      return { ringEventId: randomUUID(), ring: { id: ringId, equipped: false } };
    },
  } as unknown as RaffleCopperAwardService;
  const service = new FixedService(
    repository as unknown as RaffleV2FulfillmentRepository,
    ledger,
    eruLedger,
    copper,
  );
  const ownerUserId = randomUUID();
  const operation = Object.assign(new RaffleDrawOperation(), {
    id: randomUUID(), ownerUserId, status: RaffleDrawOperationStatus.Pending,
  });
  const machine = Object.assign(new RaffleMachine(), {
    id: randomUUID(), singletonKey: 1, isAvailable: true, pausedAt: null,
  });
  const configuration = Object.assign(new RaffleConfiguration(), {
    id: randomUUID(), machineId: machine.id, contractVersion: 'raffle-v2',
    status: RaffleConfigurationStatus.Active, costErtExact: '5.000000000000000000',
    dailyUserAttemptLimit: 5,
  });
  const reward = Object.assign(new Reward(), {
    id: randomUUID(), code: `${type.toLowerCase()}-reward`, title: `${type} reward`, type,
    isActive: true, stockTotal: null, stockRemaining: null,
    amount: type === RewardType.Ert ? 10 : null,
    amountExactValue: type === RewardType.Eru ? '30' : null,
  });
  const rewardSnapshot = {
    rewardId: reward.id, type, amountExact: type === RewardType.Ert ? '10' : type === RewardType.Eru ? '30' : null,
  };
  const mapping = Object.assign(new RaffleConfigurationReward(), {
    configurationId: configuration.id, rewardId: reward.id, segmentIndex: 0, weight: 1,
    rewardSnapshot, reward,
  });
  const draw = { machine, configuration, rewards: [mapping] };
  const result = Object.assign(new RaffleDrawResultV2(), {
    id: randomUUID(), operationId: operation.id, ownerUserId, configurationId: configuration.id,
    selectedRewardId: reward.id,
  });
  const selection = {
    selectedRewardId: reward.id, selectedRewardSnapshot: rewardSnapshot,
  } as unknown as RaffleV2IntegerSelection;
  return {
    service, repository, ledgerCalls, copperCalls, ownerUserId, operation, draw, result, selection, reward, ringId,
    manager: {} as EntityManager,
  };
}

describe('RaffleV2FulfillmentService internal atomic boundary', () => {
  it('locks balance and limits before account Ring eligibility and excludes a second daily Cooper', async () => {
    const state = fixture();
    state.repository.copperAwarded = true;
    await assert.rejects(
      state.service.lockAndValidate(state.manager, {
        ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      }),
      (error) => failure(error, RaffleV2FulfillmentFailure.NoEligibleReward),
    );
    assert.deepEqual(state.repository.calls, ['balance', 'limits', 'equipment', 'copper-guard']);
    assert.deepEqual(state.ledgerCalls, []);
  });

  it('debits once, awards an unequipped Cooper, then consumes one attempt', async () => {
    const state = fixture();
    const prepared = await state.service.lockAndValidate(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
    });
    const response = await state.service.fulfill(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      selection: state.selection, result: state.result, preparedState: prepared.state,
    });
    assert.deepEqual(state.ledgerCalls, ['debit:5']);
    assert.deepEqual(state.copperCalls, ['copper']);
    assert.equal(response.cost.amountExact, '5');
    assert.equal(response.attempts.used, 1);
    assert.deepEqual(response.fulfillment, {
      type: 'RING_AWARD', ringId: state.ringId,
      ringEventId: (response.fulfillment as Record<string, unknown>).ringEventId,
      equipped: false, ring: { id: state.ringId, equipped: false },
    });
    assert.equal(state.repository.userRewards.length, 0);
  });

  for (const type of [RewardType.Ert, RewardType.Eru]) {
    it(`dispatches exact ${type} credit and persists one v2 user reward`, async () => {
      const state = fixture(type);
      const prepared = await state.service.lockAndValidate(state.manager, {
        ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      });
      const response = await state.service.fulfill(state.manager, {
        ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
        selection: state.selection, result: state.result, preparedState: prepared.state,
      });
      assert.deepEqual(state.ledgerCalls, ['debit:5', type === RewardType.Ert ? 'ert-credit' : 'eru-credit:30']);
      assert.equal((response.fulfillment as Record<string, unknown>).type, `${type}_CREDIT`);
      assert.equal(state.repository.userRewards.length, 1);
      assert.equal(state.repository.userRewards[0].raffleDrawResultV2Id, state.result.id);
    });
  }

  it('credits an 18-place fractional ERU reward and derives the two-decimal post-balance', async () => {
    const state = fixture(RewardType.Eru);
    state.reward.amountExactValue = '1.234567890123456789';
    state.draw.rewards[0].rewardSnapshot.amountExact = '1.234567890123456789';
    const prepared = await state.service.lockAndValidate(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
    });
    const response = await state.service.fulfill(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      selection: state.selection, result: state.result, preparedState: prepared.state,
    });
    assert.deepEqual(state.ledgerCalls, ['debit:5', 'eru-credit:1.234567890123456789']);
    assert.equal(state.repository.userRewards[0].amountExactValue, '1.234567890123456789');
    assert.equal((response.fulfillment as Record<string, unknown>).balanceAfterExact, '100.000000000000000001');
    assert.equal((response.fulfillment as Record<string, unknown>).balanceAfterDisplay, '100.00');
  });

  it('fails closed when the persisted ERU reward amount is not a valid decimal', async () => {
    const state = fixture(RewardType.Eru);
    state.reward.amountExactValue = 'invalid';
    await assert.rejects(state.service.lockAndValidate(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
    }), (error) => failure(error, RaffleV2FulfillmentFailure.InvalidState));
    assert.deepEqual(state.ledgerCalls, []);
  });

  it('rejects insufficient balance and the fifth completed attempt before fulfillment', async () => {
    const low = fixture(); low.repository.balance = '4.999999999999999999';
    await assert.rejects(low.service.lockAndValidate(low.manager, {
      ownerUserId: low.ownerUserId, operation: low.operation, draw: low.draw,
    }), (error) => failure(error, RaffleV2FulfillmentFailure.InsufficientBalance));
    const limited = fixture(); limited.repository.attempts = 5;
    await assert.rejects(limited.service.lockAndValidate(limited.manager, {
      ownerUserId: limited.ownerUserId, operation: limited.operation, draw: limited.draw,
    }), (error) => failure(error, RaffleV2FulfillmentFailure.DailyLimitReached));
    assert.deepEqual(low.ledgerCalls, []);
    assert.deepEqual(limited.ledgerCalls, []);
  });

  it('rejects fulfillment without the exact prepared object issued by this service', async () => {
    const state = fixture();
    await assert.rejects(state.service.fulfill(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      selection: state.selection, result: state.result, preparedState: {},
    }), (error) => failure(error, RaffleV2FulfillmentFailure.InvalidState));
    assert.deepEqual(state.ledgerCalls, []);
  });

  it('debits and enforces the exact economy from the locked active configuration', async () => {
    const state = fixture(RewardType.Ert);
    state.draw.configuration.costErtExact = '7.500000000000000000';
    state.draw.configuration.dailyUserAttemptLimit = 3;
    state.repository.balance = '7.5';
    state.repository.attempts = 2;
    const prepared = await state.service.lockAndValidate(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
    });
    const response = await state.service.fulfill(state.manager, {
      ownerUserId: state.ownerUserId, operation: state.operation, draw: state.draw,
      selection: state.selection, result: state.result, preparedState: prepared.state,
    });

    assert.deepEqual(state.ledgerCalls, ['debit:7.5', 'ert-credit']);
    assert.deepEqual(response.cost, {
      currency: 'ERT', amountExact: '7.5', amountDisplay: '7.50',
      ledgerTransactionId: (response.cost as Record<string, unknown>).ledgerTransactionId,
    });
    assert.deepEqual(response.attempts, {
      limit: 3, used: 3, remaining: 0, day: '2026-08-31', resetsAt: '2026-09-01T00:00:00.000Z',
    });
  });
});

function failure(error: unknown, expected: RaffleV2FulfillmentFailure) {
  return error instanceof RaffleV2FulfillmentError && error.reason === expected;
}
