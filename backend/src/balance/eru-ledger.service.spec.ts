import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LedgerCurrency, LedgerTransactionType } from './ledger-transaction.entity';
import {
  ERU_COPPER_LEVEL_UP_REFERENCE,
  ERU_RAFFLE_REWARD_REFERENCE,
  EruCreditInput,
  EruLedgerService,
} from './eru-ledger.service';

const userId = '10000000-0000-4000-8000-000000000001';
const referenceId = '20000000-0000-4000-8000-000000000002';
const createdAt = new Date('2026-08-27T00:00:00.000Z');

describe('EruLedgerService exact decimal boundary', () => {
  it('rejects malformed amounts, references, purposes, and metadata before SQL', async () => {
    let queries = 0;
    const manager = { async query() { queries += 1; } } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);
    const base: EruCreditInput = {
      userId,
      amount: '1',
      type: LedgerTransactionType.RaffleReward as const,
      referenceType: ERU_RAFFLE_REWARD_REFERENCE,
      referenceId,
    };

    for (const amount of [0, '0', '01', '1e3', '-1', '9'.repeat(31), '1.1234567890123456789']) {
      await assert.rejects(async () => service.creditInTransaction(manager, {
        ...base, amount: amount as string,
      }), BadRequestException);
    }
    await assert.rejects(async () => service.creditInTransaction(manager, {
      ...base, referenceId: 'not-a-uuid',
    }), BadRequestException);
    await assert.rejects(async () => service.creditInTransaction(manager, {
      ...base, type: LedgerTransactionType.AdminAdjustment,
    } as unknown as EruCreditInput), BadRequestException);
    await assert.rejects(async () => service.creditInTransaction(manager, {
      ...base, metadata: [] as unknown as Record<string, unknown>,
    }), BadRequestException);
    assert.equal(queries, 0);
  });

  it('credits a fractional amount without binary floating point and canonicalizes the receipt', async () => {
    const queries: string[] = [];
    const manager = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT eru_balance')) return [{ eruBalance: '0.000000000000000000' }];
        if (sql.includes('FROM ledger_transactions')) return [];
        if (sql.includes('WITH updated_balance')) {
          return [receiptRow('1.250000000000000000', '1.250000000000000000')];
        }
        return [];
      },
    } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);

    const result = await service.creditInTransaction(manager, { ...raffleCredit(), amount: '1.250' });

    assert.equal(result.ledgerTransaction.amount, '1.25');
    assert.equal(result.ledgerTransaction.balanceAfter, '1.25');
    assert.ok(queries.some((sql) => sql.includes('$2::numeric(48,18)')));
    assert.ok(queries.some((sql) => sql.includes('$4::numeric(48,18)')));
  });

  it('credits ERU and returns one immutable receipt', async () => {
    const queries: string[] = [];
    const manager = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT eru_balance')) return [{ eruBalance: '0' }];
        if (sql.includes('FROM ledger_transactions')) return [];
        if (sql.includes('WITH updated_balance')) return [receiptRow('100', '100')];
        return [];
      },
    } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);

    const result = await service.creditInTransaction(manager, raffleCredit());

    assert.equal(result.replayed, false);
    assert.deepEqual(result.ledgerTransaction, {
      id: 'ledger-1', userId, type: LedgerTransactionType.RaffleReward,
      currency: LedgerCurrency.Eru, amount: '100', balanceAfter: '100',
      referenceType: ERU_RAFFLE_REWARD_REFERENCE, referenceId,
      metadata: { reason: 'QA' }, createdAt,
    });
    assert.equal(queries.filter((sql) => sql.includes('UPDATE balances')).length, 1);
    assert.equal(queries.filter((sql) => sql.includes('INSERT INTO ledger_transactions')).length, 1);
  });

  it('returns the stored receipt on identical replay without another mutation', async () => {
    const queries: string[] = [];
    const manager = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT eru_balance')) return [{ eruBalance: '999' }];
        if (sql.includes('FROM ledger_transactions')) return [{ ...receiptRow('100', '100'), matches: true }];
        return [];
      },
    } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);

    const result = await service.creditInTransaction(manager, raffleCredit());

    assert.equal(result.replayed, true);
    assert.equal(result.ledgerTransaction.balanceAfter, '100');
    assert.ok(!queries.some((sql) => sql.includes('UPDATE balances')));
    assert.equal(queries.filter((sql) => sql.includes('WITH updated_balance')).length, 0);
  });

  it('rejects a conflicting reference without mutating the balance', async () => {
    const queries: string[] = [];
    const manager = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT eru_balance')) return [{ eruBalance: '100' }];
        if (sql.includes('FROM ledger_transactions')) return [{ ...receiptRow('100', '100'), matches: false }];
        return [];
      },
    } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);

    await assert.rejects(() => service.creditInTransaction(manager, {
      ...raffleCredit(), amount: '101',
    }), ConflictException);
    assert.ok(!queries.some((sql) => sql.includes('UPDATE balances')));
  });

  it('rejects an insufficient debit before ledger persistence', async () => {
    const queries: string[] = [];
    const manager = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT eru_balance')) return [{ eruBalance: '10' }];
        if (sql.includes('FROM ledger_transactions')) return [];
        if (sql.includes('WITH updated_balance')) return [];
        return [];
      },
    } as unknown as EntityManager;
    const service = new EruLedgerService({} as DataSource);

    await assert.rejects(() => service.debitInTransaction(manager, {
      userId,
      amount: '30',
      type: LedgerTransactionType.CopperLevelUpSpend,
      referenceType: ERU_COPPER_LEVEL_UP_REFERENCE,
      referenceId,
    }), BadRequestException);
    assert.equal(queries.filter((sql) => sql.includes('WITH updated_balance')).length, 1);
  });
});

function raffleCredit(): EruCreditInput {
  return {
    userId,
    amount: '100',
    type: LedgerTransactionType.RaffleReward as const,
    referenceType: ERU_RAFFLE_REWARD_REFERENCE,
    referenceId,
    metadata: { reason: 'QA' },
  };
}

function receiptRow(amount: string, balanceAfter: string) {
  return {
    id: 'ledger-1',
    userId,
    type: LedgerTransactionType.RaffleReward,
    currency: LedgerCurrency.Eru,
    amount,
    balanceAfter,
    referenceType: ERU_RAFFLE_REWARD_REFERENCE,
    referenceId,
    metadata: { reason: 'QA' },
    createdAt,
  };
}
