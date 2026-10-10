import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { canonicalErt, ErtDecimal, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { Balance } from './balance.entity';
import { LedgerTransaction, LedgerTransactionType } from './ledger-transaction.entity';

export type LedgerMutationInput = {
  userId: string;
  amount: number;
  type: LedgerTransactionType;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LedgerMutationResult = {
  balance: Balance;
  ledgerTransaction: LedgerTransaction;
};

export type DecimalLedgerCreditInput = Omit<LedgerMutationInput, 'amount'> & {
  amount: string;
};

export type DecimalLedgerCreditResult = {
  balance: {
    ertBalance: string;
    lifetimeEarnedErt: string;
    lifetimeSpentErt: string;
  };
  ledgerTransaction: {
    id: string;
    amount: string;
    balanceAfter: string;
  };
};

export type DecimalLedgerDebitInput = Omit<LedgerMutationInput, 'amount'> & {
  amount: string;
};

export type DecimalLedgerDebitResult = {
  balance: {
    ertBalance: string;
    lifetimeEarnedErt: string;
    lifetimeSpentErt: string;
  };
  ledgerTransaction: {
    id: string;
    amount: string;
    balanceAfter: string;
  };
};

@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  getBalance(userId: string) {
    return this.dataSource.getRepository(Balance).findOne({ where: { userId } });
  }

  ensureBalance(userId: string) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`
        INSERT INTO balances (user_id, updated_at)
        VALUES ($1, now())
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);
      const balance = await manager.getRepository(Balance).findOne({ where: { userId } });
      if (!balance) throw new Error('Balance row is unavailable after initialization');
      return balance;
    });
  }

  credit(input: LedgerMutationInput) {
    this.assertPositiveAmount(input.amount);

    return this.dataSource.transaction((manager) => this.applyCredit(manager, input));
  }

  creditInTransaction(manager: EntityManager, input: LedgerMutationInput) {
    this.assertPositiveAmount(input.amount);

    return this.applyCredit(manager, input);
  }

  debit(input: LedgerMutationInput) {
    this.assertPositiveAmount(input.amount);

    return this.dataSource.transaction((manager) => this.applyDebit(manager, input));
  }

  debitInTransaction(manager: EntityManager, input: LedgerMutationInput) {
    this.assertPositiveAmount(input.amount);

    return this.applyDebit(manager, input);
  }

  private async applyCredit(manager: EntityManager, input: LedgerMutationInput): Promise<LedgerMutationResult> {
    const balance = await this.getOrCreateBalance(manager, input.userId);
    balance.ertBalance += input.amount;
    balance.lifetimeEarnedErt += input.amount;

    const savedBalance = await manager.getRepository(Balance).save(balance);
    const ledgerTransaction = await this.createLedgerTransaction(manager, input, input.amount, savedBalance.ertBalance);

    return { balance: savedBalance, ledgerTransaction };
  }

  async creditDecimalInTransaction(
    manager: EntityManager,
    input: DecimalLedgerCreditInput,
  ): Promise<DecimalLedgerCreditResult> {
    const amount = canonicalErt(parseUnsignedErtDecimal(input.amount, 'amount', false));
    await manager.query(`
      INSERT INTO balances (
        user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert, updated_at
      ) VALUES ($1, 0, 0, 0, now())
      ON CONFLICT (user_id) DO NOTHING
    `, [input.userId]);
    const [current] = await manager.query(`
      SELECT ert_balance::text AS "ertBalance",
        lifetime_earned_ert::text AS "lifetimeEarnedErt",
        lifetime_spent_ert::text AS "lifetimeSpentErt"
      FROM balances WHERE user_id = $1 FOR UPDATE
    `, [input.userId]);
    if (!current) throw new Error('ERT balance row is unavailable after initialization');

    const ertBalance = canonicalErt(parseUnsignedErtDecimal(current.ertBalance, 'ertBalance').plus(amount));
    const lifetimeEarnedErt = canonicalErt(
      parseUnsignedErtDecimal(current.lifetimeEarnedErt, 'lifetimeEarnedErt').plus(amount),
    );
    const lifetimeSpentErt = canonicalErt(
      parseUnsignedErtDecimal(current.lifetimeSpentErt, 'lifetimeSpentErt'),
    );
    await manager.query(`
      UPDATE balances SET ert_balance = $2::numeric(48,18),
        lifetime_earned_ert = $3::numeric(48,18), updated_at = now()
      WHERE user_id = $1
    `, [input.userId, ertBalance, lifetimeEarnedErt]);
    const [ledgerTransaction] = await manager.query(`
      INSERT INTO ledger_transactions (
        user_id, type, amount, balance_after, reference_type, reference_id, metadata, created_at
      ) VALUES ($1, $2, $3::numeric(48,18), $4::numeric(48,18), $5, $6, $7::jsonb, now())
      RETURNING id, amount::text AS amount, balance_after::text AS "balanceAfter"
    `, [
      input.userId,
      input.type,
      amount,
      ertBalance,
      input.referenceType ?? null,
      input.referenceId ?? null,
      JSON.stringify(input.metadata ?? null),
    ]);

    return {
      balance: { ertBalance, lifetimeEarnedErt, lifetimeSpentErt },
      ledgerTransaction: {
        id: ledgerTransaction.id,
        amount: canonicalErt(ledgerTransaction.amount),
        balanceAfter: canonicalErt(ledgerTransaction.balanceAfter),
      },
    };
  }

  creditDecimal(input: DecimalLedgerCreditInput) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.creditDecimalInTransaction(manager, input);
      return this.attachPublicMutationTimestamps(manager, input.userId, result);
    });
  }

  async debitDecimalInTransaction(
    manager: EntityManager,
    input: DecimalLedgerDebitInput,
  ): Promise<DecimalLedgerDebitResult> {
    const amount = canonicalErt(parseUnsignedErtDecimal(input.amount, 'amount', false));
    const [current] = await manager.query(`
      SELECT ert_balance::text AS "ertBalance",
        lifetime_earned_ert::text AS "lifetimeEarnedErt",
        lifetime_spent_ert::text AS "lifetimeSpentErt"
      FROM balances WHERE user_id = $1 FOR UPDATE
    `, [input.userId]);
    if (!current) throw new Error('ERT balance is unavailable');

    const currentBalance = parseUnsignedErtDecimal(current.ertBalance, 'ertBalance');
    if (currentBalance.lessThan(amount)) {
      throw new BadRequestException('Insufficient ERT balance');
    }
    const ertBalance = canonicalErt(currentBalance.minus(amount));
    const lifetimeEarnedErt = canonicalErt(
      parseUnsignedErtDecimal(current.lifetimeEarnedErt, 'lifetimeEarnedErt'),
    );
    const lifetimeSpentErt = canonicalErt(
      parseUnsignedErtDecimal(current.lifetimeSpentErt, 'lifetimeSpentErt').plus(amount),
    );
    await manager.query(`
      UPDATE balances SET ert_balance = $2::numeric(48,18),
        lifetime_spent_ert = $3::numeric(48,18), updated_at = now()
      WHERE user_id = $1
    `, [input.userId, ertBalance, lifetimeSpentErt]);
    const signedAmount = canonicalErt(new ErtDecimal(amount).negated());
    const [ledgerTransaction] = await manager.query(`
      INSERT INTO ledger_transactions (
        user_id, type, amount, balance_after, reference_type, reference_id, metadata, created_at
      ) VALUES ($1, $2, $3::numeric(48,18), $4::numeric(48,18), $5, $6, $7::jsonb, now())
      RETURNING id, amount::text AS amount, balance_after::text AS "balanceAfter"
    `, [
      input.userId,
      input.type,
      signedAmount,
      ertBalance,
      input.referenceType ?? null,
      input.referenceId ?? null,
      JSON.stringify(input.metadata ?? null),
    ]);

    return {
      balance: { ertBalance, lifetimeEarnedErt, lifetimeSpentErt },
      ledgerTransaction: {
        id: ledgerTransaction.id,
        amount: canonicalErt(ledgerTransaction.amount),
        balanceAfter: canonicalErt(ledgerTransaction.balanceAfter),
      },
    };
  }

  debitDecimal(input: DecimalLedgerDebitInput) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.debitDecimalInTransaction(manager, input);
      return this.attachPublicMutationTimestamps(manager, input.userId, result);
    });
  }

  private async attachPublicMutationTimestamps(
    manager: EntityManager,
    userId: string,
    result: DecimalLedgerCreditResult | DecimalLedgerDebitResult,
  ) {
    const [timestamps] = await manager.query(`
      SELECT b.updated_at AS "balanceUpdatedAt", l.created_at AS "ledgerCreatedAt"
      FROM balances b
      JOIN ledger_transactions l ON l.id = $2
      WHERE b.user_id = $1
    `, [userId, result.ledgerTransaction.id]);
    if (!timestamps) throw new Error('ERT mutation timestamps are unavailable');
    return {
      balance: { ...result.balance, updatedAt: timestamps.balanceUpdatedAt as Date },
      ledgerTransaction: { ...result.ledgerTransaction, createdAt: timestamps.ledgerCreatedAt as Date },
    };
  }

  private async applyDebit(manager: EntityManager, input: LedgerMutationInput): Promise<LedgerMutationResult> {
    const balance = await this.getOrCreateBalance(manager, input.userId);

    if (balance.ertBalance < input.amount) {
      throw new BadRequestException('Insufficient ERT balance');
    }

    balance.ertBalance -= input.amount;
    balance.lifetimeSpentErt += input.amount;

    const savedBalance = await manager.getRepository(Balance).save(balance);
    const ledgerTransaction = await this.createLedgerTransaction(manager, input, -input.amount, savedBalance.ertBalance);

    return { balance: savedBalance, ledgerTransaction };
  }

  private async getOrCreateBalance(manager: EntityManager, userId: string) {
    const repository = manager.getRepository(Balance);
    const existingBalance = await repository.findOne({ where: { userId } });

    if (existingBalance) {
      return existingBalance;
    }

    return repository.create({
      userId,
      ertBalance: 0,
      lifetimeEarnedErt: 0,
      lifetimeSpentErt: 0,
    });
  }

  private createLedgerTransaction(
    manager: EntityManager,
    input: LedgerMutationInput,
    amount: number,
    balanceAfter: number,
  ) {
    const repository = manager.getRepository(LedgerTransaction);
    const ledgerTransaction = repository.create({
      userId: input.userId,
      type: input.type,
      amount,
      balanceAfter,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      metadata: input.metadata ?? null,
    });

    return repository.save(ledgerTransaction);
  }

  private assertPositiveAmount(amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer');
    }
  }
}
