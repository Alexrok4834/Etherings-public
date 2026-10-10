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
import { canonicalEru } from '../src/balance/eru-decimal';
import { EruLedgerErrorCode } from '../src/balance/eru-ledger.errors';
import { LedgerTransactionType } from '../src/balance/ledger-transaction.entity';
import { RAFFLE_V2_CONSOLIDATION_MANIFEST } from '../src/raffle/raffle-v2-consolidation-manifest';

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
    await assertCurrentSchema(runner);
    await assertWholeConfiguredEconomy(runner);

    const service = new EruLedgerService(dataSource);
    const firstUserId = await createUser(runner, 'eru-decimal-reconciliation-1');
    const secondUserId = await createUser(runner, 'eru-decimal-reconciliation-2');
    const draw = await createLegacyDraw(runner, firstUserId, '1.234567890123456789');
    const credit = {
      userId: firstUserId,
      amount: '1.234567890123456789',
      type: LedgerTransactionType.RaffleReward as const,
      referenceType: ERU_RAFFLE_REWARD_REFERENCE,
      referenceId: draw.drawId,
      metadata: { rewardId: draw.rewardId, qa: 'decimal-reconciliation' },
    };

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => service.credit(credit)));
    assert.equal(new Set(concurrent.map((receipt) => receipt.ledgerTransaction.id)).size, 1);
    assert.equal(concurrent.filter((receipt) => !receipt.replayed).length, 1);
    const firstReceipt = concurrent[0].ledgerTransaction;
    assert.equal(firstReceipt.amount, credit.amount);
    assert.equal(firstReceipt.balanceAfter, credit.amount);
    await insertUserReward(runner, firstUserId, draw, firstReceipt.amount, firstReceipt.balanceAfter);

    const replay = await service.credit(credit);
    assert.equal(replay.replayed, true);
    assert.equal(replay.ledgerTransaction.id, firstReceipt.id);
    await assertEruError(service.credit({ ...credit, amount: '1.234567890123456788' }), EruLedgerErrorCode.IdempotencyConflict);

    const debitAmount = '0.234567890123456789';
    const debitReferenceId = randomUUID();
    const debit = await service.debit({
      userId: firstUserId,
      amount: debitAmount,
      type: LedgerTransactionType.CopperLevelUpSpend,
      referenceType: ERU_COPPER_LEVEL_UP_REFERENCE,
      referenceId: debitReferenceId,
      metadata: { targetLevel: 5, qa: 'decimal-reconciliation' },
    });
    assert.equal(debit.ledgerTransaction.amount, `-${debitAmount}`);
    assert.equal(debit.ledgerTransaction.balanceAfter, '1');
    assert.equal((await service.debit({
      userId: firstUserId,
      amount: debitAmount,
      type: LedgerTransactionType.CopperLevelUpSpend,
      referenceType: ERU_COPPER_LEVEL_UP_REFERENCE,
      referenceId: debitReferenceId,
      metadata: { targetLevel: 5, qa: 'decimal-reconciliation' },
    })).replayed, true);

    const secondCredit = await service.credit({
      ...credit,
      userId: secondUserId,
      amount: '2.005',
      referenceId: randomUUID(),
      metadata: { qa: 'global-reconciliation' },
    });
    assert.equal(secondCredit.ledgerTransaction.balanceAfter, '2.005');

    const rollbackReferenceId = randomUUID();
    await assert.rejects(dataSource.transaction(async (manager) => {
      await service.creditInTransaction(manager, {
        ...credit,
        amount: '0.000000000000000001',
        referenceId: rollbackReferenceId,
        metadata: { qa: 'injected-rollback' },
      });
      throw new Error('injected rollback');
    }), /injected rollback/);
    assert.equal(await referenceCount(runner, rollbackReferenceId), 0);

    assert.deepEqual(await accountState(runner, firstUserId), {
      balance: '1', earned: credit.amount, spent: debitAmount,
    });
    assert.deepEqual(await userLedgerTotals(runner, firstUserId), {
      signed: '1', credits: credit.amount, debits: debitAmount, rows: 2,
    });
    assert.deepEqual(await accountState(runner, secondUserId), {
      balance: '2.005', earned: '2.005', spent: '0',
    });
    assert.deepEqual(await globalTotals(runner, [firstUserId, secondUserId]), {
      balances: '3.005', signed: '3.005', earned: '3.239567890123456789',
      credits: '3.239567890123456789', spent: debitAmount, debits: debitAmount,
    });
    assert.deepEqual(await raffleEvidence(runner, draw.drawId), {
      rewardAmount: credit.amount,
      rewardBalanceAfter: credit.amount,
      ledgerAmount: credit.amount,
      ledgerBalanceAfter: credit.amount,
    });

    console.log(JSON.stringify({
      database: databaseName,
      migratedDecimalSchema: true,
      configuredEconomyRemainsWhole: true,
      fractionalRaffleEvidenceMatchesLedger: true,
      concurrentCreditExactlyOnce: true,
      replayStableAndConflictRejected: true,
      fractionalDebitExact: true,
      injectedTransactionRolledBack: true,
      userAndGlobalAggregatesReconcile: true,
    }, null, 2));
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

async function assertCurrentSchema(runner: QueryRunner) {
  const [row] = await runner.query(`
    SELECT numeric_precision::int AS precision, numeric_scale::int AS scale
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'balances' AND column_name = 'eru_balance'
  `) as Array<{ precision: number; scale: number }>;
  assert.deepEqual(row, { precision: 48, scale: 18 });
}

async function assertWholeConfiguredEconomy(runner: QueryRunner) {
  const expected = RAFFLE_V2_CONSOLIDATION_MANIFEST.rewards
    .filter((reward) => reward.type === 'ERU')
    .map((reward) => ({ code: reward.code, amount: reward.amountExact }));
  assert.deepEqual(expected, [
    { code: 'raffle-v2-eru-1-v1', amount: '1' },
    { code: 'raffle-v2-eru-5-v1', amount: '5' },
    { code: 'raffle-v2-eru-10-v1', amount: '10' },
    { code: 'raffle-v2-eru-30-v1', amount: '30' },
  ]);
  const rows = await runner.query(`
    SELECT r.code, r.amount_exact::text AS amount
    FROM rewards r
    JOIN raffle_configuration_rewards cr ON cr.reward_id = r.id
    JOIN raffle_configurations c ON c.id = cr.configuration_id
    WHERE c.status = 'ACTIVE' AND r.type = 'ERU'
    ORDER BY cr.segment_index
  `) as Array<{ code: string; amount: string }>;
  if (rows.length > 0) {
    assert.deepEqual(rows.map((row) => ({ code: row.code, amount: canonicalEru(row.amount) })), expected);
  }
}

async function createUser(runner: QueryRunner, telegramId: string) {
  const id = randomUUID();
  await runner.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
    VALUES ($1, $2, $2, 'QA', false, now(), now())
  `, [id, telegramId]);
  return id;
}

async function createLegacyDraw(runner: QueryRunner, userId: string, amount: string) {
  const rewardId = randomUUID();
  const poolId = randomUUID();
  const drawId = randomUUID();
  await runner.query(`
    INSERT INTO rewards (id, code, title, type, amount, amount_exact, is_active, created_at, updated_at)
    VALUES ($1, $2, 'QA fractional ERU', 'ERU', NULL, $3::numeric(48,18), true, now(), now())
  `, [rewardId, `qa-eru-${rewardId}`, amount]);
  await runner.query(`
    INSERT INTO raffle_pools (id, code, title, cost_ert, is_active, created_at, updated_at)
    VALUES ($1, $2, 'QA decimal reconciliation', 5, false, now(), now())
  `, [poolId, `qa-pool-${poolId}`]);
  await runner.query(`
    INSERT INTO raffle_draws (
      id, user_id, pool_id, reward_id, cost_ert, random_roll,
      weights_snapshot, reward_snapshot, created_at
    ) VALUES ($1, $2, $3, $4, 5, 0.5, '{}'::jsonb, $5::jsonb, now())
  `, [drawId, userId, poolId, rewardId, JSON.stringify({ rewardId, type: 'ERU', amountExact: amount })]);
  return { rewardId, drawId };
}

async function insertUserReward(
  runner: QueryRunner,
  userId: string,
  draw: { rewardId: string; drawId: string },
  amount: string,
  balanceAfter: string,
) {
  await runner.query(`
    INSERT INTO user_rewards (
      id, user_id, reward_id, raffle_draw_id, title, type, amount,
      amount_exact, eru_balance_after, metadata, created_at
    ) VALUES ($1, $2, $3, $4, 'QA fractional ERU', 'ERU', NULL,
      $5::numeric(48,18), $6::numeric(48,18), '{}'::jsonb, now())
  `, [randomUUID(), userId, draw.rewardId, draw.drawId, amount, balanceAfter]);
}

async function accountState(runner: QueryRunner, userId: string) {
  const [row] = await runner.query(`
    SELECT eru_balance::text AS balance, lifetime_earned_eru::text AS earned,
      lifetime_spent_eru::text AS spent FROM balances WHERE user_id = $1
  `, [userId]) as Array<Record<'balance' | 'earned' | 'spent', string>>;
  return mapCanonical(row);
}

async function userLedgerTotals(runner: QueryRunner, userId: string) {
  const [row] = await runner.query(`
    SELECT coalesce(sum(amount), 0)::text AS signed,
      coalesce(sum(amount) FILTER (WHERE amount > 0), 0)::text AS credits,
      coalesce(-sum(amount) FILTER (WHERE amount < 0), 0)::text AS debits,
      count(*)::int AS rows
    FROM ledger_transactions WHERE currency = 'ERU' AND user_id = $1
  `, [userId]) as Array<Record<'signed' | 'credits' | 'debits', string> & { rows: number }>;
  return { ...mapCanonical(row), rows: row.rows };
}

async function globalTotals(runner: QueryRunner, userIds: string[]) {
  const [row] = await runner.query(`
    SELECT
      (SELECT coalesce(sum(eru_balance), 0) FROM balances WHERE user_id = ANY($1::uuid[]))::text AS balances,
      (SELECT coalesce(sum(amount), 0) FROM ledger_transactions WHERE currency = 'ERU' AND user_id = ANY($1::uuid[]))::text AS signed,
      (SELECT coalesce(sum(lifetime_earned_eru), 0) FROM balances WHERE user_id = ANY($1::uuid[]))::text AS earned,
      (SELECT coalesce(sum(amount), 0) FROM ledger_transactions WHERE currency = 'ERU' AND amount > 0 AND user_id = ANY($1::uuid[]))::text AS credits,
      (SELECT coalesce(sum(lifetime_spent_eru), 0) FROM balances WHERE user_id = ANY($1::uuid[]))::text AS spent,
      (SELECT coalesce(-sum(amount), 0) FROM ledger_transactions WHERE currency = 'ERU' AND amount < 0 AND user_id = ANY($1::uuid[]))::text AS debits
  `, [userIds]) as Array<Record<string, string>>;
  return mapCanonical(row);
}

async function raffleEvidence(runner: QueryRunner, drawId: string) {
  const [row] = await runner.query(`
    SELECT ur.amount_exact::text AS "rewardAmount",
      ur.eru_balance_after::text AS "rewardBalanceAfter",
      lt.amount::text AS "ledgerAmount", lt.balance_after::text AS "ledgerBalanceAfter"
    FROM user_rewards ur
    JOIN ledger_transactions lt ON lt.currency = 'ERU'
      AND lt.reference_type = 'raffle_draw' AND lt.reference_id = ur.raffle_draw_id::text
    WHERE ur.raffle_draw_id = $1
  `, [drawId]) as Array<Record<string, string>>;
  return mapCanonical(row);
}

async function referenceCount(runner: QueryRunner, referenceId: string) {
  const [row] = await runner.query(`
    SELECT count(*)::int AS count FROM ledger_transactions
    WHERE currency = 'ERU' AND reference_id = $1
  `, [referenceId]) as Array<{ count: number }>;
  return row.count;
}

function mapCanonical<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, typeof value === 'string' ? canonicalEru(value, key) : value,
  ]));
}

async function assertEruError(promise: Promise<unknown>, expectedCode: EruLedgerErrorCode) {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof HttpException)) return false;
    const response = error.getResponse();
    return typeof response === 'object' && response !== null
      && 'code' in response && response.code === expectedCode;
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
