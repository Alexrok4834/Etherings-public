import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { LedgerCurrency, LedgerTransactionType } from './ledger-transaction.entity';
import { eruIdempotencyConflict, insufficientEruBalance } from './eru-ledger.errors';
import { canonicalEru, parseUnsignedEruDecimal } from './eru-decimal';

export const ERU_RAFFLE_REWARD_REFERENCE = 'raffle_draw';
export const ERU_COPPER_LEVEL_UP_REFERENCE = 'copper_level_up_operation';

export type EruCreditInput = {
  userId: string;
  amount: string;
  type: LedgerTransactionType.RaffleReward;
  referenceType: typeof ERU_RAFFLE_REWARD_REFERENCE;
  referenceId: string;
  metadata?: Record<string, unknown> | null;
};

export type EruDebitInput = {
  userId: string;
  amount: string;
  type: LedgerTransactionType.CopperLevelUpSpend;
  referenceType: typeof ERU_COPPER_LEVEL_UP_REFERENCE;
  referenceId: string;
  metadata?: Record<string, unknown> | null;
};

export type EruLedgerReceipt = {
  replayed: boolean;
  ledgerTransaction: {
    id: string;
    userId: string;
    type: LedgerTransactionType;
    currency: LedgerCurrency.Eru;
    amount: string;
    balanceAfter: string;
    referenceType: string;
    referenceId: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  };
};

type PreparedMutation = {
  userId: string;
  amount: string;
  signedAmount: string;
  type: LedgerTransactionType;
  referenceType: string;
  referenceId: string;
  metadata: Record<string, unknown> | null;
  metadataJson: string;
  direction: 'credit' | 'debit';
};

type LockedBalance = {
  eruBalance: string;
};

type ExistingReceiptRow = {
  id: string;
  userId: string;
  type: LedgerTransactionType;
  currency: LedgerCurrency;
  amount: string;
  balanceAfter: string;
  referenceType: string;
  referenceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  matches: boolean;
};

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uniqueReferenceConstraints = new Set([
  'UQ_ledger_copper_level_up_reference',
  'UQ_ledger_eru_raffle_reward_reference',
]);

@Injectable()
export class EruLedgerService {
  constructor(private readonly dataSource: DataSource) {}

  async credit(input: EruCreditInput) {
    try {
      return await this.dataSource.transaction((manager) => this.creditInTransaction(manager, input));
    } catch (error) {
      if (this.isReferenceUniqueViolation(error)) throw eruIdempotencyConflict();
      throw error;
    }
  }

  creditInTransaction(manager: EntityManager, input: EruCreditInput) {
    const prepared = this.prepare(input, 'credit');
    return this.apply(manager, prepared);
  }

  async debit(input: EruDebitInput) {
    try {
      return await this.dataSource.transaction((manager) => this.debitInTransaction(manager, input));
    } catch (error) {
      if (this.isReferenceUniqueViolation(error)) throw eruIdempotencyConflict();
      throw error;
    }
  }

  debitInTransaction(manager: EntityManager, input: EruDebitInput) {
    const prepared = this.prepare(input, 'debit');
    return this.apply(manager, prepared);
  }

  private async apply(manager: EntityManager, input: PreparedMutation): Promise<EruLedgerReceipt> {
    await manager.query(`
      INSERT INTO balances (user_id, updated_at)
      VALUES ($1, now())
      ON CONFLICT (user_id) DO NOTHING
    `, [input.userId]);
    const [balance] = await manager.query(`
      SELECT eru_balance::text AS "eruBalance"
      FROM balances WHERE user_id = $1 FOR UPDATE
    `, [input.userId]) as LockedBalance[];
    if (!balance) throw new Error('ERU balance row is unavailable after initialization');

    const existing = await this.findExisting(manager, input);
    if (existing) {
      if (!existing.matches) throw eruIdempotencyConflict();
      return this.toReceipt(existing, true);
    }

    const update = input.direction === 'credit'
      ? `UPDATE balances SET
          eru_balance = eru_balance + $2::numeric(48,18),
          lifetime_earned_eru = lifetime_earned_eru + $2::numeric(48,18),
          updated_at = now()
        WHERE user_id = $1
        RETURNING eru_balance`
      : `UPDATE balances SET
          eru_balance = eru_balance - $2::numeric(48,18),
          lifetime_spent_eru = lifetime_spent_eru + $2::numeric(48,18),
          updated_at = now()
        WHERE user_id = $1 AND eru_balance >= $2::numeric(48,18)
        RETURNING eru_balance`;
    const [created] = await manager.query(`
      WITH updated_balance AS (${update})
      INSERT INTO ledger_transactions (
        user_id, type, currency, amount, balance_after,
        reference_type, reference_id, metadata, created_at
      ) SELECT
        $1, $3, 'ERU', $4::numeric(48,18), updated_balance.eru_balance,
        $5, $6, $7::jsonb, now()
      FROM updated_balance
      RETURNING id, user_id AS "userId", type::text, currency::text,
        amount::text, balance_after::text AS "balanceAfter",
        reference_type AS "referenceType", reference_id AS "referenceId",
        metadata, created_at AS "createdAt"
    `, [
      input.userId,
      input.amount,
      input.type,
      input.signedAmount,
      input.referenceType,
      input.referenceId,
      input.metadataJson,
    ]) as ExistingReceiptRow[];
    if (!created) {
      if (input.direction === 'debit') throw insufficientEruBalance();
      throw new Error('ERU ledger receipt was not persisted');
    }
    return this.toReceipt(created, false);
  }

  private async findExisting(manager: EntityManager, input: PreparedMutation) {
    const [existing] = await manager.query(`
      SELECT id, user_id AS "userId", type::text, currency::text,
        amount::text, balance_after::text AS "balanceAfter",
        reference_type AS "referenceType", reference_id AS "referenceId",
        metadata, created_at AS "createdAt",
        (
          user_id = $1::uuid
          AND type::text = $2
          AND amount = $3::numeric(48,18)
          AND metadata IS NOT DISTINCT FROM $6::jsonb
        ) AS matches
      FROM ledger_transactions
      WHERE currency = 'ERU' AND reference_type = $4 AND reference_id = $5
      LIMIT 1
    `, [
      input.userId,
      input.type,
      input.signedAmount,
      input.referenceType,
      input.referenceId,
      input.metadataJson,
    ]) as ExistingReceiptRow[];
    return existing;
  }

  private prepare(input: EruCreditInput | EruDebitInput, direction: 'credit' | 'debit'): PreparedMutation {
    let amount: string;
    try {
      amount = canonicalEru(input.amount, 'ERU amount');
      parseUnsignedEruDecimal(amount, 'ERU amount', false);
    } catch {
      throw new BadRequestException('ERU amount must be a canonical positive decimal with at most 30 integer and 18 fractional digits');
    }
    if (!uuidV4.test(input.referenceId)) {
      throw new BadRequestException('ERU referenceId must be a UUID v4');
    }
    this.assertPurpose(input, direction);
    const metadata = this.normalizeMetadata(input.metadata);
    return {
      ...input,
      amount,
      signedAmount: direction === 'credit' ? amount : `-${amount}`,
      metadata,
      metadataJson: JSON.stringify(metadata),
      direction,
    };
  }

  private assertPurpose(input: EruCreditInput | EruDebitInput, direction: 'credit' | 'debit') {
    const valid = direction === 'credit'
      ? input.type === LedgerTransactionType.RaffleReward
        && input.referenceType === ERU_RAFFLE_REWARD_REFERENCE
      : input.type === LedgerTransactionType.CopperLevelUpSpend
        && input.referenceType === ERU_COPPER_LEVEL_UP_REFERENCE;
    if (!valid) throw new BadRequestException('Unsupported ERU mutation purpose or reference type');
  }

  private normalizeMetadata(value: Record<string, unknown> | null | undefined) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('ERU metadata must be an object or null');
    }
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('ERU metadata must be JSON serializable');
    }
  }

  private toReceipt(row: ExistingReceiptRow, replayed: boolean): EruLedgerReceipt {
    const amount = row.amount.startsWith('-')
      ? `-${canonicalEru(row.amount.slice(1), 'ledger amount')}`
      : canonicalEru(row.amount, 'ledger amount');
    return {
      replayed,
      ledgerTransaction: {
        id: row.id,
        userId: row.userId,
        type: row.type,
        currency: LedgerCurrency.Eru,
        amount,
        balanceAfter: canonicalEru(row.balanceAfter, 'ledger balanceAfter'),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        metadata: row.metadata,
        createdAt: row.createdAt,
      },
    };
  }

  private isReferenceUniqueViolation(error: unknown) {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = (error as QueryFailedError & {
      driverError?: { code?: string; constraint?: string };
    }).driverError;
    return driverError?.code === '23505'
      && typeof driverError.constraint === 'string'
      && uniqueReferenceConstraints.has(driverError.constraint);
  }
}
