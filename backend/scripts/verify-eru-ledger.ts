import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import {
  ERU_COPPER_LEVEL_UP_REFERENCE,
  ERU_RAFFLE_REWARD_REFERENCE,
  EruLedgerService,
} from '../src/balance/eru-ledger.service';
import { EruLedgerErrorCode } from '../src/balance/eru-ledger.errors';
import { EruBalanceReadService } from '../src/balance/eru-balance-read.service';
import { LedgerTransactionType } from '../src/balance/ledger-transaction.entity';
import { CreateEruAccountingSchema1787443200000 } from '../src/migrations/1787443200000-create-eru-accounting-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await preparePreEruSchema(runner);
    await new CreateEruAccountingSchema1787443200000().up(runner);

    const service = new EruLedgerService(dataSource);
    const userId = await createUser(runner);
    const otherUserId = await createUser(runner);
    const boundaryUserId = await createUser(runner);

    const initialDrawId = randomUUID();
    const initialRaffleCredit = {
      userId,
      amount: '100',
      type: LedgerTransactionType.RaffleReward as const,
      referenceType: ERU_RAFFLE_REWARD_REFERENCE,
      referenceId: initialDrawId,
      metadata: { rewardId: 'concurrency-qa-reward' },
    };
    const concurrentCredits = await Promise.all(
      Array.from({ length: 12 }, () => service.credit(initialRaffleCredit)),
    );
    assert.equal(new Set(concurrentCredits.map((result) => result.ledgerTransaction.id)).size, 1);
    assert.equal(concurrentCredits.filter((result) => !result.replayed).length, 1);
    assert.deepEqual(await balance(runner, userId), {
      current: '100', earned: '100', spent: '0',
    });
    assert.equal(await referenceCount(runner, ERU_RAFFLE_REWARD_REFERENCE, initialDrawId), 1);

    await assertEruError(service.credit({ ...initialRaffleCredit, amount: '101' }), EruLedgerErrorCode.IdempotencyConflict);
    await assertEruError(service.credit({ ...initialRaffleCredit, userId: otherUserId }), EruLedgerErrorCode.IdempotencyConflict);
    assert.equal(await balance(runner, otherUserId), undefined);

    const raffleId = randomUUID();
    const raffle = {
      userId,
      amount: '5',
      type: LedgerTransactionType.RaffleReward as const,
      referenceType: ERU_RAFFLE_REWARD_REFERENCE,
      referenceId: raffleId,
      metadata: { rewardId: 'qa-reward' },
    };
    const raffleFirst = await service.credit(raffle);
    const raffleReplay = await service.credit(raffle);
    assert.equal(raffleFirst.replayed, false);
    assert.equal(raffleReplay.replayed, true);
    assert.equal(raffleReplay.ledgerTransaction.id, raffleFirst.ledgerTransaction.id);

    const levelUpId = randomUUID();
    const levelUp = {
      userId,
      amount: '30',
      type: LedgerTransactionType.CopperLevelUpSpend as const,
      referenceType: ERU_COPPER_LEVEL_UP_REFERENCE,
      referenceId: levelUpId,
      metadata: { targetLevel: 5 },
    };
    const levelUpFirst = await service.debit(levelUp);
    const levelUpReplay = await service.debit(levelUp);
    assert.equal(levelUpFirst.replayed, false);
    assert.equal(levelUpReplay.replayed, true);
    assert.equal(levelUpReplay.ledgerTransaction.balanceAfter, '75');

    const concurrentDebitId = randomUUID();
    const concurrentDebits = await Promise.all(Array.from({ length: 12 }, () => service.debit({
      ...levelUp,
      amount: '20',
      referenceId: concurrentDebitId,
      metadata: { targetLevel: 20 },
    })));
    assert.equal(new Set(concurrentDebits.map((result) => result.ledgerTransaction.id)).size, 1);
    assert.equal(concurrentDebits.filter((result) => !result.replayed).length, 1);

    const insufficientId = randomUUID();
    await assertEruError(service.debit({
      ...levelUp, amount: '1000', referenceId: insufficientId,
    }), EruLedgerErrorCode.InsufficientBalance);
    assert.equal(await referenceCount(runner, ERU_COPPER_LEVEL_UP_REFERENCE, insufficientId), 0);

    const rollbackId = randomUUID();
    await assert.rejects(dataSource.transaction(async (manager) => {
      await service.debitInTransaction(manager, {
        ...levelUp, amount: '10', referenceId: rollbackId,
      });
      throw new Error('injected rollback');
    }), /injected rollback/);
    assert.equal(await referenceCount(runner, ERU_COPPER_LEVEL_UP_REFERENCE, rollbackId), 0);

    assert.deepEqual(await balance(runner, userId), {
      current: '55', earned: '105', spent: '50',
    });
    assert.deepEqual(await reconciliation(runner, userId), {
      signed: '55', credits: '105', debits: '50', rows: '4',
    });
    const readModel = await new EruBalanceReadService(dataSource).getRequired(userId);
    assert.deepEqual({
      current: readModel.eruBalanceExact,
      earned: readModel.lifetimeEarnedEruExact,
      spent: readModel.lifetimeSpentEruExact,
      compatibility: readModel.eruBalance,
    }, { current: '55', earned: '105', spent: '50', compatibility: 55 });

    const maxMutation = '9'.repeat(30);
    await service.credit({ ...initialRaffleCredit, userId: boundaryUserId, amount: maxMutation, referenceId: randomUUID() });
    assert.equal((await balance(runner, boundaryUserId)).current, maxMutation);
    await assert.rejects(service.credit({
      ...initialRaffleCredit, userId: boundaryUserId, amount: '9'.repeat(31), referenceId: randomUUID(),
    }), /at most 30 digits/);

    const maxAggregate = '9'.repeat(48);
    await runner.query(`
      UPDATE balances SET eru_balance = $2::numeric(48,0), lifetime_earned_eru = $2::numeric(48,0)
      WHERE user_id = $1
    `, [boundaryUserId, maxAggregate]);
    const beforeOverflowRows = await userEruLedgerCount(runner, boundaryUserId);
    await assert.rejects(service.credit({
      ...initialRaffleCredit, userId: boundaryUserId, amount: '1', referenceId: randomUUID(),
    }), (error: unknown) => pgCode(error) === '22003');
    assert.equal((await balance(runner, boundaryUserId)).current, maxAggregate);
    assert.equal(await userEruLedgerCount(runner, boundaryUserId), beforeOverflowRows);

    console.log(JSON.stringify({
      database: databaseName,
      concurrentCreditExactlyOnce: true,
      concurrentDebitExactlyOnce: true,
      immutableReplayReceipt: true,
      conflictingReferenceRejected: true,
      insufficientBalanceAtomic: true,
      injectedFailureRolledBack: true,
      aggregateReconcilesWithLedger: true,
      readOnlyExactApiValues: true,
      exactIntegerBoundaryAndOverflow: true,
    }, null, 2));
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

async function preparePreEruSchema(runner: QueryRunner) {
  await runner.query('DROP TABLE IF EXISTS "ledger_transactions" CASCADE');
  await runner.query('DROP TABLE IF EXISTS "balances" CASCADE');
  await runner.query('DROP TABLE IF EXISTS "users" CASCADE');
  await runner.query('DROP TYPE IF EXISTS "public"."ledger_currency_enum"');
  await runner.query('DROP TYPE IF EXISTS "public"."ledger_transactions_type_enum"');
  await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await runner.query('CREATE TABLE users (id uuid PRIMARY KEY)');
  await runner.query(`
    CREATE TYPE "public"."ledger_transactions_type_enum" AS ENUM (
      'WALK_REWARD', 'RAFFLE_SPEND', 'RAFFLE_REWARD', 'ADMIN_ADJUSTMENT',
      'RAFFLE_REFUND', 'COPPER_LEVEL_UP_SPEND'
    )
  `);
  await runner.query(`
    CREATE TABLE balances (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ert_balance numeric(48,18) NOT NULL DEFAULT 0,
      lifetime_earned_ert numeric(48,18) NOT NULL DEFAULT 0,
      lifetime_spent_ert numeric(48,18) NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await runner.query(`
    CREATE TABLE ledger_transactions (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type "public"."ledger_transactions_type_enum" NOT NULL,
      amount numeric(48,18) NOT NULL,
      balance_after numeric(48,18) NOT NULL,
      reference_type varchar(64), reference_id varchar(128), metadata jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await runner.query(`
    CREATE UNIQUE INDEX "UQ_ledger_copper_level_up_reference"
    ON ledger_transactions (reference_type, reference_id)
    WHERE type = 'COPPER_LEVEL_UP_SPEND' AND reference_id IS NOT NULL
  `);
}

async function createUser(runner: QueryRunner) {
  const id = randomUUID();
  await runner.query('INSERT INTO users (id) VALUES ($1)', [id]);
  return id;
}

async function balance(runner: QueryRunner, userId: string) {
  const [row] = await runner.query(`
    SELECT eru_balance::text AS current, lifetime_earned_eru::text AS earned,
      lifetime_spent_eru::text AS spent FROM balances WHERE user_id = $1
  `, [userId]);
  return row as { current: string; earned: string; spent: string };
}

async function reconciliation(runner: QueryRunner, userId: string) {
  const [row] = await runner.query(`
    SELECT coalesce(sum(amount), 0)::numeric(48,0)::text AS signed,
      coalesce(sum(amount) FILTER (WHERE amount > 0), 0)::numeric(48,0)::text AS credits,
      coalesce(-sum(amount) FILTER (WHERE amount < 0), 0)::numeric(48,0)::text AS debits,
      count(*)::text AS rows
    FROM ledger_transactions WHERE user_id = $1 AND currency = 'ERU'
  `, [userId]);
  return row as { signed: string; credits: string; debits: string; rows: string };
}

async function referenceCount(runner: QueryRunner, referenceType: string, referenceId: string) {
  const [row] = await runner.query(`
    SELECT count(*)::int AS count FROM ledger_transactions
    WHERE currency = 'ERU' AND reference_type = $1 AND reference_id = $2
  `, [referenceType, referenceId]);
  return row.count as number;
}

async function userEruLedgerCount(runner: QueryRunner, userId: string) {
  const [row] = await runner.query(`
    SELECT count(*)::int AS count FROM ledger_transactions
    WHERE currency = 'ERU' AND user_id = $1
  `, [userId]);
  return row.count as number;
}

async function assertEruError(promise: Promise<unknown>, expectedCode: EruLedgerErrorCode) {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof HttpException)) return false;
    const response = error.getResponse();
    return typeof response === 'object' && response !== null
      && 'code' in response && response.code === expectedCode;
  });
}

function pgCode(error: unknown) {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('driverError' in error) {
    return (error as { driverError?: { code?: string } }).driverError?.code;
  }
  return 'code' in error ? (error as { code?: string }).code : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
