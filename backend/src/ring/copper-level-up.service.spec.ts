import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { EruLedgerService } from '../balance/eru-ledger.service';
import { LedgerService } from '../balance/ledger.service';
import { canonicalErt, ErtDecimal } from '../m2e/ert-decimal';
import { CopperLevelUpErrorCode } from './copper-level-up-errors';
import {
  CopperLevelUpOperation,
  CopperLevelUpOperationStatus,
} from './copper-level-up-operation.entity';
import { COPPER_LEVEL_UP_VERSION } from './copper-level-up.rules';
import { CopperLevelUpService } from './copper-level-up.service';
import { CopperRingRepository } from './copper-ring.repository';
import { COPPER_RULESET_VERSION, GameRing } from './game-ring.entity';
import { RingEventType } from './ring-event.entity';

function request(idempotencyKey: string = randomUUID(), overrides: Record<string, unknown> = {}) {
  return {
    expectedCurrentLevel: 1,
    targetLevel: 2,
    idempotencyKey,
    ...overrides,
  };
}

function errorCode(error: unknown) {
  return (error as HttpException).getResponse() as { code?: string };
}

function fixture(options: {
  level?: number;
  ert?: string | number;
  eru?: string;
  failEvent?: boolean;
  failEruDebit?: boolean;
} = {}) {
  const user = Object.assign(new User(), { id: randomUUID() });
  const ring = Object.assign(new GameRing(), {
    id: randomUUID(), ownerUserId: user.id, level: options.level ?? 1,
    comfort: 20, charm: 7, quality: 11, luck: 2, unspentAttributePoints: 0,
  });
  const balance = {
    userId: user.id,
    ertBalance: String(options.ert ?? 100),
    lifetimeEarnedErt: String(options.ert ?? 100),
    lifetimeSpentErt: '0',
    eruBalance: options.eru ?? '100',
    lifetimeEarnedEru: options.eru ?? '100',
    lifetimeSpentEru: '0',
  };
  const operations = new Map<string, CopperLevelUpOperation>();
  const calls: string[] = [];
  let debitCount = 0;
  let eruDebitCount = 0;

  const repository = {
    transaction: async (operation: (manager: object) => Promise<unknown>) => {
      const beforeRing = {
        level: ring.level,
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
        unspentAttributePoints: ring.unspentAttributePoints,
      };
      const beforeBalance = { ...balance };
      const beforeOperations = new Map(operations);
      try {
        return await operation({});
      } catch (error) {
        Object.assign(ring, beforeRing);
        Object.assign(balance, beforeBalance);
        operations.clear();
        for (const [key, value] of beforeOperations) operations.set(key, value);
        throw error;
      }
    },
    claimLevelUpOperation: async (_manager: object, input: Partial<CopperLevelUpOperation>) => {
      calls.push('operation');
      const mapKey = `${input.ownerUserId}:${input.idempotencyKey}`;
      const existing = operations.get(mapKey);
      if (existing) return existing;
      const created = Object.assign(new CopperLevelUpOperation(), input, {
        id: randomUUID(), status: CopperLevelUpOperationStatus.Pending, responseSnapshot: null,
      });
      operations.set(mapKey, created);
      return created;
    },
    lockOwner: async () => { calls.push('owner'); return user; },
    findOwnedRingForUpdate: async () => { calls.push('ring'); return ring; },
    findErtBalanceForUpdate: async () => { calls.push('balance'); return balance; },
    saveRing: async () => { calls.push('save-ring'); return ring; },
    saveLevelUpEvent: async (_manager: object, input: { eventType: RingEventType; snapshot: unknown }) => {
      calls.push('event');
      if (options.failEvent) throw new Error('injected audit failure');
      assert.equal(input.eventType, RingEventType.LevelUp);
      return input;
    },
    completeLevelUpOperation: async (_manager: object, operation: CopperLevelUpOperation, snapshot: Record<string, unknown>) => {
      calls.push('complete');
      operation.status = CopperLevelUpOperationStatus.Completed;
      operation.responseSnapshot = snapshot;
      return operation;
    },
  };
  const ledger = {
    debitDecimalInTransaction: async (_manager: object, input: { amount: string; type: LedgerTransactionType; referenceId: string }) => {
      calls.push('debit');
      debitCount += 1;
      assert.equal(input.type, LedgerTransactionType.CopperLevelUpSpend);
      balance.ertBalance = canonicalErt(new ErtDecimal(balance.ertBalance).minus(input.amount));
      balance.lifetimeSpentErt = canonicalErt(new ErtDecimal(balance.lifetimeSpentErt).plus(input.amount));
      return { balance, ledgerTransaction: { id: randomUUID(), referenceId: input.referenceId } };
    },
  };
  const eruLedger = {
    debitInTransaction: async (_manager: object, input: {
      amount: string;
      type: LedgerTransactionType;
      referenceId: string;
    }) => {
      calls.push('eru-debit');
      if (options.failEruDebit) throw new Error('injected ERU debit failure');
      eruDebitCount += 1;
      assert.equal(input.type, LedgerTransactionType.CopperLevelUpSpend);
      balance.eruBalance = String(BigInt(balance.eruBalance) - BigInt(input.amount));
      balance.lifetimeSpentEru = String(BigInt(balance.lifetimeSpentEru) + BigInt(input.amount));
      return {
        replayed: false,
        ledgerTransaction: {
          id: randomUUID(),
          referenceId: input.referenceId,
          balanceAfter: balance.eruBalance,
        },
      };
    },
  };

  return {
    user, ring, balance, calls, operations,
    debitCount: () => debitCount,
    eruDebitCount: () => eruDebitCount,
    service: new CopperLevelUpService(
      repository as unknown as CopperRingRepository,
      ledger as unknown as LedgerService,
      eruLedger as unknown as EruLedgerService,
    ),
  };
}

describe('CopperLevelUpService transactional mutation', () => {
  it('debits exact ERT once, grants four unspent points, advances once, and preserves attributes', async () => {
    const state = fixture();
    const body = request();
    const result = await state.service.levelUp(state.user, state.ring.id, body) as Record<string, any>;

    assert.equal(state.ring.level, 2);
    assert.equal(state.ring.comfort, 20);
    assert.equal(state.ring.unspentAttributePoints, 4);
    assert.equal(state.balance.ertBalance, '88');
    assert.equal(state.balance.lifetimeSpentErt, '12');
    assert.equal(state.debitCount(), 1);
    assert.equal(result.rulesVersion, COPPER_LEVEL_UP_VERSION);
    assert.deepEqual(result.level, { previous: 1, current: 2 });
    assert.deepEqual(result.unspentAttributePoints, { previous: 0, granted: 4, current: 4 });
    assert.deepEqual(result.attributes, { comfort: 20, charm: 7, quality: 11, luck: 2 });
    assert.deepEqual(result.cost, {
      ert: 12, ertExact: '12', ertDisplay: '12.00',
      eru: 0, eruExact: '0', eruDisplay: '0.00',
    });
    assert.deepEqual(result.balances, {
      ertBefore: 100,
      ertBeforeExact: '100',
      ertBeforeDisplay: '100.00',
      ertAfter: 88,
      ertAfterExact: '88',
      ertAfterDisplay: '88.00',
      eruBefore: 100,
      eruBeforeExact: '100',
      eruBeforeDisplay: '100.00',
      eruAfter: 100,
      eruAfterExact: '100',
      eruAfterDisplay: '100.00',
    });
    assert.deepEqual(result.ledgerTransactionIds, {
      ert: result.ledgerTransactionId,
      eru: null,
    });
    assert.deepEqual(state.calls, ['owner', 'operation', 'ring', 'balance', 'debit', 'save-ring', 'event', 'complete']);
  });

  it('returns the stored response for the same key and fingerprint without a second debit', async () => {
    const state = fixture();
    const body = request();
    const first = await state.service.levelUp(state.user, state.ring.id, body);
    const second = await state.service.levelUp(state.user, state.ring.id, body);

    assert.deepEqual(second, first);
    assert.equal(state.debitCount(), 1);
    assert.equal(state.calls.filter((call) => call === 'ring').length, 1);
  });

  it('rejects reuse of a key for a different transition before any second economy lock', async () => {
    const state = fixture();
    const key = randomUUID();
    await state.service.levelUp(state.user, state.ring.id, request(key));

    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request(key, {
        expectedCurrentLevel: 2,
        targetLevel: 3,
      })),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.IdempotencyConflict,
    );
    assert.equal(state.debitCount(), 1);
  });

  it('rejects level 4 to 5 when ERU is insufficient before either debit', async () => {
    const state = fixture({ level: 4, eru: '29' });
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request(randomUUID(), {
        expectedCurrentLevel: 4,
        targetLevel: 5,
      })),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.InsufficientEru,
    );
    assert.equal(state.debitCount(), 0);
    assert.equal(state.eruDebitCount(), 0);
    assert.equal(state.balance.ertBalance, '100');
    assert.equal(state.balance.eruBalance, '29');
    assert.equal(state.calls.includes('balance'), true);
  });

  it('atomically debits ERT and ERU for level 4 to 5 and replays both receipts once', async () => {
    const state = fixture({ level: 4, eru: '30' });
    const body = request(randomUUID(), { expectedCurrentLevel: 4, targetLevel: 5 });
    const first = await state.service.levelUp(state.user, state.ring.id, body) as Record<string, any>;
    const replay = await state.service.levelUp(state.user, state.ring.id, body);

    assert.deepEqual(replay, first);
    assert.equal(state.ring.level, 5);
    assert.equal(state.balance.ertBalance, '76');
    assert.equal(state.balance.eruBalance, '0');
    assert.equal(state.balance.lifetimeSpentEru, '30');
    assert.equal(state.debitCount(), 1);
    assert.equal(state.eruDebitCount(), 1);
    assert.deepEqual(first.cost, {
      ert: 24, ertExact: '24', ertDisplay: '24.00',
      eru: 30, eruExact: '30', eruDisplay: '30.00',
    });
    assert.equal(first.balances.eruBeforeExact, '30');
    assert.equal(first.balances.eruAfterExact, '0');
    assert.equal(typeof first.ledgerTransactionIds.ert, 'string');
    assert.equal(typeof first.ledgerTransactionIds.eru, 'string');
  });

  it('rolls back an ERT debit when the ERU ledger fails before ring persistence', async () => {
    const state = fixture({ level: 4, eru: '30', failEruDebit: true });
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request(randomUUID(), {
        expectedCurrentLevel: 4,
        targetLevel: 5,
      })),
      /injected ERU debit failure/,
    );
    assert.equal(state.ring.level, 4);
    assert.equal(state.balance.ertBalance, '100');
    assert.equal(state.balance.lifetimeSpentErt, '0');
    assert.equal(state.balance.eruBalance, '30');
    assert.equal(state.balance.lifetimeSpentEru, '0');
    assert.equal(state.operations.size, 0);
  });

  it('rejects insufficient ERT without ledger, ring, event, or completed operation changes', async () => {
    const state = fixture({ ert: 11 });
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request()),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.InsufficientErt,
    );
    assert.equal(state.debitCount(), 0);
    assert.equal(state.ring.level, 1);
    assert.equal(state.balance.ertBalance, '11');
    assert.equal(state.operations.size, 0);
  });

  it('rolls back debit and ring changes when immutable audit persistence fails', async () => {
    const state = fixture({ failEvent: true });
    await assert.rejects(state.service.levelUp(state.user, state.ring.id, request()), /injected audit failure/);
    assert.equal(state.ring.level, 1);
    assert.equal(state.ring.comfort, 20);
    assert.equal(state.ring.unspentAttributePoints, 0);
    assert.equal(state.balance.ertBalance, '100');
    assert.equal(state.balance.lifetimeSpentErt, '0');
    assert.equal(state.operations.size, 0);
  });

  it('preserves an 18-place fractional remainder through affordability, debit, and replay', async () => {
    const state = fixture({ ert: '12.000000000000000001' });
    const body = request();

    const first = await state.service.levelUp(state.user, state.ring.id, body) as Record<string, any>;
    const replay = await state.service.levelUp(state.user, state.ring.id, body);

    assert.equal(state.balance.ertBalance, '0.000000000000000001');
    assert.equal(first.balances.ertBeforeExact, '12.000000000000000001');
    assert.equal(first.balances.ertAfterExact, '0.000000000000000001');
    assert.equal(first.balances.ertAfterDisplay, '0.00');
    assert.deepEqual(replay, first);
    assert.equal(state.debitCount(), 1);
  });

  it('rejects an 18-place balance below the integer price without a debit', async () => {
    const state = fixture({ ert: '11.999999999999999999' });
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request()),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.InsufficientErt,
    );
    assert.equal(state.balance.ertBalance, '11.999999999999999999');
    assert.equal(state.debitCount(), 0);
  });

  it('rejects malformed idempotency and obsolete v1 allocation before opening a transaction', async () => {
    const state = fixture();
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request('not-a-uuid')),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.MutationRequestInvalid,
    );
    await assert.rejects(
      state.service.levelUp(state.user, state.ring.id, request(randomUUID(), {
        allocation: { comfort: 4, charm: 0, quality: 0, luck: 0 },
      })),
      (error) => errorCode(error).code === CopperLevelUpErrorCode.MutationRequestInvalid,
    );
    assert.deepEqual(state.calls, []);
  });
});
