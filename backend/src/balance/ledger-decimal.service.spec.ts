import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, EntityManager } from 'typeorm';
import { LedgerTransactionType } from './ledger-transaction.entity';
import { LedgerService } from './ledger.service';

describe('LedgerService decimal credit boundary', () => {
  it('opens a transaction for the public exact-credit boundary', async () => {
    const timestamp = new Date('2026-06-22T00:00:00.000Z');
    const manager = {
      async query() {
        return [{ balanceUpdatedAt: timestamp, ledgerCreatedAt: timestamp }];
      },
    } as unknown as EntityManager;
    let receivedManager: EntityManager | null = null;
    const dataSource = {
      transaction(callback: (value: EntityManager) => Promise<unknown>) {
        return callback(manager);
      },
    } as DataSource;
    const ledger = new LedgerService(dataSource);
    ledger.creditDecimalInTransaction = async (value) => {
      receivedManager = value;
      return {
        balance: { ertBalance: '1', lifetimeEarnedErt: '1', lifetimeSpentErt: '0' },
        ledgerTransaction: { id: 'ledger-1', amount: '1', balanceAfter: '1' },
      };
    };

    const result = await ledger.creditDecimal({
      userId: 'user-1', amount: '1', type: LedgerTransactionType.AdminAdjustment,
    });

    assert.equal(receivedManager, manager);
    assert.equal(result.balance.ertBalance, '1');
    assert.equal(result.balance.updatedAt, timestamp);
    assert.equal(result.ledgerTransaction.createdAt, timestamp);
  });

  it('rejects non-canonical, zero, numeric, and excess-scale inputs before SQL', async () => {
    let queries = 0;
    const manager = {
      async query() {
        queries += 1;
        throw new Error('SQL must not run');
      },
    } as unknown as EntityManager;
    const ledger = new LedgerService({} as DataSource);

    for (const amount of [0, '0', '1e-3', '01', '0.0000000000000000001']) {
      await assert.rejects(() => ledger.creditDecimalInTransaction(manager, {
        userId: 'user-1',
        amount: amount as string,
        type: LedgerTransactionType.WalkReward,
      }));
    }
    assert.equal(queries, 0);
  });
});

describe('LedgerService decimal debit boundary', () => {
  it('opens a transaction for the public exact-debit boundary', async () => {
    const timestamp = new Date('2026-06-22T00:00:00.000Z');
    const manager = {
      async query() {
        return [{ balanceUpdatedAt: timestamp, ledgerCreatedAt: timestamp }];
      },
    } as unknown as EntityManager;
    let receivedManager: EntityManager | null = null;
    const dataSource = {
      transaction(callback: (value: EntityManager) => Promise<unknown>) {
        return callback(manager);
      },
    } as DataSource;
    const ledger = new LedgerService(dataSource);
    ledger.debitDecimalInTransaction = async (value) => {
      receivedManager = value;
      return {
        balance: { ertBalance: '1', lifetimeEarnedErt: '2', lifetimeSpentErt: '1' },
        ledgerTransaction: { id: 'ledger-1', amount: '-1', balanceAfter: '1' },
      };
    };

    const result = await ledger.debitDecimal({
      userId: 'user-1', amount: '1', type: LedgerTransactionType.AdminAdjustment,
    });

    assert.equal(receivedManager, manager);
    assert.equal(result.ledgerTransaction.amount, '-1');
  });

  it('rejects non-canonical, zero, numeric, and excess-scale inputs before SQL', async () => {
    let queries = 0;
    const manager = {
      async query() {
        queries += 1;
        throw new Error('SQL must not run');
      },
    } as unknown as EntityManager;
    const ledger = new LedgerService({} as DataSource);

    for (const amount of [0, '0', '1e-3', '01', '0.0000000000000000001']) {
      await assert.rejects(() => ledger.debitDecimalInTransaction(manager, {
        userId: 'user-1',
        amount: amount as string,
        type: LedgerTransactionType.CopperLevelUpSpend,
      }));
    }
    assert.equal(queries, 0);
  });

  it('subtracts and persists exact decimal values without a JavaScript number', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const manager = {
      async query(sql: string, parameters: unknown[]) {
        queries.push({ sql, parameters });
        if (sql.includes('SELECT ert_balance')) {
          return [{
            ertBalance: '12.000000000000000001',
            lifetimeEarnedErt: '20.000000000000000001',
            lifetimeSpentErt: '8',
          }];
        }
        if (sql.includes('INSERT INTO ledger_transactions')) {
          return [{ id: 'ledger-1', amount: '-12', balanceAfter: '0.000000000000000001' }];
        }
        return [];
      },
    } as unknown as EntityManager;
    const ledger = new LedgerService({} as DataSource);

    const result = await ledger.debitDecimalInTransaction(manager, {
      userId: 'user-1',
      amount: '12',
      type: LedgerTransactionType.CopperLevelUpSpend,
    });

    assert.deepEqual(result.balance, {
      ertBalance: '0.000000000000000001',
      lifetimeEarnedErt: '20.000000000000000001',
      lifetimeSpentErt: '20',
    });
    assert.deepEqual(result.ledgerTransaction, {
      id: 'ledger-1', amount: '-12', balanceAfter: '0.000000000000000001',
    });
    assert.deepEqual(queries[1].parameters, ['user-1', '0.000000000000000001', '20']);
  });
});
