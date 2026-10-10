import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { CreateCopperRingSchema1787097600000 } from '../src/migrations/1787097600000-create-copper-ring-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
const migration = new CreateCopperRingSchema1787097600000();
const ringTables = ['game_rings', 'equipped_rings', 'ring_events'];

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let createdUsersTable = false;
  const userIds = [randomUUID(), randomUUID()];

  try {
    for (const table of ringTables) {
      if (await runner.hasTable(table)) throw new Error(`Disposable QA requires ${table} to be absent`);
    }

    if (!await runner.hasTable('users')) {
      createdUsersTable = true;
      await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await runner.query(`
        CREATE TABLE "users" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "telegram_id" varchar(64) NOT NULL,
          "username" varchar(64),
          "first_name" varchar(128),
          "last_name" varchar(128),
          "photo_url" varchar(512),
          "is_admin" boolean NOT NULL DEFAULT false,
          "last_login_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_users" PRIMARY KEY ("id"),
          CONSTRAINT "UQ_users_telegram_id" UNIQUE ("telegram_id")
        )
      `);
    }

    await runMigration(runner, migration, 'up');
    const firstFingerprint = await schemaFingerprint(runner);
    await runMigration(runner, migration, 'down');
    for (const table of ringTables) assert.equal(await runner.hasTable(table), false);
    await runMigration(runner, migration, 'up');
    assert.deepEqual(await schemaFingerprint(runner), firstFingerprint);

    for (let index = 0; index < userIds.length; index += 1) {
      await runner.query(`
        INSERT INTO "users" (
          "id", "telegram_id", "username", "first_name", "last_name", "photo_url",
          "is_admin", "last_login_at", "created_at", "updated_at"
        ) VALUES ($1, $2, $3, $4, NULL, NULL, false, now(), now(), now())
      `, [userIds[index], `copper-qa-${randomUUID()}`, `copper_qa_${index}`, `Copper QA ${index}`]);
    }

    await verifyRollbackBoundary(runner, userIds[0], userIds[1]);
    await verifyConstraints(runner, userIds[0], userIds[1]);

    console.log(JSON.stringify({
      migrationUpDownUp: true,
      schemaFingerprintStable: true,
      invalidValueChecks: true,
      oneStarterPerOwner: true,
      compositeEquipmentOwnership: true,
      immutableIdentity: true,
      appendOnlyEvents: true,
      transactionRollback: true,
    }, null, 2));
  } finally {
    if (await runner.hasTable('ring_events')) await runMigration(runner, migration, 'down');
    if (await runner.hasTable('users')) {
      await runner.query('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', [userIds]);
    }
    if (createdUsersTable && await runner.hasTable('users')) await runner.query('DROP TABLE "users"');
    await runner.release();
    await dataSource.destroy();
  }
}

async function verifyRollbackBoundary(runner: QueryRunner, ownerId: string, otherUserId: string) {
  const ringId = randomUUID();
  await runner.startTransaction();
  try {
    await insertRing(runner, { id: ringId, ownerId, visual: 'copper_plain_polished' });
    await runner.query('INSERT INTO "equipped_rings" ("user_id", "ring_id") VALUES ($1, $2)', [otherUserId, ringId]);
    await runner.commitTransaction();
    assert.fail('Cross-owner equipment unexpectedly committed');
  } catch (error) {
    await runner.rollbackTransaction();
    assert.equal(sqlState(error), '23503');
  }
  assert.equal(Number((await runner.query('SELECT COUNT(*)::int AS count FROM "game_rings" WHERE "id" = $1', [ringId]))[0].count), 0);
}

async function verifyConstraints(runner: QueryRunner, ownerId: string, otherUserId: string) {
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId, level: 0 }), '23514');
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId, level: 21 }), '23514');
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId, shine: 99 }), '23514');
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId, comfort: 1 }), '23514');
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId, visual: 'unknown_visual' }), '23514');

  const ringId = randomUUID();
  await insertRing(runner, { id: ringId, ownerId, visual: 'copper_signet' });
  await expectSqlState(() => insertRing(runner, { id: randomUUID(), ownerId }), '23505');

  await expectSqlState(
    () => runner.query('INSERT INTO "equipped_rings" ("user_id", "ring_id") VALUES ($1, $2)', [otherUserId, ringId]),
    '23503',
  );
  await runner.query('INSERT INTO "equipped_rings" ("user_id", "ring_id") VALUES ($1, $2)', [ownerId, ringId]);
  await expectSqlState(
    () => runner.query('INSERT INTO "equipped_rings" ("user_id", "ring_id") VALUES ($1, $2)', [otherUserId, ringId]),
    '23505',
  );

  await runner.query('UPDATE "game_rings" SET "level" = 2, "comfort" = 24, "updated_at" = now() WHERE "id" = $1', [ringId]);
  const updated = (await runner.query('SELECT "level", "comfort" FROM "game_rings" WHERE "id" = $1', [ringId]))[0];
  assert.equal(updated.level, 2);
  assert.equal(updated.comfort, 24);
  await expectSqlState(
    () => runner.query('UPDATE "game_rings" SET "visual_variant_code" = $2 WHERE "id" = $1', [ringId, 'copper_twisted']),
    '23514',
  );

  const eventId = randomUUID();
  await runner.query(`
    INSERT INTO "ring_events" (
      "id", "ring_id", "owner_user_id", "operation_key", "event_type", "ruleset_version", "snapshot"
    ) VALUES ($1, $2, $3, $4, 'STARTER_ISSUED', 'copper-rules-v1', $5::jsonb)
  `, [eventId, ringId, ownerId, `starter-copper-v1:${ownerId}`, JSON.stringify({ ringId, ownerId, equipped: true })]);
  await expectSqlState(
    () => runner.query(`
      INSERT INTO "ring_events" (
        "ring_id", "owner_user_id", "operation_key", "event_type", "ruleset_version", "snapshot"
      ) VALUES ($1, $2, $3, 'STARTER_ISSUED', 'copper-rules-v1', '{}'::jsonb)
    `, [ringId, ownerId, `second:${ownerId}`]),
    '23505',
  );
  await expectSqlState(
    () => runner.query('UPDATE "ring_events" SET "snapshot" = $2::jsonb WHERE "id" = $1', [eventId, '{}']),
    '23514',
  );
  await expectSqlState(() => runner.query('DELETE FROM "ring_events" WHERE "id" = $1', [eventId]), '23514');
  await expectSqlState(() => runner.query('DELETE FROM "users" WHERE "id" = $1', [ownerId]), '23503');
}

async function insertRing(runner: QueryRunner, input: {
  id: string;
  ownerId: string;
  level?: number;
  shine?: number;
  comfort?: number;
  visual?: string;
}) {
  return runner.query(`
    INSERT INTO "game_rings" (
      "id", "owner_user_id", "entitlement_code", "ring_kind", "status", "level", "shine",
      "comfort", "charm", "quality", "luck", "visual_variant_code", "ruleset_version",
      "generation_version", "visual_set_version", "issued_reason"
    ) VALUES ($1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', $3, $4, $5, 20, 7, 11, $6,
      'copper-rules-v1', 'copper-generation-v1', 'copper-visual-v1', 'REGISTRATION')
  `, [input.id, input.ownerId, input.level ?? 1, input.shine ?? 100, input.comfort ?? 2, input.visual ?? 'copper_plain_polished']);
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
      WHERE conrelid IN ('game_rings'::regclass, 'equipped_rings'::regclass, 'ring_events'::regclass)
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
  `, [ringTables]);
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
