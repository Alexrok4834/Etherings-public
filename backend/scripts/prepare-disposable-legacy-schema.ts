import 'reflect-metadata';
import path from 'node:path';
import { DataSource } from 'typeorm';
import {
  LEGACY_BASELINE_FINGERPRINT,
  LEGACY_BASELINE_SOURCE_COMMIT,
  legacyBaselineFingerprint,
  normalizeLegacyBaseline,
} from './fixtures/legacy-baseline-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) {
  throw new Error('Refusing to prepare a database whose name does not contain qa');
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [path.join(__dirname, '..', 'src', '**', '*.entity.{js,ts}')],
});

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    if (
      await runner.hasTable('step_sync_installations')
      || await runner.hasTable('mobile_refresh_tokens')
      || await runner.hasTable('raffle_machines')
      || await runner.hasTable('raffle_configurations')
      || await runner.hasTable('raffle_configuration_rewards')
    ) {
      throw new Error('Disposable legacy baseline requires all post-baseline tables to be absent');
    }
    await dataSource.synchronize(false);
    await removePostBaselineSchema(runner);
    await normalizeLegacyBaseline(runner);
    await compactLegacyTables(runner);
    await removePostBaselineEnums(runner);
    if (!(await runner.hasTable('users')) || !(await runner.hasTable('walk_sessions'))) {
      throw new Error('Legacy baseline schema was not created');
    }
    const fingerprint = await legacyBaselineFingerprint(runner);
    if (fingerprint !== LEGACY_BASELINE_FINGERPRINT) {
      throw new Error(`Legacy baseline fingerprint mismatch: ${fingerprint}`);
    }
    console.log(JSON.stringify({
      legacyBaselinePrepared: true,
      database: databaseName,
      sourceCommit: LEGACY_BASELINE_SOURCE_COMMIT,
      fingerprint,
    }));
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

const legacyTables = new Set([
  'balances', 'daily_user_stats', 'ledger_transactions', 'raffle_draws', 'raffle_pool_rewards',
  'raffle_pools', 'rewards', 'user_rewards', 'users', 'walk_sessions',
]);
const legacyEnums = new Set([
  'ledger_transactions_type_enum', 'rewards_type_enum', 'user_rewards_type_enum',
  'walk_sessions_source_enum', 'walk_sessions_status_enum',
]);

async function removePostBaselineSchema(runner: import('typeorm').QueryRunner) {
  const tables = await runner.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `) as Array<{ tablename: string }>;
  for (const { tablename } of tables.reverse()) {
    if (!legacyTables.has(tablename)) await runner.query(`DROP TABLE "${tablename}" CASCADE`);
  }
  await runner.query('DROP INDEX IF EXISTS "UQ_user_rewards_raffle_draw_result_v2"');
  await runner.query('DROP INDEX IF EXISTS "UQ_ledger_walk_reward_reference"');
  await runner.query('ALTER TABLE "user_rewards" DROP CONSTRAINT IF EXISTS "CHK_user_rewards_source"');
  await runner.query('ALTER TABLE "user_rewards" DROP CONSTRAINT IF EXISTS "CHK_user_rewards_copper_ring_shape"');
  await runner.query('ALTER TABLE "user_rewards" DROP COLUMN IF EXISTS "raffle_draw_result_v2_id"');
  await runner.query('ALTER TABLE "user_rewards" ALTER COLUMN "raffle_draw_id" SET NOT NULL');
  await runner.query('ALTER TABLE "rewards" DROP CONSTRAINT IF EXISTS "CHK_rewards_copper_ring_shape"');

}

async function removePostBaselineEnums(runner: import('typeorm').QueryRunner) {
  const enums = await runner.query(`
    SELECT t.typname FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname ORDER BY t.typname
  `) as Array<{ typname: string }>;
  for (const { typname } of enums) {
    if (!legacyEnums.has(typname)) await runner.query(`DROP TYPE "public"."${typname}"`);
  }
}

async function compactLegacyTables(runner: import('typeorm').QueryRunner) {
  for (const table of legacyTables) {
    const [{ column_count: columnCount, max_position: maxPosition }] = await runner.query(`
      SELECT count(*)::int AS column_count, max(ordinal_position)::int AS max_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
    `, [table]) as Array<{ column_count: number; max_position: number }>;
    if (columnCount === maxPosition) continue;
    await compactTable(runner, table);
  }
}

async function compactTable(runner: import('typeorm').QueryRunner, table: string) {
  const columns = await runner.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]) as Array<{ column_name: string }>;
  const constraints = await runner.query(`
    SELECT source.relname AS table_name, con.conname,
      pg_get_constraintdef(con.oid, true) AS definition,
      con.contype
    FROM pg_constraint con
    JOIN pg_class source ON source.oid = con.conrelid
    JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
    WHERE namespace.nspname = 'public'
      AND (source.relname = $1 OR con.confrelid = $1::regclass)
    ORDER BY CASE WHEN con.contype = 'f' THEN 1 ELSE 0 END, source.relname, con.conname
  `, [table]) as Array<{ table_name: string; conname: string; definition: string; contype: string }>;
  const indexes = await runner.query(`
    SELECT pg_get_indexdef(index_class.oid) AS definition
    FROM pg_index index_data
    JOIN pg_class table_class ON table_class.oid = index_data.indrelid
    JOIN pg_class index_class ON index_class.oid = index_data.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public' AND table_class.relname = $1
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint constraint_data
        WHERE constraint_data.conindid = index_data.indexrelid
      )
    ORDER BY index_class.relname
  `, [table]) as Array<{ definition: string }>;
  const quotedColumns = columns.map(({ column_name: name }) => quoteIdentifier(name)).join(', ');
  const temporaryTable = `${table}__legacy_compact`;

  await runner.startTransaction();
  try {
    await runner.query(`CREATE TABLE ${quoteIdentifier(temporaryTable)} (
      LIKE ${quoteIdentifier(table)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY
    )`);
    await runner.query(`INSERT INTO ${quoteIdentifier(temporaryTable)} (${quotedColumns})
      SELECT ${quotedColumns} FROM ${quoteIdentifier(table)}`);
    await runner.query(`DROP TABLE ${quoteIdentifier(table)} CASCADE`);
    await runner.query(`ALTER TABLE ${quoteIdentifier(temporaryTable)} RENAME TO ${quoteIdentifier(table)}`);
    for (const constraint of constraints.filter(({ contype }) => contype !== 'f')) {
      await runner.query(`ALTER TABLE ${quoteIdentifier(constraint.table_name)}
        ADD CONSTRAINT ${quoteIdentifier(constraint.conname)} ${constraint.definition}`);
    }
    for (const constraint of constraints.filter(({ contype }) => contype === 'f')) {
      await runner.query(`ALTER TABLE ${quoteIdentifier(constraint.table_name)}
        ADD CONSTRAINT ${quoteIdentifier(constraint.conname)} ${constraint.definition}`);
    }
    for (const index of indexes) await runner.query(index.definition);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
