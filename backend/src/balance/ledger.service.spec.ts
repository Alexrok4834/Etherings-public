import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { Balance } from './balance.entity';
import { LedgerTransaction, LedgerTransactionType } from './ledger-transaction.entity';

type StoredBalance = Balance & { updatedAt?: Date };
type StoredLedger = LedgerTransaction & { id?: string; createdAt?: Date };

class FakeRepository<T extends { userId?: string; id?: string }> {
  constructor(
    private readonly store: Map<string, T>,
    private readonly idPrefix: string,
    private readonly beforeSave?: () => void,
  ) {}

  async findOne(options: { where: { userId: string } }) {
    return this.store.get(options.where.userId) ?? null;
  }

  create(input: Partial<T>) {
    return { ...input } as T;
  }

  async save(entity: T) {
    this.beforeSave?.();

    if (entity.userId) {
      this.store.set(entity.userId, entity);
      return entity;
    }

    entity.id = entity.id ?? `${this.idPrefix}-${this.store.size + 1}`;
    this.store.set(entity.id, entity);
    return entity;
  }
}

class FakeEntityManager {
  balances = new Map<string, StoredBalance>();
  ledgerTransactions = new Map<string, StoredLedger>();
  failNextLedgerSave = false;

  getRepository(entity: unknown) {
    if (entity === Balance) {
      return new FakeRepository(this.balances, 'balance');
    }

    if (entity === LedgerTransaction) {
      return new FakeRepository(this.ledgerTransactions, 'ledger', () => {
        if (this.failNextLedgerSave) {
          this.failNextLedgerSave = false;
          throw new Error('Ledger write failed');
        }
      });
    }

    throw new Error('Unknown repository');
  }
}

class FakeDataSource {
  manager = new FakeEntityManager();
  transactions = 0;

  async transaction<T>(callback: (manager: FakeEntityManager) => Promise<T>) {
    this.transactions += 1;
    const balanceSnapshot = new Map(
      Array.from(this.manager.balances, ([key, value]) => [key, { ...value } as StoredBalance]),
    );
    const ledgerSnapshot = new Map(
      Array.from(this.manager.ledgerTransactions, ([key, value]) => [key, { ...value } as StoredLedger]),
    );

    try {
      return await callback(this.manager);
    } catch (error) {
      this.manager.balances = balanceSnapshot;
      this.manager.ledgerTransactions = ledgerSnapshot;
      throw error;
    }
  }
}

function createService() {
  const dataSource = new FakeDataSource();
  const service = new LedgerService(dataSource as never);

  return { dataSource, service };
}

describe('LedgerService', () => {
  it('credits ERT and writes a ledger transaction in a transaction', async () => {
    const { dataSource, service } = createService();

    const result = await service.credit({
      userId: 'user-1',
      amount: 100,
      type: LedgerTransactionType.WalkReward,
      referenceType: 'walk_session',
      referenceId: 'walk-1',
      metadata: { source: 'test' },
    });

    assert.equal(dataSource.transactions, 1);
    assert.equal(result.balance.ertBalance, 100);
    assert.equal(result.balance.lifetimeEarnedErt, 100);
    assert.equal(result.balance.lifetimeSpentErt, 0);
    assert.equal(result.ledgerTransaction.amount, 100);
    assert.equal(result.ledgerTransaction.balanceAfter, 100);
    assert.equal(result.ledgerTransaction.referenceType, 'walk_session');
    assert.deepEqual(result.ledgerTransaction.metadata, { source: 'test' });
  });

  it('debits ERT and writes a negative ledger transaction', async () => {
    const { service } = createService();
    await service.credit({ userId: 'user-1', amount: 100, type: LedgerTransactionType.AdminAdjustment });

    const result = await service.debit({
      userId: 'user-1',
      amount: 35,
      type: LedgerTransactionType.RaffleSpend,
      referenceType: 'raffle_draw',
      referenceId: 'draw-1',
    });

    assert.equal(result.balance.ertBalance, 65);
    assert.equal(result.balance.lifetimeEarnedErt, 100);
    assert.equal(result.balance.lifetimeSpentErt, 35);
    assert.equal(result.ledgerTransaction.amount, -35);
    assert.equal(result.ledgerTransaction.balanceAfter, 65);
  });

  it('rejects debit when balance is insufficient', async () => {
    const { service } = createService();

    await assert.rejects(
      () => service.debit({ userId: 'user-1', amount: 1, type: LedgerTransactionType.RaffleSpend }),
      BadRequestException,
    );
  });

  it('rolls back balance changes when ledger write fails', async () => {
    const { dataSource, service } = createService();

    await service.credit({ userId: 'user-1', amount: 100, type: LedgerTransactionType.AdminAdjustment });
    dataSource.manager.failNextLedgerSave = true;

    await assert.rejects(
      () => service.debit({ userId: 'user-1', amount: 35, type: LedgerTransactionType.RaffleSpend }),
      /Ledger write failed/,
    );

    const balance = dataSource.manager.balances.get('user-1');
    assert.equal(balance?.ertBalance, 100);
    assert.equal(balance?.lifetimeEarnedErt, 100);
    assert.equal(balance?.lifetimeSpentErt, 0);
    assert.equal(dataSource.manager.ledgerTransactions.size, 1);
  });

  it('rolls back created balance when credit ledger write fails', async () => {
    const { dataSource, service } = createService();
    dataSource.manager.failNextLedgerSave = true;

    await assert.rejects(
      () => service.credit({ userId: 'user-1', amount: 25, type: LedgerTransactionType.WalkReward }),
      /Ledger write failed/,
    );

    assert.equal(dataSource.manager.balances.size, 0);
    assert.equal(dataSource.manager.ledgerTransactions.size, 0);
  });
  it('rejects non-positive or non-integer amounts', () => {
    const { service } = createService();

    assert.throws(
      () => service.credit({ userId: 'user-1', amount: 0, type: LedgerTransactionType.AdminAdjustment }),
      BadRequestException,
    );
    assert.throws(
      () => service.credit({ userId: 'user-1', amount: 1.5, type: LedgerTransactionType.AdminAdjustment }),
      BadRequestException,
    );
    assert.throws(
      () => service.debit({ userId: 'user-1', amount: -1, type: LedgerTransactionType.RaffleSpend }),
      BadRequestException,
    );
  });
});