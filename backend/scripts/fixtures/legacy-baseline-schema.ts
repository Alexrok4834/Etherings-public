import { createHash } from 'node:crypto';
import { QueryRunner } from 'typeorm';

export const LEGACY_BASELINE_SOURCE_COMMIT = 'db00945';
export const LEGACY_BASELINE_FINGERPRINT = '58652e186e395122324eec3e1234f6c4e5b150915ccfa1e7f9af5aeccbd83aaa';

const baselineTables = [
  'balances',
  'daily_user_stats',
  'ledger_transactions',
  'raffle_draws',
  'raffle_pool_rewards',
  'raffle_pools',
  'rewards',
  'user_rewards',
  'users',
  'walk_sessions',
];

export async function normalizeLegacyBaseline(runner: QueryRunner) {
  await runner.startTransaction();
  try {
    await runner.query('DROP INDEX IF EXISTS "UQ_ledger_eru_raffle_reward_reference"');
    await runner.query('DROP INDEX IF EXISTS "UQ_ledger_copper_level_up_reference"');
    await runner.query('ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "CHK_ledger_currency_purpose"');
    await runner.query('ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "CHK_ledger_eru_integer_values"');
    await runner.query('ALTER TABLE "ledger_transactions" DROP COLUMN IF EXISTS "currency"');
    await replaceEnum(runner, 'ledger_transactions', 'type', 'ledger_transactions_type_enum', [
      'WALK_REWARD',
      'RAFFLE_SPEND',
      'RAFFLE_REWARD',
      'ADMIN_ADJUSTMENT',
      'RAFFLE_REFUND',
    ]);
    await runner.query('DROP TYPE IF EXISTS "public"."ledger_currency_enum"');
    await runner.query(`
      ALTER TABLE "ledger_transactions"
      ALTER COLUMN "amount" TYPE numeric(24,0) USING "amount"::numeric(24,0),
      ALTER COLUMN "balance_after" TYPE numeric(24,0) USING "balance_after"::numeric(24,0)
    `);

    await runner.query('ALTER TABLE "balances" DROP CONSTRAINT IF EXISTS "CHK_balances_eru_balance"');
    await runner.query('ALTER TABLE "balances" DROP CONSTRAINT IF EXISTS "CHK_balances_lifetime_earned_eru"');
    await runner.query('ALTER TABLE "balances" DROP CONSTRAINT IF EXISTS "CHK_balances_lifetime_spent_eru"');
    await runner.query(`
      ALTER TABLE "balances"
      DROP COLUMN IF EXISTS "eru_balance",
      DROP COLUMN IF EXISTS "lifetime_earned_eru",
      DROP COLUMN IF EXISTS "lifetime_spent_eru",
      ALTER COLUMN "ert_balance" TYPE numeric(24,0) USING "ert_balance"::numeric(24,0),
      ALTER COLUMN "lifetime_earned_ert" TYPE numeric(24,0) USING "lifetime_earned_ert"::numeric(24,0),
      ALTER COLUMN "lifetime_spent_ert" TYPE numeric(24,0) USING "lifetime_spent_ert"::numeric(24,0)
    `);

    await runner.query('ALTER TABLE "rewards" DROP CONSTRAINT IF EXISTS "CHK_rewards_eru_amount_exact"');
    await runner.query('ALTER TABLE "rewards" DROP COLUMN IF EXISTS "amount_exact"');
    await replaceEnum(runner, 'rewards', 'type', 'rewards_type_enum', [
      'ERT', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER',
    ]);

    await runner.query('ALTER TABLE "user_rewards" DROP CONSTRAINT IF EXISTS "CHK_user_rewards_eru_amount_exact"');
    await runner.query('ALTER TABLE "user_rewards" DROP CONSTRAINT IF EXISTS "CHK_user_rewards_eru_balance_after"');
    await runner.query(`
      ALTER TABLE "user_rewards"
      DROP COLUMN IF EXISTS "amount_exact",
      DROP COLUMN IF EXISTS "eru_balance_after"
    `);
    await replaceEnum(runner, 'user_rewards', 'type', 'user_rewards_type_enum', [
      'ERT', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER',
    ]);

    await runner.query(`
      ALTER TABLE "daily_user_stats"
      ALTER COLUMN "earned_ert" TYPE numeric(24,0) USING "earned_ert"::numeric(24,0)
    `);
    await runner.query(`
      ALTER TABLE "walk_sessions"
      ALTER COLUMN "earned_ert" TYPE numeric(24,0) USING "earned_ert"::numeric(24,0)
    `);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

export async function legacyBaselineFingerprint(runner: QueryRunner) {
  const tables = await runner.query(`
    SELECT tablename AS table_name
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const columns = await runner.query(`
      SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable,
        column_default, character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [baselineTables]);
  const constraints = await runner.query(`
      SELECT c.relname AS table_name, con.conname,
        pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname, con.conname
    `, [baselineTables]);
  const indexes = await runner.query(`
      SELECT tablename AS table_name, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename, indexname
    `, [baselineTables]);
  const enums = await runner.query(`
      SELECT t.typname, e.enumsortorder, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `);
  const document = { sourceCommit: LEGACY_BASELINE_SOURCE_COMMIT, tables, columns, constraints, indexes, enums };
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

async function replaceEnum(
  runner: QueryRunner,
  table: string,
  column: string,
  enumName: string,
  values: string[],
) {
  await runner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE varchar USING "${column}"::text`);
  await runner.query(`DROP TYPE "public"."${enumName}"`);
  await runner.query(`CREATE TYPE "public"."${enumName}" AS ENUM (${values.map(sqlLiteral).join(', ')})`);
  await runner.query(`
    ALTER TABLE "${table}" ALTER COLUMN "${column}"
    TYPE "public"."${enumName}" USING "${column}"::"public"."${enumName}"
  `);
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
