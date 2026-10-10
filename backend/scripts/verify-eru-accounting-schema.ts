import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateEruAccountingSchema1787443200000 } from '../src/migrations/1787443200000-create-eru-accounting-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
const migration = new CreateEruAccountingSchema1787443200000();

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await preparePreEruSchema(runner);
    const fixture = await seedLegacyErt(runner);
    const legacyEvidence = await exactErtEvidence(runner, fixture.userId);

    await migration.up(runner);
    const firstFingerprint = await schemaFingerprint(runner);
    await assertUpSchema(runner, fixture.userId, legacyEvidence);
    await assertCurrencyConstraintsAndReferences(runner, fixture.userId);

    await migration.down(runner);
    await assertCleanDown(runner, fixture.userId, legacyEvidence);
    await migration.up(runner);
    assert.deepEqual(await schemaFingerprint(runner), firstFingerprint);
    await assertDownBlockedByEruState(runner, fixture.userId);

    console.log(JSON.stringify({
      database: databaseName,
      legacyErtPreservedExactly: true,
      existingLedgerBackfilledAsErt: true,
      eruNumeric48Scale0: true,
      currencyPurposeAndIntegerChecks: true,
      currencyAwareReferencesUnique: true,
      cleanUpDownUpStable: true,
      destructiveDownBlocked: true,
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
  await runner.query(`
    CREATE TABLE "users" (
      "id" uuid NOT NULL,
      CONSTRAINT "PK_eru_qa_users" PRIMARY KEY ("id")
    )
  `);
  await runner.query(`
    CREATE TYPE "public"."ledger_transactions_type_enum" AS ENUM (
      'WALK_REWARD', 'RAFFLE_SPEND', 'RAFFLE_REWARD', 'ADMIN_ADJUSTMENT',
      'RAFFLE_REFUND', 'COPPER_LEVEL_UP_SPEND'
    )
  `);
  await runner.query(`
    CREATE TABLE "balances" (
      "user_id" uuid NOT NULL,
      "ert_balance" numeric(48,18) NOT NULL DEFAULT 0,
      "lifetime_earned_ert" numeric(48,18) NOT NULL DEFAULT 0,
      "lifetime_spent_ert" numeric(48,18) NOT NULL DEFAULT 0,
      "updated_at" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "PK_eru_qa_balances" PRIMARY KEY ("user_id"),
      CONSTRAINT "FK_eru_qa_balance_user" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE
    )
  `);
  await runner.query(`
    CREATE TABLE "ledger_transactions" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "user_id" uuid NOT NULL,
      "type" "public"."ledger_transactions_type_enum" NOT NULL,
      "amount" numeric(48,18) NOT NULL,
      "balance_after" numeric(48,18) NOT NULL,
      "reference_type" varchar(64),
      "reference_id" varchar(128),
      "metadata" jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "PK_eru_qa_ledger" PRIMARY KEY ("id"),
      CONSTRAINT "FK_eru_qa_ledger_user" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE
    )
  `);
  await runner.query(`
    CREATE UNIQUE INDEX "UQ_ledger_copper_level_up_reference"
    ON "ledger_transactions" ("reference_type", "reference_id")
    WHERE "type" = 'COPPER_LEVEL_UP_SPEND' AND "reference_id" IS NOT NULL
  `);
}

async function seedLegacyErt(runner: QueryRunner) {
  const userId = randomUUID();
  await runner.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await runner.query(`
    INSERT INTO balances (
      user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert
    ) VALUES ($1, '123.456789012345678901', '150.456789012345678901', '27.000000000000000000')
  `, [userId]);
  await runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, amount, balance_after, reference_type, reference_id, metadata
    ) VALUES
      ($1, 'WALK_REWARD', '23.456789012345678901', '123.456789012345678901',
        'step_sync_batch', $2, '{"legacy":true}'::jsonb),
      ($1, 'COPPER_LEVEL_UP_SPEND', '-12.000000000000000000', '111.456789012345678901',
        'copper_level_up_operation', $3, '{"legacy":true}'::jsonb)
  `, [userId, randomUUID(), randomUUID()]);
  return { userId };
}

async function exactErtEvidence(runner: QueryRunner, userId: string) {
  const [balance] = await runner.query(`
    SELECT ert_balance::text AS balance, lifetime_earned_ert::text AS earned,
      lifetime_spent_ert::text AS spent, updated_at::text AS updated
    FROM balances WHERE user_id = $1
  `, [userId]);
  const ledger = await runner.query(`
    SELECT id::text, user_id::text, type::text, amount::text, balance_after::text,
      reference_type, reference_id, metadata::text, created_at::text
    FROM ledger_transactions WHERE user_id = $1 ORDER BY id
  `, [userId]);
  return { balance, ledger };
}

async function assertUpSchema(runner: QueryRunner, userId: string, legacyEvidence: unknown) {
  assert.deepEqual(await exactErtEvidence(runner, userId), legacyEvidence);
  const columns = await runner.query(`
    SELECT column_name AS name, numeric_precision AS precision, numeric_scale AS scale,
      is_nullable AS nullable, column_default AS "default"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'balances'
      AND column_name IN ('eru_balance', 'lifetime_earned_eru', 'lifetime_spent_eru')
    ORDER BY column_name
  `);
  assert.equal(columns.length, 3);
  for (const column of columns) {
    assert.equal(column.precision, 48);
    assert.equal(column.scale, 0);
    assert.equal(column.nullable, 'NO');
    assert.equal(column.default, '0');
  }
  const [balance] = await runner.query(`
    SELECT eru_balance::text AS balance, lifetime_earned_eru::text AS earned,
      lifetime_spent_eru::text AS spent FROM balances WHERE user_id = $1
  `, [userId]);
  assert.deepEqual(balance, { balance: '0', earned: '0', spent: '0' });
  const currencies = await runner.query(
    'SELECT DISTINCT currency::text AS currency FROM ledger_transactions ORDER BY currency',
  );
  assert.deepEqual(currencies, [{ currency: 'ERT' }]);
  const labels = await runner.query(`
    SELECT enumlabel AS label FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    WHERE pg_type.typname = 'ledger_currency_enum' ORDER BY enumsortorder
  `);
  assert.deepEqual(labels, [{ label: 'ERT' }, { label: 'ERU' }]);
}

async function assertCurrencyConstraintsAndReferences(runner: QueryRunner, userId: string) {
  const operationId = randomUUID();
  await runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'COPPER_LEVEL_UP_SPEND', 'ERT', -12, 99,
      'copper_level_up_operation', $2)
  `, [userId, operationId]);
  await runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'COPPER_LEVEL_UP_SPEND', 'ERU', -30, 70,
      'copper_level_up_operation', $2)
  `, [userId, operationId]);
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'COPPER_LEVEL_UP_SPEND', 'ERU', -30, 40,
      'copper_level_up_operation', $2)
  `, [userId, operationId]), '23505');
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (user_id, type, currency, amount, balance_after)
    VALUES ($1, 'WALK_REWARD', 'ERU', 1, 1)
  `, [userId]), '23514');
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (user_id, type, currency, amount, balance_after)
    VALUES ($1, 'ADMIN_ADJUSTMENT', 'ERU', 1, 1)
  `, [userId]), '23514');
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (user_id, type, currency, amount, balance_after)
    VALUES ($1, 'RAFFLE_REWARD', 'ERU', 1.5, 1.5)
  `, [userId]), '23514');
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (user_id, type, currency, amount, balance_after)
    VALUES ($1, 'RAFFLE_REWARD', 'ERU', -1, 1)
  `, [userId]), '23514');
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (user_id, type, currency, amount, balance_after)
    VALUES ($1, 'COPPER_LEVEL_UP_SPEND', 'ERU', 1, 1)
  `, [userId]), '23514');
  await assertPgCode(runner.query(`
    UPDATE balances SET eru_balance = -1 WHERE user_id = $1
  `, [userId]), '23514');

  const drawId = randomUUID();
  await runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'RAFFLE_REWARD', 'ERU', 5, 105, 'raffle_draw', $2)
  `, [userId, drawId]);
  await assertPgCode(runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'RAFFLE_REWARD', 'ERU', 5, 110, 'raffle_draw', $2)
  `, [userId, drawId]), '23505');

  await runner.query('DELETE FROM ledger_transactions WHERE currency = \'ERU\'');
  await runner.query(`
    DELETE FROM ledger_transactions
    WHERE reference_type = 'copper_level_up_operation' AND reference_id = $1
  `, [operationId]);
}

async function assertCleanDown(runner: QueryRunner, userId: string, legacyEvidence: unknown) {
  assert.equal(await runner.hasColumn('balances', 'eru_balance'), false);
  assert.equal(await runner.hasColumn('ledger_transactions', 'currency'), false);
  assert.deepEqual(await exactErtEvidence(runner, userId), legacyEvidence);
  const [index] = await runner.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'UQ_ledger_copper_level_up_reference'
  `);
  assert.ok(index.indexdef.includes('(reference_type, reference_id)'));
  assert.ok(!index.indexdef.includes('currency'));
}

async function assertDownBlockedByEruState(runner: QueryRunner, userId: string) {
  await runner.query('UPDATE balances SET eru_balance = 1, lifetime_earned_eru = 1 WHERE user_id = $1', [userId]);
  await assertPgCode(migration.down(runner), '23514');
  assert.equal(await runner.hasColumn('balances', 'eru_balance'), true);
  await runner.query('UPDATE balances SET eru_balance = 0, lifetime_earned_eru = 0 WHERE user_id = $1', [userId]);

  await runner.query(`
    INSERT INTO ledger_transactions (
      user_id, type, currency, amount, balance_after, reference_type, reference_id
    ) VALUES ($1, 'RAFFLE_REWARD', 'ERU', 1, 1, 'raffle_draw', $2)
  `, [userId, randomUUID()]);
  await assertPgCode(migration.down(runner), '23514');
  assert.equal(await runner.hasColumn('ledger_transactions', 'currency'), true);
}

async function schemaFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT kind, name, definition FROM (
      SELECT 'column' AS kind, table_name || '.' || column_name AS name,
        data_type || ':' || coalesce(udt_name, '') || ':'
          || coalesce(numeric_precision::text, '') || ':' || coalesce(numeric_scale::text, '')
          || ':' || is_nullable || ':' || coalesce(column_default, '') AS definition
      FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'balances' AND column_name LIKE '%eru%')
        OR (table_name = 'ledger_transactions' AND column_name = 'currency')
      )
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conname LIKE 'CHK_balances_%_eru%' OR conname LIKE 'CHK_ledger_%'
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'UQ_ledger_copper_level_up_reference',
        'UQ_ledger_eru_raffle_reward_reference'
      )
      UNION ALL
      SELECT 'enum', typname || '.' || enumlabel, enumsortorder::text
      FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE typname = 'ledger_currency_enum'
    ) fingerprint ORDER BY kind, name
  `);
}

async function assertPgCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === code;
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
