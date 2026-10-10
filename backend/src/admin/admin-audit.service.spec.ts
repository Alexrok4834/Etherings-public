import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { RaffleDraw } from '../raffle/raffle-draw.entity';
import { RewardType } from '../raffle/reward.entity';
import { AdminAuditService } from './admin-audit.service';

class FakeRepository<T extends { id?: string; createdAt?: Date }> {
  constructor(readonly rows: Map<string, T>) {}

  async find(options?: { take?: number }) {
    let rows = Array.from(this.rows.values()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

    if (options?.take !== undefined) {
      rows = rows.slice(0, options.take);
    }

    return rows;
  }

  async findOne(options: { where: Partial<T> }) {
    return Array.from(this.rows.values()).find((row) => {
      return Object.entries(options.where).every(([key, value]) => row[key as keyof T] === value);
    }) ?? null;
  }
}

type LedgerCall = {
  userId: string;
  amount: string;
  type: LedgerTransactionType;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

class FakeLedgerService {
  credits: LedgerCall[] = [];
  debits: LedgerCall[] = [];

  async creditDecimal(input: LedgerCall) {
    this.credits.push(input);
    return {
      balance: {
        ertBalance: '100.000000000000000001',
        lifetimeEarnedErt: '125.000000000000000001',
        lifetimeSpentErt: '25',
        updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      },
      ledgerTransaction: {
        id: 'ledger-credit', amount: input.amount, balanceAfter: '100.000000000000000001',
        createdAt: new Date('2026-06-22T00:00:00.000Z'),
      },
    };
  }

  async debitDecimal(input: LedgerCall) {
    this.debits.push(input);
    return {
      balance: {
        ertBalance: '0.000000000000000001',
        lifetimeEarnedErt: '10.000000000000000001',
        lifetimeSpentErt: '10',
        updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      },
      ledgerTransaction: {
        id: 'ledger-debit', amount: `-${input.amount}`, balanceAfter: '0.000000000000000001',
        createdAt: new Date('2026-06-22T00:00:00.000Z'),
      },
    };
  }
}

function createService() {
  const drawRepository = new FakeRepository<RaffleDraw>(new Map());
  const userRepository = new FakeRepository<User>(new Map());
  const ledgerService = new FakeLedgerService();
  const service = new AdminAuditService(drawRepository as never, userRepository as never, ledgerService as never);

  return { drawRepository, userRepository, ledgerService, service };
}

function user(overrides: Partial<User> = {}) {
  return {
    id: 'user-1',
    telegramId: '999',
    username: 'user',
    firstName: null,
    lastName: null,
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as User;
}

function draw(overrides: Partial<RaffleDraw> = {}) {
  return {
    id: 'draw-1',
    userId: 'user-1',
    poolId: 'pool-1',
    rewardId: 'reward-1',
    costErt: 5,
    randomRoll: 0.5,
    weightsSnapshot: {},
    rewardSnapshot: { type: RewardType.Ert, amount: 25 },
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as RaffleDraw;
}

describe('AdminAuditService', () => {
  it('lists latest raffle draws for audit', async () => {
    const { drawRepository, service } = createService();
    drawRepository.rows.set('draw-1', draw({ id: 'draw-1', createdAt: new Date('2026-06-20T00:00:00.000Z') }));
    drawRepository.rows.set('draw-2', draw({ id: 'draw-2', createdAt: new Date('2026-06-21T00:00:00.000Z') }));

    const draws = await service.listRaffleDraws();

    assert.deepEqual(draws.map((item) => item.id), ['draw-2', 'draw-1']);
    assert.equal(draws[0].costErtExact, '5');
    assert.equal(draws[0].costErtDisplay, '5.00');
    assert.equal(draws[0].rewardSnapshot.amountExact, '25');
    assert.equal(draws[0].rewardSnapshot.amountDisplay, '25.00');
  });

  it('preserves exact ERU reward evidence in admin draw audit', async () => {
    const { drawRepository, service } = createService();
    drawRepository.rows.set('eru-draw', draw({
      id: 'eru-draw',
      rewardSnapshot: { type: RewardType.Eru, amount: null, amountExact: '9007199254740993' },
    }));

    const [result] = await service.listRaffleDraws();

    assert.equal(result.rewardSnapshot.amountExact, '9007199254740993');
    assert.equal(result.rewardSnapshot.amountDisplay, '9007199254740993.00');
  });

  it('credits positive admin balance adjustments through ledger', async () => {
    const { userRepository, ledgerService, service } = createService();
    userRepository.rows.set('user-1', user());

    const result = await service.adjustBalance({ userId: 'user-1', amount: 25, reason: 'Manual grant' });

    assert.deepEqual(ledgerService.credits, [{
      userId: 'user-1',
      amount: '25',
      type: LedgerTransactionType.AdminAdjustment,
      referenceType: 'admin_adjustment',
      referenceId: null,
      metadata: { reason: 'Manual grant' },
    }]);
    assert.deepEqual(ledgerService.debits, []);
    assert.equal(result.balance.ertBalance, 100);
    assert.equal(result.balance.ertBalanceExact, '100.000000000000000001');
    assert.equal(result.balance.ertBalanceDisplay, '100.00');
    assert.equal(result.ledgerTransaction.amount, 25);
    assert.equal(result.ledgerTransaction.amountExact, '25');
    assert.equal(result.ledgerTransaction.amountDisplay, '25.00');
    assert.equal(result.balance.updatedAt.toISOString(), '2026-06-22T00:00:00.000Z');
    assert.equal(result.ledgerTransaction.createdAt.toISOString(), '2026-06-22T00:00:00.000Z');
  });

  it('debits negative admin balance adjustments through ledger', async () => {
    const { userRepository, ledgerService, service } = createService();
    userRepository.rows.set('user-1', user());

    const result = await service.adjustBalance({ userId: 'user-1', amount: -10, reason: 'Correction' });

    assert.deepEqual(ledgerService.debits, [{
      userId: 'user-1',
      amount: '10',
      type: LedgerTransactionType.AdminAdjustment,
      referenceType: 'admin_adjustment',
      referenceId: null,
      metadata: { reason: 'Correction' },
    }]);
    assert.equal(result.balance.ertBalanceExact, '0.000000000000000001');
    assert.equal(result.balance.ertBalanceDisplay, '0.00');
    assert.equal(result.ledgerTransaction.amount, -10);
    assert.equal(result.ledgerTransaction.amountExact, '-10');
    assert.equal(result.ledgerTransaction.balanceAfterExact, '0.000000000000000001');
  });

  it('rejects missing reason, zero amount, and missing users', async () => {
    const { service } = createService();

    await assert.rejects(
      () => service.adjustBalance({ userId: 'user-1', amount: 10, reason: '' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.adjustBalance({ userId: 'user-1', amount: 0, reason: 'No-op' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.adjustBalance({ userId: 'user-1', amount: Number.MAX_SAFE_INTEGER + 1, reason: 'Unsafe' }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.adjustBalance({ userId: 'missing', amount: 10, reason: 'Grant' }),
      NotFoundException,
    );
  });
});
