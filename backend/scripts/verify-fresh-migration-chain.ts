import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import migrationDataSource from '../src/database/data-source';
import {
  LEGACY_BASELINE_FINGERPRINT,
  legacyBaselineFingerprint,
} from './fixtures/legacy-baseline-schema';

const EXPECTED_MIGRATIONS = [
  'CreateStepSyncSchema1786406400000',
  'CreateMobileRefreshTokens1786492800000',
  'CreateMobileCredentials1786665600000',
  'CreateCopperRingSchema1787097600000',
  'CreateCopperLevelUpSchema1787184000000',
  'CreateCopperDeferredAllocationSchema1787270400000',
  'CreateM2eAccountingSchema1787356800000',
  'CreateEruAccountingSchema1787443200000',
  'AddEruRaffleRewards1787529600000',
  'CreateRaffleV2SingletonSchema1787616000000',
  'CreateRaffleV2DrawEvidenceSchema1787702400000',
  'CreateRaffleCopperAwardSchema1787788800000',
  'CreateRingEquipmentOperationSchema1787875200000',
  'ProtectActiveRaffleV2Rewards1787961600000',
  'CreateRaffleV2ActivationOperationSchema1788048000000',
  'CreateRaffleV2AvailabilityOperationSchema1788134400000',
  'AllowCopperBulkAllocationV21788220800000',
  'MigrateEruDecimalAccountingV21788307200000',
  'AddWalkRewardIdempotency1788393600000',
];
const EXPECTED_MIGRATED_SCHEMA_FINGERPRINT = '5120da196f0ff69a6543d3601733ec26550d804ecc4e89a5cb83b91a420851c0';
const USER_ID = '71000000-0000-4000-8000-000000000001';
const LEDGER_ID = '71000000-0000-4000-8000-000000000002';
const DAILY_ID = '71000000-0000-4000-8000-000000000003';
const WALK_ID = '71000000-0000-4000-8000-000000000004';
const REWARD_ID = '71000000-0000-4000-8000-000000000005';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

async function main() {
  await migrationDataSource.initialize();
  const runner = migrationDataSource.createQueryRunner();
  await runner.connect();
  try {
    assert.equal(await legacyBaselineFingerprint(runner), LEGACY_BASELINE_FINGERPRINT);
    await seedLegacyEvidence(runner);

    const applied = await migrationDataSource.runMigrations({ transaction: 'all' });
    assert.deepEqual(applied.map((migration) => migration.name), EXPECTED_MIGRATIONS);
    await assertLegacyEvidence(runner);

    const fingerprint = await migratedSchemaFingerprint(runner);
    assert.equal(fingerprint, EXPECTED_MIGRATED_SCHEMA_FINGERPRINT);

    const secondRun = await migrationDataSource.runMigrations({ transaction: 'all' });
    assert.deepEqual(secondRun, []);
    assert.equal(await migratedSchemaFingerprint(runner), fingerprint);
    await assertLegacyEvidence(runner);

    await migrationDataSource.undoLastMigration({ transaction: 'all' });
    await assertWalkRewardIndex(runner, false);
    await migrationDataSource.undoLastMigration({ transaction: 'all' });
    await assertEruScale(runner, 0);
    await migrationDataSource.runMigrations({ transaction: 'all' });
    assert.equal(await migratedSchemaFingerprint(runner), fingerprint);
    await assertWalkRewardIndex(runner, true);
    await assertLegacyEvidence(runner);

    await runner.query(`UPDATE balances SET eru_balance = '0.000000000000000001' WHERE user_id = $1`, [USER_ID]);
    await migrationDataSource.undoLastMigration({ transaction: 'all' });
    await assertPgCode(migrationDataSource.undoLastMigration({ transaction: 'all' }), '23514');
    await assertEruScale(runner, 18);
    await migrationDataSource.runMigrations({ transaction: 'all' });
    await assertWalkRewardIndex(runner, true);

    console.log(JSON.stringify({
      database: databaseName,
      baselineFingerprint: LEGACY_BASELINE_FINGERPRINT,
      migratedSchemaFingerprint: fingerprint,
      appliedMigrations: applied.map((migration) => migration.name),
      secondRunApplied: secondRun.length,
      exactLegacyValuesPreserved: true,
      cleanDecimalDowngradeAndReapplyStable: true,
      fractionalDowngradeBlocked: true,
    }, null, 2));
  } finally {
    await runner.release();
    await migrationDataSource.destroy();
  }
}

async function assertWalkRewardIndex(runner: import('typeorm').QueryRunner, expected: boolean) {
  const rows = await runner.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'ledger_transactions'
      AND indexname = 'UQ_ledger_walk_reward_reference'
  `);
  assert.equal(rows.length === 1, expected);
}

async function assertEruScale(runner: import('typeorm').QueryRunner, expectedScale: number) {
  const rows = await runner.query(`
    SELECT table_name, column_name, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public' AND (table_name, column_name) IN (
      ('balances', 'eru_balance'),
      ('balances', 'lifetime_earned_eru'),
      ('balances', 'lifetime_spent_eru'),
      ('rewards', 'amount_exact'),
      ('user_rewards', 'amount_exact'),
      ('user_rewards', 'eru_balance_after')
    )
    ORDER BY table_name, column_name
  `);
  assert.equal(rows.length, 6);
  for (const row of rows) assert.equal(row.numeric_scale, expectedScale);
}

async function assertPgCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === code;
  });
}

async function seedLegacyEvidence(runner: import('typeorm').QueryRunner) {
  await runner.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
    VALUES ($1, 'm2e-chain-legacy-user', 'm2e_chain_legacy', 'M2E Chain QA', false, now(), now())
  `, [USER_ID]);
  await runner.query(`
    INSERT INTO balances (user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert, updated_at)
    VALUES ($1, 9007199254740993, 9007199254741993, 1000, now())
  `, [USER_ID]);
  await runner.query(`
    INSERT INTO ledger_transactions
      (id, user_id, type, amount, balance_after, reference_type, reference_id, metadata, created_at)
    VALUES ($1, $2, 'WALK_REWARD', 77, 9007199254740993, 'legacy_fixture', 'chain', '{"legacy":true}', now())
  `, [LEDGER_ID, USER_ID]);
  await runner.query(`
    INSERT INTO daily_user_stats
      (id, user_id, date, accepted_steps, earned_ert, raffle_attempts, created_at, updated_at)
    VALUES ($1, $2, '2026-08-20', 1234, 123, 0, now(), now())
  `, [DAILY_ID, USER_ID]);
  await runner.query(`
    INSERT INTO walk_sessions
      (id, user_id, status, started_at, ended_at, client_step_count, accepted_step_count,
       duration_seconds, source, earned_ert, created_at)
    VALUES ($1, $2, 'ACCEPTED', '2026-08-20T08:00:00Z', '2026-08-20T08:15:00Z',
      456, 456, 900, 'android_step_counter', 456, now())
  `, [WALK_ID, USER_ID]);
  await runner.query(`
    INSERT INTO rewards
      (id, code, title, type, amount, is_active, created_at, updated_at)
    VALUES ($1, 'm2e-chain-legacy-reward', 'Legacy reward', 'ERT', 789, true, now(), now())
  `, [REWARD_ID]);
}

async function assertLegacyEvidence(runner: import('typeorm').QueryRunner) {
  const [balance] = await runner.query(`
    SELECT ert_balance::text AS balance, lifetime_earned_ert::text AS earned,
      lifetime_spent_ert::text AS spent, eru_balance::text AS eru
    FROM balances WHERE user_id = $1
  `, [USER_ID]);
  assert.deepEqual(balance, {
    balance: '9007199254740993.000000000000000000',
    earned: '9007199254741993.000000000000000000',
    spent: '1000.000000000000000000',
    eru: '0.000000000000000000',
  });
  const [ledger] = await runner.query(`
    SELECT amount::text AS amount, balance_after::text AS balance_after, currency::text AS currency
    FROM ledger_transactions WHERE id = $1
  `, [LEDGER_ID]);
  assert.deepEqual(ledger, {
    amount: '77.000000000000000000',
    balance_after: '9007199254740993.000000000000000000',
    currency: 'ERT',
  });
  const [daily] = await runner.query(
    'SELECT earned_ert::text AS earned FROM daily_user_stats WHERE id = $1', [DAILY_ID],
  );
  assert.equal(daily.earned, '123.000000000000000000');
  const [walk] = await runner.query(
    'SELECT earned_ert::text AS earned FROM walk_sessions WHERE id = $1', [WALK_ID],
  );
  assert.equal(walk.earned, '456.000000000000000000');
  const [reward] = await runner.query(
    'SELECT amount::text AS amount, amount_exact::text AS amount_exact FROM rewards WHERE id = $1', [REWARD_ID],
  );
  assert.deepEqual(reward, { amount: '789', amount_exact: '789.000000000000000000' });

  const precisionRows = await runner.query(`
    SELECT table_name, column_name, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public' AND (table_name, column_name) IN (
      ('balances', 'ert_balance'),
      ('balances', 'lifetime_earned_ert'),
      ('balances', 'lifetime_spent_ert'),
      ('balances', 'eru_balance'),
      ('balances', 'lifetime_earned_eru'),
      ('balances', 'lifetime_spent_eru'),
      ('ledger_transactions', 'amount'),
      ('ledger_transactions', 'balance_after'),
      ('daily_user_stats', 'earned_ert'),
      ('step_sync_batches', 'earned_ert_delta'),
      ('walk_sessions', 'earned_ert'),
      ('rewards', 'amount_exact'),
      ('user_rewards', 'amount_exact'),
      ('user_rewards', 'eru_balance_after')
    )
    ORDER BY table_name, column_name
  `);
  assert.equal(precisionRows.length, 14);
  for (const row of precisionRows) {
    assert.equal(row.numeric_precision, 48);
    assert.equal(row.numeric_scale, 18);
  }
}

async function migratedSchemaFingerprint(runner: import('typeorm').QueryRunner) {
  const tables = await runner.query(`
    SELECT tablename AS table_name FROM pg_tables
    WHERE schemaname = 'public' ORDER BY tablename
  `);
  const columns = await runner.query(`
    SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable,
      column_default, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
  `);
  const constraints = await runner.query(`
    SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' ORDER BY c.relname, con.conname
  `);
  const indexes = await runner.query(`
    SELECT tablename AS table_name, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname
  `);
  const enums = await runner.query(`
    SELECT t.typname, e.enumsortorder, e.enumlabel FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder
  `);
  const migrationRows = await runner.query(
    'SELECT timestamp::text, name FROM migrations ORDER BY timestamp, name',
  );
  return createHash('sha256')
    .update(JSON.stringify({ tables, columns, constraints, indexes, enums, migrationRows }))
    .digest('hex');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
