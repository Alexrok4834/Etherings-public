import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerTransaction } from '../src/balance/ledger-transaction.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { EruLedgerService } from '../src/balance/eru-ledger.service';
import { DailyUserStats } from '../src/walk/daily-user-stats.entity';
import { RaffleDraw } from '../src/raffle/raffle-draw.entity';
import { RafflePoolReward } from '../src/raffle/raffle-pool-reward.entity';
import { RafflePool } from '../src/raffle/raffle-pool.entity';
import { RaffleSelectionService } from '../src/raffle/raffle-selection.service';
import { RaffleService } from '../src/raffle/raffle.service';
import { Reward, RewardType } from '../src/raffle/reward.entity';
import { UserReward } from '../src/raffle/user-reward.entity';

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
const service = new RaffleService(
  dataSource.getRepository(RafflePool),
  dataSource.getRepository(RafflePoolReward),
  new RaffleSelectionService(),
  dataSource,
  new LedgerService(dataSource),
  new EruLedgerService(dataSource),
);
const userIds: string[] = [];
const poolIds: string[] = [];
const rewardIds: string[] = [];

async function main() {
  await dataSource.initialize();
  try {
    await assertSchemaReady();
    await verifyExactDebitWithFractionalRemainder();
    await verifyExactRewardCredit();
    await verifyInsufficientFractionalBalanceRollback();
    console.log(JSON.stringify({
      database: databaseName,
      exactIntegerCostDebitPreservesFractionalRemainder: true,
      exactErtRewardCreditAndResponse: true,
      fractionalInsufficientBalanceFullRollback: true,
    }, null, 2));
  } finally {
    await cleanup();
    await dataSource.destroy();
  }
}

async function assertSchemaReady() {
  const [row] = await dataSource.query(`
    SELECT to_regclass('public.raffle_pools') AS pools,
      to_regclass('public.raffle_draws') AS draws,
      to_regclass('public.ledger_transactions') AS ledger
  `);
  assert.ok(row.pools && row.draws && row.ledger, 'Raffle/accounting migrations are not applied');
}

async function verifyExactDebitWithFractionalRemainder() {
  const fixture = await seedFixture('5.000000000000000001', 5, RewardType.Badge, null);
  const result = await service.drawFromPool(fixture.user, fixture.pool.id, 0.5);
  assert.equal(result.draw.costErtExact, '5');
  assert.equal(result.draw.costErtDisplay, '5.00');
  assert.equal(result.draw.rewardSnapshot.amountExact, null);
  const [state] = await dataSource.query(`
    SELECT b.ert_balance::text AS balance, b.lifetime_spent_ert::text AS spent,
      l.amount::text AS amount, l.balance_after::text AS "balanceAfter"
    FROM balances b
    JOIN ledger_transactions l ON l.user_id = b.user_id AND l.type = 'RAFFLE_SPEND'
    WHERE b.user_id = $1
  `, [fixture.user.id]);
  assert.deepEqual(state, {
    balance: '0.000000000000000001',
    spent: '5.000000000000000000',
    amount: '-5.000000000000000000',
    balanceAfter: '0.000000000000000001',
  });
}

async function verifyExactRewardCredit() {
  const fixture = await seedFixture('0', 0, RewardType.Ert, 25);
  const result = await service.drawFromPool(fixture.user, fixture.pool.id, 0.5);
  assert.equal(result.userReward.amountExact, '25');
  assert.equal(result.userReward.amountDisplay, '25.00');
  assert.equal(result.draw.rewardSnapshot.amountExact, '25');
  assert.equal(result.draw.rewardSnapshot.amountDisplay, '25.00');
  const [state] = await dataSource.query(`
    SELECT b.ert_balance::text AS balance, b.lifetime_earned_ert::text AS earned,
      l.amount::text AS amount, l.balance_after::text AS "balanceAfter"
    FROM balances b
    JOIN ledger_transactions l ON l.user_id = b.user_id AND l.type = 'RAFFLE_REWARD'
    WHERE b.user_id = $1
  `, [fixture.user.id]);
  assert.deepEqual(state, {
    balance: '25.000000000000000000',
    earned: '25.000000000000000000',
    amount: '25.000000000000000000',
    balanceAfter: '25.000000000000000000',
  });
}

async function verifyInsufficientFractionalBalanceRollback() {
  const fixture = await seedFixture('4.999999999999999999', 5, RewardType.Badge, null);
  await assert.rejects(
    service.drawFromPool(fixture.user, fixture.pool.id, 0.5),
    /Insufficient ERT balance/,
  );
  const [state] = await dataSource.query(`
    SELECT b.ert_balance::text AS balance,
      (SELECT COUNT(*)::int FROM raffle_draws WHERE user_id = $1) AS draws,
      (SELECT COUNT(*)::int FROM ledger_transactions WHERE user_id = $1) AS ledger,
      (SELECT COUNT(*)::int FROM daily_user_stats WHERE user_id = $1) AS stats
    FROM balances b WHERE b.user_id = $1
  `, [fixture.user.id]);
  assert.deepEqual(state, {
    balance: '4.999999999999999999',
    draws: 0,
    ledger: 0,
    stats: 0,
  });
}

async function seedFixture(initialErt: string, costErt: number, type: RewardType, amount: number | null) {
  const user = Object.assign(new User(), {
    id: randomUUID(),
    telegramId: `raffle-qa-${randomUUID()}`,
    username: `raffle_qa_${randomUUID().replaceAll('-', '')}`,
    firstName: 'Raffle QA',
    lastName: null,
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: null,
  });
  await dataSource.getRepository(User).save(user);
  userIds.push(user.id);
  await dataSource.query(`
    INSERT INTO balances (user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert, updated_at)
    VALUES ($1, $2::numeric(48,18), $2::numeric(48,18), 0, now())
  `, [user.id, initialErt]);

  const reward = await dataSource.getRepository(Reward).save(Object.assign(new Reward(), {
    code: `raffle-qa-${randomUUID()}`,
    title: 'Raffle QA reward',
    description: null,
    type,
    amount,
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
    code: `raffle-qa-${randomUUID()}`,
    title: 'Raffle QA pool',
    description: null,
    costErt,
    isActive: true,
    dailyUserAttemptLimit: null,
  }));
  poolIds.push(pool.id);
  await dataSource.getRepository(RafflePoolReward).save(Object.assign(new RafflePoolReward(), {
    poolId: pool.id,
    rewardId: reward.id,
    weight: 1,
    isActive: true,
    startsAt: null,
    endsAt: null,
  }));
  return { user, pool };
}

async function cleanup() {
  if (!dataSource.isInitialized) return;
  if (userIds.length > 0) {
    await dataSource.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  }
  if (poolIds.length > 0) {
    await dataSource.query('DELETE FROM raffle_pool_rewards WHERE pool_id = ANY($1::uuid[])', [poolIds]);
    await dataSource.query('DELETE FROM raffle_pools WHERE id = ANY($1::uuid[])', [poolIds]);
  }
  if (rewardIds.length > 0) {
    await dataSource.query('DELETE FROM rewards WHERE id = ANY($1::uuid[])', [rewardIds]);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
