import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CopperRingEntitlementService } from '../src/ring/copper-ring-entitlement.service';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { EquippedRing } from '../src/ring/equipped-ring.entity';
import { GameRing } from '../src/ring/game-ring.entity';
import { User } from '../src/auth/user.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { LedgerTransactionType } from '../src/balance/ledger-transaction.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerTransaction } from '../src/balance/ledger-transaction.entity';
import { M2eBalanceConfigService } from '../src/m2e/m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from '../src/m2e/m2e-daily-economic-snapshot.entity';
import { M2eDailySnapshotService } from '../src/m2e/m2e-daily-snapshot.service';
import { M2eEarningCalculator } from '../src/m2e/m2e-earning-calculator';
import { M2eSettlementService } from '../src/m2e/m2e-settlement.service';
import { M2ePlayerEconomyReadService } from '../src/m2e/m2e-player-economy-read.service';
import { DailyUserStats } from '../src/walk/daily-user-stats.entity';
import { WalkSession } from '../src/walk/walk-session.entity';
import { StepSyncBatch, StepSyncBatchSource } from '../src/step-sync/step-sync-batch.entity';
import { StepSyncInstallation } from '../src/step-sync/step-sync-installation.entity';
import { StepSyncService } from '../src/step-sync/step-sync.service';
import { CreateStepSyncSchema1786406400000 } from '../src/migrations/1786406400000-create-step-sync-schema';
import { CreateMobileRefreshTokens1786492800000 } from '../src/migrations/1786492800000-create-mobile-refresh-tokens';
import { CreateMobileCredentials1786665600000 } from '../src/migrations/1786665600000-create-mobile-credentials';
import { CreateCopperRingSchema1787097600000 } from '../src/migrations/1787097600000-create-copper-ring-schema';
import { CreateCopperLevelUpSchema1787184000000 } from '../src/migrations/1787184000000-create-copper-level-up-schema';
import { CreateCopperDeferredAllocationSchema1787270400000 } from '../src/migrations/1787270400000-create-copper-deferred-allocation-schema';
import { CreateM2eAccountingSchema1787356800000 } from '../src/migrations/1787356800000-create-m2e-accounting-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [
    User,
    Balance,
    LedgerTransaction,
    DailyUserStats,
    WalkSession,
    GameRing,
    EquippedRing,
    M2eDailyEconomicSnapshot,
    StepSyncInstallation,
    StepSyncBatch,
  ],
});
const migration = new CreateM2eAccountingSchema1787356800000();

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await prepareBaseline(runner);
    const fixture = await seedIntegerHistory(runner);

    await migration.up(runner);
    const firstFingerprint = await schemaFingerprint(runner);
    await assertPrecisionAndHistory(runner, fixture);

    await migration.down(runner);
    await assertCleanDown(runner, fixture);
    await migration.up(runner);
    assert.deepEqual(await schemaFingerprint(runner), firstFingerprint);

    await assertFractionalDownBlocked(runner, fixture);
    await assertConcurrentSnapshotCreation(fixture.userId);
    await assertDecimalLedgerCredit(fixture.userId);
    await assertM2eStepSyncSettlement(fixture.userId);
    await assertM2eLedgerReconciliation(fixture.userId);
    await assertExactPlayerEconomyRead(fixture.userId);
    await assertSnapshotConstraints(runner, fixture);
    await assertSnapshotDownBlocked(runner);

    console.log(JSON.stringify({
      database: databaseName,
      allErtColumnsNumeric48Scale18: true,
      integerHistoryPreservedExactly: true,
      cleanUpDownUpStable: true,
      fractionalDownBlocked: true,
      concurrentFirstSnapshotConverges: true,
      decimalLedgerCreditPreservedExactly: true,
      m2eStepSyncSettlementIdempotent: true,
      ledgerReconciliationZeroMismatch: true,
      exactPlayerEconomyApiRead: true,
      oneSnapshotPerOwnerDate: true,
      selectedRingOwnershipEnforced: true,
      batchSnapshotOwnershipEnforced: true,
      snapshotImmutable: true,
      snapshotDownBlocked: true,
    }, null, 2));
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

async function prepareBaseline(runner: QueryRunner) {
  assert.equal(await runner.hasTable('users'), true, 'Run qa:prepare-legacy-schema first');
  assert.equal(await runner.hasTable('step_sync_installations'), false, 'QA database must be disposable and fresh');
  for (const current of [
    new CreateStepSyncSchema1786406400000(),
    new CreateMobileRefreshTokens1786492800000(),
    new CreateMobileCredentials1786665600000(),
    new CreateCopperRingSchema1787097600000(),
    new CreateCopperLevelUpSchema1787184000000(),
    new CreateCopperDeferredAllocationSchema1787270400000(),
  ]) await current.up(runner);
}

async function seedIntegerHistory(runner: QueryRunner) {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const ringId = randomUUID();
  const otherRingId = randomUUID();
  for (const [id, suffix] of [[userId, 'owner'], [otherUserId, 'other']]) {
    await runner.query(`
      INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
      VALUES ($1, $2, $3, 'M2E QA', false, now(), now())
    `, [id, `m2e-qa-${suffix}-${randomUUID()}`, `m2e_qa_${suffix}_${randomUUID().replaceAll('-', '')}`]);
  }
  for (const [id, owner, variant] of [
    [ringId, userId, 'copper_plain_polished'],
    [otherRingId, otherUserId, 'copper_milgrain'],
  ]) {
    await runner.query(`
      INSERT INTO game_rings (
        id, owner_user_id, entitlement_code, ring_kind, status, level, shine,
        comfort, charm, quality, luck, visual_variant_code, ruleset_version,
        generation_version, visual_set_version, issued_reason, created_at, updated_at
      ) VALUES ($1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', 1, 100,
        20, 10, 11, 12, $3, 'copper-rules-v1', 'copper-generation-v1',
        'copper-visual-v1', 'REGISTRATION', now(), now())
    `, [id, owner, variant]);
  }
  await runner.query(`
    INSERT INTO equipped_rings (user_id, ring_id, equipped_at, updated_at)
    VALUES ($1, $2, now(), now()), ($3, $4, now(), now())
  `, [userId, ringId, otherUserId, otherRingId]);
  await runner.query(`
    INSERT INTO balances (user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert, updated_at)
    VALUES ($1, 123, 150, 27, now())
  `, [userId]);
  await runner.query(`
    INSERT INTO ledger_transactions (user_id, type, amount, balance_after, created_at)
    VALUES ($1, 'WALK_REWARD', 23, 123, now())
  `, [userId]);
  await runner.query(`
    INSERT INTO daily_user_stats (user_id, date, accepted_steps, earned_ert, raffle_attempts, created_at, updated_at)
    VALUES ($1, '2026-08-21', 2300, 23, 0, now(), now())
  `, [userId]);
  await runner.query(`
    INSERT INTO walk_sessions (
      user_id, status, started_at, accepted_step_count, source, earned_ert, created_at
    ) VALUES ($1, 'ACCEPTED', now(), 2300, 'android_step_counter', 23, now())
  `, [userId]);
  for (const [owner, sequence] of [[userId, 1], [otherUserId, 2]] as const) {
    const installationId = randomUUID();
    await runner.query(`
      INSERT INTO step_sync_installations (id, user_id, installation_id, status)
      VALUES ($1, $2, $3, 'ACTIVE')
    `, [installationId, owner, randomUUID()]);
    await runner.query(`
      INSERT INTO step_sync_batches (
        user_id, installation_record_id, batch_id, sequence, payload_hash, local_date,
        timezone_offset_minutes, observed_started_at, observed_ended_at, claimed_step_count,
        sensor_event_count, source, algorithm_version, status
      ) VALUES ($1, $2, $3, $4, $5, '2026-08-21', 180, now(), now(), 100, 100,
        'android_step_counter', 'qa-v1', 'RECEIVED')
    `, [owner, installationId, randomUUID(), sequence, 'a'.repeat(64)]);
  }
  return { userId, otherUserId, ringId, otherRingId };
}

async function assertPrecisionAndHistory(
  runner: QueryRunner,
  fixture: { userId: string },
) {
  const columns = await runner.query(`
    SELECT table_name AS "table", column_name AS "column",
      numeric_precision AS "precision", numeric_scale AS "scale"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND (table_name, column_name) IN (
      ('balances', 'ert_balance'), ('balances', 'lifetime_earned_ert'),
      ('balances', 'lifetime_spent_ert'), ('ledger_transactions', 'amount'),
      ('ledger_transactions', 'balance_after'), ('daily_user_stats', 'earned_ert'),
      ('step_sync_batches', 'earned_ert_delta'), ('walk_sessions', 'earned_ert')
    ) ORDER BY table_name, column_name
  `);
  assert.equal(columns.length, 8);
  assert.ok(columns.every((column: { precision: number; scale: number }) =>
    column.precision === 48 && column.scale === 18));
  const [balance] = await runner.query(`
    SELECT ert_balance::text AS balance, lifetime_earned_ert::text AS earned,
      lifetime_spent_ert::text AS spent FROM balances WHERE user_id = $1
  `, [fixture.userId]);
  assert.deepEqual(balance, {
    balance: '123.000000000000000000',
    earned: '150.000000000000000000',
    spent: '27.000000000000000000',
  });
}

async function assertCleanDown(runner: QueryRunner, fixture: { userId: string }) {
  assert.equal(await runner.hasTable('m2e_daily_economic_snapshots'), false);
  assert.equal(await runner.hasColumn('step_sync_batches', 'm2e_daily_snapshot_id'), false);
  const [balance] = await runner.query(
    'SELECT ert_balance::text AS balance FROM balances WHERE user_id = $1',
    [fixture.userId],
  );
  assert.equal(balance.balance, '123');
}

async function schemaFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT kind, name, definition FROM (
      SELECT 'column' AS kind, table_name || '.' || column_name AS name,
        data_type || ':' || coalesce(numeric_precision::text, '') || ':'
          || coalesce(numeric_scale::text, '') AS definition
      FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        table_name = 'm2e_daily_economic_snapshots'
        OR (table_name = 'step_sync_batches' AND column_name = 'm2e_daily_snapshot_id')
        OR (table_name, column_name) IN (
          ('balances', 'ert_balance'), ('balances', 'lifetime_earned_ert'),
          ('balances', 'lifetime_spent_ert'), ('ledger_transactions', 'amount'),
          ('ledger_transactions', 'balance_after'), ('daily_user_stats', 'earned_ert'),
          ('step_sync_batches', 'earned_ert_delta'), ('walk_sessions', 'earned_ert')
        )
      )
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid IN ('m2e_daily_economic_snapshots'::regclass, 'step_sync_batches'::regclass)
        AND (conname LIKE 'CHK_m2e%' OR conname LIKE 'FK_%m2e%' OR conname LIKE 'UQ_m2e%')
      UNION ALL
      SELECT 'trigger', trigger_name, action_statement FROM information_schema.triggers
      WHERE event_object_schema = 'public' AND event_object_table = 'm2e_daily_economic_snapshots'
    ) objects ORDER BY kind, name
  `);
}

async function assertFractionalDownBlocked(
  runner: QueryRunner,
  fixture: { userId: string },
) {
  await runner.startTransaction();
  try {
    await runner.query('UPDATE balances SET ert_balance = 123.5 WHERE user_id = $1', [fixture.userId]);
    await assert.rejects(migration.down(runner), (error) => pgCode(error) === '23514');
  } finally {
    await runner.rollbackTransaction();
  }
}

async function assertConcurrentSnapshotCreation(userId: string) {
  const ringRepository = new CopperRingRepository(dataSource);
  const entitlement = {
    async ensureStarterCopperInTransaction() { return { created: false }; },
  } as unknown as CopperRingEntitlementService;
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  const service = new M2eDailySnapshotService(
    config,
    new M2eEarningCalculator(config),
    entitlement,
    ringRepository,
  );

  const [first, second] = await Promise.all([
    dataSource.transaction((manager) =>
      service.getOrCreateInTransaction(manager, userId, '2026-08-20')),
    dataSource.transaction((manager) =>
      service.getOrCreateInTransaction(manager, userId, '2026-08-20')),
  ]);
  assert.equal(first.id, second.id);
  const [{ count }] = await dataSource.query(`
    SELECT count(*)::integer AS count FROM m2e_daily_economic_snapshots
    WHERE user_id = $1 AND accounting_date = '2026-08-20'
  `, [userId]);
  assert.equal(count, 1);
}

async function assertDecimalLedgerCredit(userId: string) {
  const ledger = new LedgerService(dataSource);
  const amount = '0.000950181818181818';
  const result = await dataSource.transaction((manager) => ledger.creditDecimalInTransaction(manager, {
    userId,
    amount,
    type: LedgerTransactionType.WalkReward,
    referenceType: 'm2e_accounting_qa',
    referenceId: randomUUID(),
    metadata: { exactDecimalQa: true },
  }));
  assert.deepEqual(result.balance, {
    ertBalance: '123.000950181818181818',
    lifetimeEarnedErt: '150.000950181818181818',
    lifetimeSpentErt: '27',
  });
  assert.equal(result.ledgerTransaction.amount, amount);
  assert.equal(result.ledgerTransaction.balanceAfter, '123.000950181818181818');

  const [persisted] = await dataSource.query(`
    SELECT amount::text AS amount, balance_after::text AS "balanceAfter"
    FROM ledger_transactions WHERE id = $1
  `, [result.ledgerTransaction.id]);
  assert.deepEqual(persisted, {
    amount: '0.000950181818181818',
    balanceAfter: '123.000950181818181818',
  });
}

async function assertM2eStepSyncSettlement(userId: string) {
  const ringRepository = new CopperRingRepository(dataSource);
  const entitlement = {
    async ensureStarterCopperInTransaction() { return { created: false }; },
  } as unknown as CopperRingEntitlementService;
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  const calculator = new M2eEarningCalculator(config);
  const snapshotService = new M2eDailySnapshotService(config, calculator, entitlement, ringRepository);
  const settlement = new M2eSettlementService(calculator, new LedgerService(dataSource));
  const service = new StepSyncService(
    dataSource,
    { getLimits: () => { throw new Error('Legacy earning path was called'); } } as never,
    { creditInTransaction: () => { throw new Error('Legacy ledger path was called'); } } as never,
    {
      getPolicy: () => ({ retentionSeconds: 604800, maxFutureSkewSeconds: 600 }),
      now: () => new Date('2026-08-22T18:00:00.000Z'),
    } as never,
    { isEarningEnabledForUser: () => true } as never,
    snapshotService,
    settlement,
  );
  const batchId = randomUUID();
  const installationId = randomUUID();
  const input = {
    installationId,
    batchId,
    sequence: 1,
    localDate: '2026-08-22',
    timezoneOffsetMinutes: 180,
    observedStartedAt: '2026-08-22T08:00:00.000Z',
    observedEndedAt: '2026-08-22T08:15:00.000Z',
    stepDelta: 100,
    sensorEventCount: 100,
    source: StepSyncBatchSource.AndroidStepCounter,
    algorithmVersion: 'm2e-accounting-qa-v1',
    clientMetadata: { test: 'disposable-postgres' },
  };
  const owner = await dataSource.getRepository(User).findOneByOrFail({ id: userId });
  const first = await service.receiveBatch(owner, input);
  const retry = await service.receiveBatch(owner, input);
  assert.deepEqual(retry, first);
  assert.equal(first.earnedErtDeltaExact, '0.13065');
  assert.equal(first.earnedErtDeltaDisplay, '0.13');
  assert.equal(first.dailyStepCap, 5000);
  assert.equal(first.rulesVersion, 'move-to-earn-earning-v1');
  assert.equal(first.balanceConfigVersion, 'move-to-earn-balance-v1');
  assert.equal(first.m2eSettlement?.deltaAuthoritativeErt, '0.13065');
  assert.equal(first.m2eSettlement?.deltaDisplayedErt, '0.13');

  const [persisted] = await dataSource.query(`
    SELECT b.earned_ert_delta::text AS "batchDelta",
      b.m2e_daily_snapshot_id AS "snapshotId", b.result_snapshot AS "resultSnapshot",
      s.earned_ert::text AS "dailyEarned", s.accepted_steps AS "acceptedSteps"
    FROM step_sync_batches b
    JOIN daily_user_stats s ON s.user_id = b.user_id AND s.date = b.accounting_date
    WHERE b.user_id = $1 AND b.batch_id = $2
  `, [userId, batchId]);
  assert.equal(persisted.batchDelta, '0.130650000000000000');
  assert.equal(persisted.dailyEarned, '0.130650000000000000');
  assert.equal(persisted.acceptedSteps, 100);
  assert.equal(persisted.resultSnapshot.rulesVersion, 'move-to-earn-earning-v1');
  assert.equal(persisted.resultSnapshot.balanceConfigVersion, 'move-to-earn-balance-v1');
  assert.equal(persisted.resultSnapshot.earnedErtDeltaExact, '0.13065');
  assert.equal(persisted.resultSnapshot.earnedErtDeltaDisplay, '0.13');
  assert.equal(persisted.resultSnapshot.dailyStepCap, 5000);
  assert.equal(persisted.resultSnapshot.m2eSettlement.deltaAuthoritativeErt, '0.13065');
  assert.equal(persisted.resultSnapshot.m2eSettlement.snapshotId, persisted.snapshotId);

  const [{ ledgerCount }] = await dataSource.query(`
    SELECT count(*)::integer AS "ledgerCount" FROM ledger_transactions
    WHERE user_id = $1 AND reference_type = 'm2e_step_sync_batch' AND reference_id = (
      SELECT id::text FROM step_sync_batches WHERE user_id = $1 AND batch_id = $2
    )
  `, [userId, batchId]);
  assert.equal(ledgerCount, 1);
}

async function assertM2eLedgerReconciliation(userId: string) {
  const [result] = await dataSource.query(`
    WITH new_credits AS (
      SELECT coalesce(sum(amount), 0)::numeric(48,18) AS amount
      FROM ledger_transactions
      WHERE user_id = $1
        AND reference_type IN ('m2e_accounting_qa', 'm2e_step_sync_batch')
    ), m2e_credits AS (
      SELECT coalesce(sum(amount), 0)::numeric(48,18) AS amount
      FROM ledger_transactions
      WHERE user_id = $1 AND reference_type = 'm2e_step_sync_batch'
    ), batch_deltas AS (
      SELECT coalesce(sum(earned_ert_delta), 0)::numeric(48,18) AS amount
      FROM step_sync_batches
      WHERE user_id = $1 AND accounting_date = '2026-08-22'
    ), daily_earned AS (
      SELECT coalesce(sum(earned_ert), 0)::numeric(48,18) AS amount
      FROM daily_user_stats
      WHERE user_id = $1 AND date = '2026-08-22'
    )
    SELECT
      b.ert_balance = 123::numeric + n.amount AS "balanceMatches",
      b.lifetime_earned_ert = 150::numeric + n.amount AS "lifetimeEarnedMatches",
      b.lifetime_spent_ert = 27::numeric AS "lifetimeSpentMatches",
      m.amount = d.amount AS "m2eLedgerMatchesDaily",
      m.amount = x.amount AS "m2eLedgerMatchesBatches",
      n.amount::text AS "newCredits",
      m.amount::text AS "m2eCredits"
    FROM balances b
    CROSS JOIN new_credits n
    CROSS JOIN m2e_credits m
    CROSS JOIN batch_deltas x
    CROSS JOIN daily_earned d
    WHERE b.user_id = $1
  `, [userId]);
  assert.deepEqual(result, {
    balanceMatches: true,
    lifetimeEarnedMatches: true,
    lifetimeSpentMatches: true,
    m2eLedgerMatchesDaily: true,
    m2eLedgerMatchesBatches: true,
    newCredits: '0.131600181818181818',
    m2eCredits: '0.130650000000000000',
  });
}

async function assertExactPlayerEconomyRead(userId: string) {
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  const service = new M2ePlayerEconomyReadService(dataSource, config);
  const profile = await service.getProfile(userId, '2026-08-22');
  assert.deepEqual(profile, {
    ertBalance: { exact: '123.131600181818181818', display: '123.13' },
    lifetimeEarnedErt: { exact: '150.131600181818181818', display: '150.13' },
    lifetimeSpentErt: { exact: '27', display: '27.00' },
    earnedErtToday: { exact: '0.13065', display: '0.13' },
    dailyStepCap: 5000,
    rulesVersion: 'move-to-earn-earning-v1',
    balanceConfigVersion: 'move-to-earn-balance-v1',
  });

  const activity = await service.getActivity(userId, '2026-08-22', '2026-08-22');
  assert.deepEqual(activity.get('2026-08-22'), {
    date: '2026-08-22',
    earnedErt: { exact: '0.13065', display: '0.13' },
    dailyStepCap: 5000,
    rulesVersion: 'move-to-earn-earning-v1',
    balanceConfigVersion: 'move-to-earn-balance-v1',
  });
}

async function assertSnapshotConstraints(
  runner: QueryRunner,
  fixture: { userId: string; otherUserId: string; ringId: string; otherRingId: string },
) {
  const snapshotId = randomUUID();
  await expectPgCode(insertSnapshot(runner, randomUUID(), fixture.userId, fixture.otherRingId), '23503');
  await runner.query(insertSnapshotSql, snapshotValues(snapshotId, fixture.userId, fixture.ringId));
  await expectPgCode(insertSnapshot(runner, randomUUID(), fixture.userId, fixture.ringId), '23505');
  await expectPgCode(
    runner.query('UPDATE m2e_daily_economic_snapshots SET selected_ring_comfort = 21 WHERE id = $1', [snapshotId]),
    '23514',
  );
  await expectPgCode(
    runner.query('DELETE FROM m2e_daily_economic_snapshots WHERE id = $1', [snapshotId]),
    '23514',
  );
  await expectPgCode(
    runner.query(`
      UPDATE step_sync_batches SET m2e_daily_snapshot_id = $1
      WHERE user_id = $2
    `, [snapshotId, fixture.otherUserId]),
    '23503',
  );
  await runner.query(`
    UPDATE step_sync_batches SET m2e_daily_snapshot_id = $1
    WHERE user_id = $2
  `, [snapshotId, fixture.userId]);
}

const insertSnapshotSql = `
  INSERT INTO m2e_daily_economic_snapshots (
    id, user_id, accounting_date, selected_ring_id, ring_count,
    selected_ring_comfort, step_cap, rules_version, balance_config_version,
    base_steps, extra_steps_per_ring, base_ert_per_1000_steps, comfort_curve_k
  ) VALUES ($1, $2, '2026-08-21', $3, 1, 20, 5000,
    'move-to-earn-earning-v1', 'move-to-earn-balance-v1', 5000, 1000, 0.871, 20)
`;

function snapshotValues(id: string, userId: string, ringId: string) {
  return [id, userId, ringId];
}

function insertSnapshot(runner: QueryRunner, id: string, userId: string, ringId: string) {
  return runner.query(insertSnapshotSql, snapshotValues(id, userId, ringId));
}

async function assertSnapshotDownBlocked(runner: QueryRunner) {
  await runner.startTransaction();
  try {
    await assert.rejects(migration.down(runner), (error) => pgCode(error) === '23514');
  } finally {
    await runner.rollbackTransaction();
  }
  assert.equal(await runner.hasTable('m2e_daily_economic_snapshots'), true);
}

async function expectPgCode(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error) => pgCode(error) === expected);
}

function pgCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
