import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { CreateRaffleV2SingletonSchema1787616000000 } from '../src/migrations/1787616000000-create-raffle-v2-singleton-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
const migration = new CreateRaffleV2SingletonSchema1787616000000();
const tables = ['raffle_machines', 'raffle_configurations', 'raffle_configuration_rewards'];

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await resetMinimalLegacySchema(runner);
    await runMigration(runner, migration, 'up');
    const firstFingerprint = await schemaFingerprint(runner);
    await runMigration(runner, migration, 'down');
    for (const table of tables) assert.equal(await runner.hasTable(table), false);
    await runMigration(runner, migration, 'up');
    assert.deepEqual(await schemaFingerprint(runner), firstFingerprint);

    await verifyGuards(runner);
    await assert.rejects(() => migration.down(runner), /while v2 rows exist/);
    for (const table of tables) assert.equal(await runner.hasTable(table), true);

    console.log(JSON.stringify({
      database: databaseName,
      migrationUpDownUp: true,
      schemaFingerprintStable: true,
      singletonMachineEnforced: true,
      oneActiveConfigurationEnforced: true,
      lifecycleImmutable: true,
      orderedMappingsValidated: true,
      immutableRewardSnapshots: true,
      populatedDownBlocked: true,
    }, null, 2));
  } finally {
    await runner.query('DROP SCHEMA public CASCADE');
    await runner.query('CREATE SCHEMA public');
    await runner.release();
    await dataSource.destroy();
  }
}

async function resetMinimalLegacySchema(runner: QueryRunner) {
  await runner.query('DROP SCHEMA public CASCADE');
  await runner.query('CREATE SCHEMA public');
  await runner.query('CREATE TABLE users (id uuid PRIMARY KEY)');
  await runner.query('CREATE TABLE rewards (id uuid PRIMARY KEY, is_active boolean NOT NULL)');
}

async function verifyGuards(runner: QueryRunner) {
  const creatorId = randomUUID();
  const rewardIds = [randomUUID(), randomUUID(), randomUUID()];
  await runner.query('INSERT INTO users (id) VALUES ($1)', [creatorId]);
  await runner.query(
    'INSERT INTO rewards (id, is_active) VALUES ($1, true), ($2, true), ($3, false)',
    rewardIds,
  );

  const machineId = randomUUID();
  await runner.query(
    'INSERT INTO raffle_machines (id, code) VALUES ($1, $2)',
    [machineId, 'daily-draw'],
  );
  await expectSqlState(
    () => runner.query('INSERT INTO raffle_machines (id, code) VALUES ($1, $2)', [randomUUID(), 'other']),
    '23505',
  );
  await expectSqlState(
    () => runner.query('UPDATE raffle_machines SET code = $2 WHERE id = $1', [machineId, 'changed']),
    '23514',
  );

  const emptyId = await insertDraft(runner, machineId, creatorId, 'Empty');
  await expectSqlState(() => activate(runner, emptyId), '23514');
  await expectSqlState(
    () => insertConfiguration(runner, machineId, creatorId, 'ACTIVE', 'Direct active'),
    '23514',
  );

  const invalidId = await insertDraft(runner, machineId, creatorId, 'Invalid mappings');
  await expectSqlState(
    () => insertMapping(runner, invalidId, rewardIds[0], -1, 1, rewardSnapshot(rewardIds[0], '5')),
    '23514',
  );
  await expectSqlState(
    () => insertMapping(runner, invalidId, rewardIds[0], 0, 0, rewardSnapshot(rewardIds[0], '5')),
    '23514',
  );
  await expectSqlState(
    () => insertMapping(runner, invalidId, rewardIds[0], 0, 1, []),
    '23514',
  );
  await insertMapping(runner, invalidId, rewardIds[0], 0, 30, rewardSnapshot(rewardIds[0], '5'));
  await expectSqlState(
    () => insertMapping(runner, invalidId, rewardIds[1], 0, 20, rewardSnapshot(rewardIds[1], '10')),
    '23505',
  );
  await insertMapping(runner, invalidId, rewardIds[1], 2, 20, rewardSnapshot(rewardIds[1], '10'));
  await expectSqlState(() => activate(runner, invalidId), '23514');
  await runner.query(
    'UPDATE raffle_configuration_rewards SET segment_index = 1 WHERE configuration_id = $1 AND reward_id = $2',
    [invalidId, rewardIds[1]],
  );
  await runner.query(
    'UPDATE raffle_configuration_rewards SET reward_id = $3, reward_snapshot = $4::jsonb '
      + 'WHERE configuration_id = $1 AND reward_id = $2',
    [invalidId, rewardIds[1], rewardIds[2], JSON.stringify(rewardSnapshot(rewardIds[2], '20'))],
  );
  await expectSqlState(() => activate(runner, invalidId), '23514');
  await runner.query('UPDATE rewards SET is_active = true WHERE id = $1', [rewardIds[2]]);
  await activate(runner, invalidId);

  await expectSqlState(
    () => runner.query('UPDATE raffle_configurations SET cost_ert = 6 WHERE id = $1', [invalidId]),
    '23514',
  );
  await expectSqlState(
    () => runner.query('UPDATE raffle_configuration_rewards SET weight = 31 WHERE configuration_id = $1', [invalidId]),
    '23514',
  );
  await expectSqlState(
    () => runner.query('DELETE FROM raffle_configuration_rewards WHERE configuration_id = $1', [invalidId]),
    '23514',
  );

  const secondId = await insertDraft(runner, machineId, creatorId, 'Second');
  await insertMapping(runner, secondId, rewardIds[0], 0, 100, rewardSnapshot(rewardIds[0], '5'));
  await expectSqlState(() => activate(runner, secondId), '23505');
  await runner.query(
    'UPDATE raffle_configurations SET status = \'DISABLED\', disabled_at = now() WHERE id = $1',
    [invalidId],
  );
  await activate(runner, secondId);
  await expectSqlState(
    () => runner.query('UPDATE raffle_configurations SET status = \'DRAFT\', activated_at = NULL WHERE id = $1', [secondId]),
    '23514',
  );
}

async function insertDraft(runner: QueryRunner, machineId: string, creatorId: string, title: string) {
  const id = randomUUID();
  await insertConfiguration(runner, machineId, creatorId, 'DRAFT', title, id);
  return id;
}

async function insertConfiguration(
  runner: QueryRunner,
  machineId: string,
  creatorId: string,
  status: string,
  title: string,
  id = randomUUID(),
) {
  return runner.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, cost_ert,
      daily_user_attempt_limit, created_by_user_id, activated_at
    ) VALUES (
      $1, $2, 'raffle-v2', $3::varchar, $4, 5, 5, $5,
      CASE WHEN $3::varchar = 'ACTIVE' THEN now() END
    )
  `, [id, machineId, status, title, creatorId]);
}

async function insertMapping(
  runner: QueryRunner,
  configurationId: string,
  rewardId: string,
  segmentIndex: number,
  weight: number,
  snapshot: unknown,
) {
  return runner.query(`
    INSERT INTO raffle_configuration_rewards (
      configuration_id, reward_id, segment_index, weight, reward_snapshot
    ) VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [configurationId, rewardId, segmentIndex, weight, JSON.stringify(snapshot)]);
}

function activate(runner: QueryRunner, configurationId: string) {
  return runner.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
}

function rewardSnapshot(rewardId: string, amount: string) {
  return { rewardId, code: `ert-${amount}`, title: `${amount} ERT`, type: 'ERT', amountExact: amount };
}

async function schemaFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT kind, object_name, definition FROM (
      SELECT 'column' AS kind, table_name || '.' || column_name AS object_name,
        data_type || ':' || is_nullable || ':' || COALESCE(column_default, '') AS definition
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
      UNION ALL
      SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid IN (
        'raffle_machines'::regclass,
        'raffle_configurations'::regclass,
        'raffle_configuration_rewards'::regclass
      )
      UNION ALL
      SELECT 'index', tablename || '.' || indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = ANY($1::text[])
      UNION ALL
      SELECT 'trigger', event_object_table || '.' || trigger_name,
        action_timing || ':' || event_manipulation || ':' || action_statement
      FROM information_schema.triggers
      WHERE trigger_schema = current_schema() AND event_object_table = ANY($1::text[])
    ) fingerprint
    ORDER BY kind, object_name, definition
  `, [tables]);
}

async function expectSqlState(operation: () => Promise<unknown>, expected: string) {
  await assert.rejects(operation, (error) => sqlState(error) === expected);
}

function sqlState(error: unknown) {
  return (error as { code?: string }).code;
}

async function runMigration(runner: QueryRunner, value: MigrationInterface, direction: 'up' | 'down') {
  await runner.startTransaction();
  try {
    await value[direction](runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

void main();
