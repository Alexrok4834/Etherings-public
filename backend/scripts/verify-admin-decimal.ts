import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AdminAuditService } from '../src/admin/admin-audit.service';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerTransaction } from '../src/balance/ledger-transaction.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { RaffleDraw } from '../src/raffle/raffle-draw.entity';
import { RafflePoolReward } from '../src/raffle/raffle-pool-reward.entity';
import { RafflePool } from '../src/raffle/raffle-pool.entity';
import { Reward, RewardType } from '../src/raffle/reward.entity';
import { UserReward } from '../src/raffle/user-reward.entity';
import { DailyUserStats } from '../src/walk/daily-user-stats.entity';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [
    User, Balance, LedgerTransaction, DailyUserStats, Reward, RafflePool,
    RafflePoolReward, RaffleDraw, UserReward,
  ],
});
const service = new AdminAuditService(
  dataSource.getRepository(RaffleDraw),
  dataSource.getRepository(User),
  new LedgerService(dataSource),
);
const userIds: string[] = [];
const poolIds: string[] = [];
const rewardIds: string[] = [];

async function main() {
  await dataSource.initialize();
  try {
    await assertSchemaReady();
    const user = await seedUserWithBalance('10.000000000000000001');
    await verifyExactAdjustmentAndCompatibility(user);
    await verifyInsufficientAdjustmentRollback(user);
    await verifyDrawAuditProjection(user);
    console.log(JSON.stringify({
      database: databaseName,
      exactAdminAdjustmentPreservesFractionalRemainder: true,
      compatibilityAndExactResponseFields: true,
      insufficientAdjustmentFullRollback: true,
      historicalDrawExactProjection: true,
    }, null, 2));
  } finally {
    await cleanup();
    await dataSource.destroy();
  }
}

async function assertSchemaReady() {
  const [row] = await dataSource.query(`
    SELECT to_regclass('public.balances') AS balances,
      to_regclass('public.ledger_transactions') AS ledger,
      to_regclass('public.raffle_draws') AS draws
  `);
  assert.ok(row.balances && row.ledger && row.draws, 'Admin/accounting migrations are not applied');
}

async function verifyExactAdjustmentAndCompatibility(user: User) {
  const debit = await service.adjustBalance({ userId: user.id, amount: -10, reason: 'Admin decimal QA debit' });
  assert.equal(debit.balance.ertBalanceExact, '0.000000000000000001');
  assert.equal(debit.balance.ertBalanceDisplay, '0.00');
  assert.equal(debit.ledgerTransaction.amountExact, '-10');
  assert.equal(debit.ledgerTransaction.amount, -10);
  assert.equal(debit.ledgerTransaction.balanceAfterExact, '0.000000000000000001');

  const credit = await service.adjustBalance({ userId: user.id, amount: 25, reason: 'Admin decimal QA credit' });
  assert.equal(credit.balance.ertBalanceExact, '25.000000000000000001');
  assert.equal(credit.balance.ertBalanceDisplay, '25.00');
  assert.equal(credit.ledgerTransaction.amountExact, '25');

  const [state] = await dataSource.query(`
    SELECT ert_balance::text AS balance, lifetime_earned_ert::text AS earned,
      lifetime_spent_ert::text AS spent
    FROM balances WHERE user_id = $1
  `, [user.id]);
  assert.deepEqual(state, {
    balance: '25.000000000000000001',
    earned: '35.000000000000000001',
    spent: '10.000000000000000000',
  });
}

async function verifyInsufficientAdjustmentRollback(user: User) {
  const [{ ledgerBefore }] = await dataSource.query(
    'SELECT COUNT(*)::int AS "ledgerBefore" FROM ledger_transactions WHERE user_id = $1',
    [user.id],
  );
  await assert.rejects(
    service.adjustBalance({ userId: user.id, amount: -26, reason: 'Must roll back' }),
    /Insufficient ERT balance/,
  );
  const [state] = await dataSource.query(`
    SELECT b.ert_balance::text AS balance,
      (SELECT COUNT(*)::int FROM ledger_transactions WHERE user_id = $1) AS ledger
    FROM balances b WHERE b.user_id = $1
  `, [user.id]);
  assert.deepEqual(state, { balance: '25.000000000000000001', ledger: ledgerBefore });
}

async function verifyDrawAuditProjection(user: User) {
  const reward = await dataSource.getRepository(Reward).save(Object.assign(new Reward(), {
    code: `admin-qa-${randomUUID()}`,
    title: 'Admin QA ERT reward',
    description: null,
    type: RewardType.Ert,
    amount: 25,
    metadata: null,
    imageUrl: null,
    isActive: true,
    stockTotal: null,
    stockRemaining: null,
    perUserLimit: null,
    dailyGlobalLimit: null,
  }));
  rewardIds.push(reward.id);
  const pool = await dataSource.getRepository(RafflePool).save(Object.assign(new RafflePool(), {
    code: `admin-qa-${randomUUID()}`,
    title: 'Admin QA pool',
    description: null,
    costErt: 5,
    isActive: true,
    dailyUserAttemptLimit: null,
  }));
  poolIds.push(pool.id);
  const draw = await dataSource.getRepository(RaffleDraw).save(Object.assign(new RaffleDraw(), {
    userId: user.id,
    poolId: pool.id,
    rewardId: reward.id,
    costErt: 5,
    randomRoll: 0.5,
    weightsSnapshot: { totalWeight: 1 },
    rewardSnapshot: { type: RewardType.Ert, amount: 25 },
  }));

  const draws = await service.listRaffleDraws();
  const result = draws.find((item) => item.id === draw.id);
  assert.ok(result);
  assert.equal(result.costErtExact, '5');
  assert.equal(result.costErtDisplay, '5.00');
  assert.equal(result.rewardSnapshot.amountExact, '25');
  assert.equal(result.rewardSnapshot.amountDisplay, '25.00');
}

async function seedUserWithBalance(initialErt: string) {
  const user = await dataSource.getRepository(User).save(Object.assign(new User(), {
    id: randomUUID(),
    telegramId: `admin-qa-${randomUUID()}`,
    username: `admin_qa_${randomUUID().replaceAll('-', '')}`,
    firstName: 'Admin QA',
    lastName: null,
    photoUrl: null,
    isAdmin: true,
    lastLoginAt: null,
  }));
  userIds.push(user.id);
  await dataSource.query(`
    INSERT INTO balances (user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert, updated_at)
    VALUES ($1, $2::numeric(48,18), $2::numeric(48,18), 0, now())
  `, [user.id, initialErt]);
  return user;
}

async function cleanup() {
  if (!dataSource.isInitialized) return;
  if (userIds.length > 0) await dataSource.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  if (poolIds.length > 0) await dataSource.query('DELETE FROM raffle_pools WHERE id = ANY($1::uuid[])', [poolIds]);
  if (rewardIds.length > 0) await dataSource.query('DELETE FROM rewards WHERE id = ANY($1::uuid[])', [rewardIds]);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
