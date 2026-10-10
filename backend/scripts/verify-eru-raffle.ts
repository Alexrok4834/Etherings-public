import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { EruLedgerService } from '../src/balance/eru-ledger.service';
import { LedgerTransaction, LedgerTransactionType } from '../src/balance/ledger-transaction.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { AddEruRaffleRewards1787529600000 } from '../src/migrations/1787529600000-add-eru-raffle-rewards';
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

const entities = [User, Balance, LedgerTransaction, DailyUserStats, Reward, RafflePool, RafflePoolReward, RaffleDraw, UserReward];
const migration = new AddEruRaffleRewards1787529600000();

async function main() {
  await verifyMigration();
  await verifyAtomicRuntime();
  console.log(JSON.stringify({
    database: databaseName,
    migrationUpDownUp: true,
    legacyAmountsPreserved: true,
    exactUnsafeIntegerReward: true,
    configuredWeightsUnchanged: true,
    persistedDrawIdempotency: true,
    fullDrawRollbackOnEruFailure: true,
    destructiveDownBlocked: true,
  }, null, 2));
}

async function verifyMigration() {
  const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await resetSchema(runner);
    await runner.query(`CREATE TYPE rewards_type_enum AS ENUM ('ERT', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER')`);
    await runner.query(`CREATE TYPE user_rewards_type_enum AS ENUM ('ERT', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER')`);
    await runner.query(`CREATE TABLE rewards (id uuid PRIMARY KEY, type rewards_type_enum NOT NULL, amount numeric(24,0))`);
    await runner.query(`CREATE TABLE user_rewards (id uuid PRIMARY KEY, type user_rewards_type_enum NOT NULL, amount numeric(24,0))`);
    await runner.query(`INSERT INTO rewards VALUES ($1, 'ERT', 25)`, [randomUUID()]);
    await runner.query(`INSERT INTO user_rewards VALUES ($1, 'ERT', 25)`, [randomUUID()]);

    await migration.up(runner);
    await assertMigrationState(runner);
    const firstFingerprint = await migrationFingerprint(runner);
    await migration.down(runner);
    await migration.up(runner);
    assert.deepEqual(await migrationFingerprint(runner), firstFingerprint);
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

async function assertMigrationState(runner: QueryRunner) {
  const labels = await runner.query(`
    SELECT typname AS type, enumlabel AS label FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    WHERE typname IN ('rewards_type_enum', 'user_rewards_type_enum')
    ORDER BY typname, enumsortorder
  `);
  assert.equal(labels.filter((row: { label: string }) => row.label === 'ERU').length, 2);
  const amounts = await runner.query(`
    SELECT amount::text AS amount, amount_exact::text AS exact FROM rewards
    UNION ALL SELECT amount::text, amount_exact::text FROM user_rewards
  `);
  assert.deepEqual(amounts, [{ amount: '25', exact: '25' }, { amount: '25', exact: '25' }]);
  await assert.rejects(
    runner.query(`INSERT INTO rewards (id, type, amount_exact) VALUES ($1, 'ERU', 0)`, [randomUUID()]),
    (error: { code?: string }) => error.code === '23514',
  );
}

async function migrationFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('rewards', 'user_rewards')
    ORDER BY table_name, ordinal_position
  `);
}

async function verifyAtomicRuntime() {
  const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: true, dropSchema: true, entities });
  await dataSource.initialize();
  try {
    const ledger = new LedgerService(dataSource);
    const eruLedger = new EruLedgerService(dataSource);
    const service = raffleService(dataSource, ledger, eruLedger);
    const fixture = await seed(dataSource, '9007199254740993', 7, 3);

    const [publicPool] = await service.listPublicPools();
    assert.equal(publicPool.rewards[0].amount, null);
    assert.equal(publicPool.rewards[0].amountExact, '9007199254740993');
    assert.equal(publicPool.rewards[0].weight, 7);
    assert.equal(publicPool.rewards[0].probability, 1);

    const result = await service.drawFromPool(fixture.user, fixture.pool.id, 0.42);
    assert.equal(result.userReward.amountExact, '9007199254740993');
    assert.equal(result.userReward.eruBalanceAfterExact, '9007199254740993');
    const state = await accountState(dataSource, fixture.user.id);
    assert.deepEqual(state, { balance: '9007199254740993', earned: '9007199254740993', ledger: 1, draws: 1, rewards: 1, attempts: 1 });

    const replay = await eruLedger.credit({
      userId: fixture.user.id,
      amount: '9007199254740993',
      type: LedgerTransactionType.RaffleReward,
      referenceType: 'raffle_draw',
      referenceId: result.draw.id,
      metadata: { poolCode: fixture.pool.code, rewardCode: fixture.reward.code },
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(await accountState(dataSource, fixture.user.id), state);

    const rollbackFixture = await seed(dataSource, '30', 1, 2);
    const failingService = raffleService(dataSource, ledger, {
      creditInTransaction: async () => { throw new Error('injected ERU credit failure'); },
    } as EruLedgerService);
    await assert.rejects(() => failingService.drawFromPool(rollbackFixture.user, rollbackFixture.pool.id, 0.1), /injected ERU/);
    assert.deepEqual(await accountState(dataSource, rollbackFixture.user.id), {
      balance: '0', earned: '0', ledger: 0, draws: 0, rewards: 0, attempts: 0,
    });
    const [stock] = await dataSource.query(`SELECT stock_remaining AS stock FROM rewards WHERE id = $1`, [rollbackFixture.reward.id]);
    assert.equal(stock.stock, 2);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await assert.rejects(() => migration.down(runner), /while ERU rewards exist/);
    } finally {
      await runner.release();
    }
  } finally {
    await dataSource.destroy();
  }
}

function raffleService(dataSource: DataSource, ledger: LedgerService, eruLedger: EruLedgerService) {
  return new RaffleService(
    dataSource.getRepository(RafflePool), dataSource.getRepository(RafflePoolReward),
    new RaffleSelectionService(), dataSource, ledger, eruLedger,
  );
}

async function seed(dataSource: DataSource, amount: string, weight: number, stock: number) {
  const suffix = randomUUID();
  const user = await dataSource.getRepository(User).save(Object.assign(new User(), {
    telegramId: `eru-raffle-${suffix}`, username: null, firstName: 'ERU QA', lastName: null,
    photoUrl: null, isAdmin: false, lastLoginAt: null,
  }));
  await dataSource.query(`INSERT INTO balances (user_id, ert_balance) VALUES ($1, 100)`, [user.id]);
  const reward = await dataSource.getRepository(Reward).save(Object.assign(new Reward(), {
    code: `eru-${suffix}`, title: 'ERU QA', description: null, type: RewardType.Eru,
    amount: null, amountExactValue: amount, metadata: null, imageUrl: null, isActive: true,
    stockTotal: stock, stockRemaining: stock, perUserLimit: null, dailyGlobalLimit: null,
  }));
  const pool = await dataSource.getRepository(RafflePool).save(Object.assign(new RafflePool(), {
    code: `pool-${suffix}`, title: 'ERU QA', description: null, costErt: 5,
    isActive: true, dailyUserAttemptLimit: null,
  }));
  await dataSource.getRepository(RafflePoolReward).save(Object.assign(new RafflePoolReward(), {
    poolId: pool.id, rewardId: reward.id, weight, isActive: true, startsAt: null, endsAt: null,
  }));
  return { user, reward, pool };
}

async function accountState(dataSource: DataSource, userId: string) {
  const [row] = await dataSource.query(`
    SELECT b.eru_balance::text AS balance, b.lifetime_earned_eru::text AS earned,
      (SELECT count(*)::int FROM ledger_transactions WHERE user_id = $1 AND currency = 'ERU') AS ledger,
      (SELECT count(*)::int FROM raffle_draws WHERE user_id = $1) AS draws,
      (SELECT count(*)::int FROM user_rewards WHERE user_id = $1) AS rewards,
      COALESCE((SELECT raffle_attempts FROM daily_user_stats WHERE user_id = $1), 0) AS attempts
    FROM balances b WHERE b.user_id = $1
  `, [userId]);
  return row;
}

async function resetSchema(runner: QueryRunner) {
  await runner.query('DROP SCHEMA public CASCADE');
  await runner.query('CREATE SCHEMA public');
  await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
