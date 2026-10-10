import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateStepSyncSchema1786406400000 } from '../src/migrations/1786406400000-create-step-sync-schema';
import { CreateMobileRefreshTokens1786492800000 } from '../src/migrations/1786492800000-create-mobile-refresh-tokens';
import { CreateMobileCredentials1786665600000 } from '../src/migrations/1786665600000-create-mobile-credentials';
import { CreateCopperRingSchema1787097600000 } from '../src/migrations/1787097600000-create-copper-ring-schema';
import { CreateCopperLevelUpSchema1787184000000 } from '../src/migrations/1787184000000-create-copper-level-up-schema';
import { CreateCopperDeferredAllocationSchema1787270400000 } from '../src/migrations/1787270400000-create-copper-deferred-allocation-schema';
import { AllowCopperBulkAllocationV21788220800000 } from '../src/migrations/1788220800000-allow-copper-bulk-allocation-v2';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
const migration = new CreateCopperDeferredAllocationSchema1787270400000();
const bulkMigration = new AllowCopperBulkAllocationV21788220800000();

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await prepareV1Baseline(runner);
    const fixture = await seedV1History(runner);

    await migration.up(runner);
    await bulkMigration.up(runner);
    const firstFingerprint = await schemaFingerprint(runner);
    await assertV1HistoryPreserved(runner, fixture);

    await bulkMigration.down(runner);
    await migration.down(runner);
    await assertCleanDown(runner, fixture);
    await migration.up(runner);
    await bulkMigration.up(runner);
    assert.deepEqual(await schemaFingerprint(runner), firstFingerprint);

    await assertConstraintsAndImmutability(runner, fixture);
    await assertUnsafeDownBlocked(runner);

    console.log(JSON.stringify({
      database: databaseName,
      existingRingsDefaultToZero: true,
      v1HistoryPreserved: true,
      cleanUpDownUpStable: true,
      allocationOwnershipAndIdempotencyEnforced: true,
      allocationOperationsImmutable: true,
      allocationEventsAppendOnly: true,
      v1AndV2AllocationVersionsAllowed: true,
      v2EvidenceBlocksDowngrade: true,
      unsafeDownBlocked: true,
    }, null, 2));
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

async function prepareV1Baseline(runner: QueryRunner) {
  assert.equal(await runner.hasTable('users'), true, 'Run qa:prepare-legacy-schema first');
  assert.equal(await runner.hasTable('game_rings'), false, 'QA database must be disposable and fresh');

  const migrations = [
    new CreateStepSyncSchema1786406400000(),
    new CreateMobileRefreshTokens1786492800000(),
    new CreateMobileCredentials1786665600000(),
    new CreateCopperRingSchema1787097600000(),
    new CreateCopperLevelUpSchema1787184000000(),
  ];
  await runner.startTransaction();
  try {
    for (const current of migrations) await current.up(runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

async function seedV1History(runner: QueryRunner) {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const ringId = randomUUID();
  const operationId = randomUUID();
  for (const [id, suffix] of [[userId, 'owner'], [otherUserId, 'other']]) {
    await runner.query(`
      INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
      VALUES ($1, $2, $3, 'Deferred QA', false, now(), now())
    `, [id, `deferred-qa-${suffix}-${randomUUID()}`, `deferred_qa_${suffix}_${randomUUID().replaceAll('-', '')}`]);
  }
  await runner.query(`
    INSERT INTO game_rings (
      id, owner_user_id, entitlement_code, ring_kind, status, level, shine,
      comfort, charm, quality, luck, visual_variant_code, ruleset_version,
      generation_version, visual_set_version, issued_reason, created_at, updated_at
    ) VALUES (
      $1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', 2, 100,
      6, 20, 7, 11, 'copper_plain_polished', 'copper-rules-v1',
      'copper-generation-v1', 'copper-visual-v1', 'REGISTRATION', now(), now()
    )
  `, [ringId, userId]);
  await runner.query(`
    INSERT INTO copper_level_up_operations (
      id, owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, $5, 'copper-level-up-v1', 'COMPLETED', $6::jsonb)
  `, [operationId, userId, ringId, randomUUID(), 'a'.repeat(64), JSON.stringify({ level: 2 })]);
  await runner.query(`
    INSERT INTO ring_events (
      ring_id, owner_user_id, operation_key, event_type, ruleset_version, snapshot
    ) VALUES ($1, $2, $3, 'LEVEL_UP', 'copper-rules-v1', $4::jsonb)
  `, [ringId, userId, `level-up:${operationId}`, JSON.stringify({ level: 2 })]);
  return { userId, otherUserId, ringId, operationId };
}

async function assertV1HistoryPreserved(
  runner: QueryRunner,
  fixture: { ringId: string; operationId: string },
) {
  const [ring] = await runner.query(`
    SELECT level, comfort, charm, quality, luck,
      unspent_attribute_points AS "unspentAttributePoints"
    FROM game_rings WHERE id = $1
  `, [fixture.ringId]);
  assert.deepEqual(ring, {
    level: 2,
    comfort: 6,
    charm: 20,
    quality: 7,
    luck: 11,
    unspentAttributePoints: 0,
  });
  const [operation] = await runner.query(
    'SELECT rules_version AS "rulesVersion", status FROM copper_level_up_operations WHERE id = $1',
    [fixture.operationId],
  );
  assert.deepEqual(operation, { rulesVersion: 'copper-level-up-v1', status: 'COMPLETED' });
}

async function assertCleanDown(runner: QueryRunner, fixture: { operationId: string }) {
  assert.equal(await runner.hasColumn('game_rings', 'unspent_attribute_points'), false);
  assert.equal(await runner.hasTable('copper_attribute_allocation_operations'), false);
  const [operation] = await runner.query(
    'SELECT rules_version AS "rulesVersion" FROM copper_level_up_operations WHERE id = $1',
    [fixture.operationId],
  );
  assert.deepEqual(operation, { rulesVersion: 'copper-level-up-v1' });
}

async function schemaFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT kind, name, definition FROM (
      SELECT 'column' AS kind, column_name AS name,
        data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS definition
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'game_rings'
        AND column_name = 'unspent_attribute_points'
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid IN (
        'game_rings'::regclass,
        'copper_level_up_operations'::regclass,
        'ring_events'::regclass,
        'copper_attribute_allocation_operations'::regclass
      ) AND conname LIKE 'CHK_%'
      UNION ALL
      SELECT 'trigger', trigger_name, action_statement
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'copper_attribute_allocation_operations'
    ) schema_objects ORDER BY kind, name
  `);
}

async function assertConstraintsAndImmutability(
  runner: QueryRunner,
  fixture: { userId: string; otherUserId: string; ringId: string },
) {
  await expectPgCode(
    runner.query('UPDATE game_rings SET unspent_attribute_points = -1 WHERE id = $1', [fixture.ringId]),
    '23514',
  );
  await expectPgCode(
    runner.query('UPDATE game_rings SET unspent_attribute_points = 77 WHERE id = $1', [fixture.ringId]),
    '23514',
  );
  await expectPgCode(runner.query(`
    INSERT INTO copper_level_up_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-level-up-v3', 'PENDING', NULL)
  `, [fixture.userId, fixture.ringId, randomUUID(), 'b'.repeat(64)]), '23514');
  await expectPgCode(runner.query(`
    INSERT INTO copper_level_up_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-level-up-v2', 'COMPLETED', NULL)
  `, [fixture.userId, fixture.ringId, randomUUID(), 'b'.repeat(64)]), '23514');

  await expectInvalidAllocation(runner, fixture, {
    fingerprint: 'not-a-sha256',
    rulesVersion: 'copper-attribute-allocation-v1',
    status: 'PENDING',
    response: null,
  });
  await expectInvalidAllocation(runner, fixture, {
    fingerprint: 'b'.repeat(64),
    rulesVersion: 'copper-attribute-allocation-v3',
    status: 'PENDING',
    response: null,
  });
  await expectInvalidAllocation(runner, fixture, {
    fingerprint: 'b'.repeat(64),
    rulesVersion: 'copper-attribute-allocation-v1',
    status: 'COMPLETED',
    response: null,
  });

  const operationId = randomUUID();
  const idempotencyKey = randomUUID();
  await runner.query(`
    INSERT INTO copper_attribute_allocation_operations (
      id, owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, $5, 'copper-attribute-allocation-v1', 'PENDING', NULL)
  `, [operationId, fixture.userId, fixture.ringId, idempotencyKey, 'c'.repeat(64)]);
  await expectPgCode(runner.query(`
    INSERT INTO copper_attribute_allocation_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-attribute-allocation-v1', 'PENDING', NULL)
  `, [fixture.userId, fixture.ringId, idempotencyKey, 'd'.repeat(64)]), '23505');
  await expectPgCode(runner.query(`
    INSERT INTO copper_attribute_allocation_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-attribute-allocation-v1', 'PENDING', NULL)
  `, [fixture.otherUserId, fixture.ringId, randomUUID(), 'e'.repeat(64)]), '23503');

  await runner.query(`
    UPDATE copper_attribute_allocation_operations
    SET status = 'COMPLETED', response_snapshot = $2::jsonb, updated_at = now()
    WHERE id = $1
  `, [operationId, JSON.stringify({ allocated: 4, remaining: 0 })]);
  await expectPgCode(
    runner.query('UPDATE copper_attribute_allocation_operations SET updated_at = now() WHERE id = $1', [operationId]),
    '23514',
  );
  await expectPgCode(
    runner.query('DELETE FROM copper_attribute_allocation_operations WHERE id = $1', [operationId]),
    '23514',
  );

  await runner.query(`
    INSERT INTO ring_events (
      ring_id, owner_user_id, operation_key, event_type, ruleset_version, snapshot
    ) VALUES ($1, $2, $3, 'ATTRIBUTE_POINTS_ALLOCATED', 'copper-rules-v1', $4::jsonb)
  `, [fixture.ringId, fixture.userId, `attribute-allocation:${operationId}`, JSON.stringify({ allocated: 4 })]);
  await expectPgCode(
    runner.query("UPDATE ring_events SET snapshot = '{}'::jsonb WHERE operation_key = $1", [`attribute-allocation:${operationId}`]),
    '23514',
  );
  await runner.query('UPDATE game_rings SET unspent_attribute_points = 4 WHERE id = $1', [fixture.ringId]);
  await runner.query(`
    INSERT INTO copper_level_up_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-level-up-v2', 'COMPLETED', $5::jsonb)
  `, [fixture.userId, fixture.ringId, randomUUID(), 'f'.repeat(64), JSON.stringify({ unspentAttributePoints: 4 })]);

  await runner.query(`
    INSERT INTO copper_attribute_allocation_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, 'copper-attribute-allocation-v2', 'COMPLETED', $5::jsonb)
  `, [
    fixture.userId,
    fixture.ringId,
    randomUUID(),
    '1'.repeat(64),
    JSON.stringify({ rulesVersion: 'copper-attribute-allocation-v2', allocated: 4 }),
  ]);
}

async function expectInvalidAllocation(
  runner: QueryRunner,
  fixture: { userId: string; ringId: string },
  values: { fingerprint: string; rulesVersion: string; status: string; response: object | null },
) {
  await expectPgCode(runner.query(`
    INSERT INTO copper_attribute_allocation_operations (
      owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [
    fixture.userId,
    fixture.ringId,
    randomUUID(),
    values.fingerprint,
    values.rulesVersion,
    values.status,
    values.response === null ? null : JSON.stringify(values.response),
  ]), '23514');
}

async function assertUnsafeDownBlocked(runner: QueryRunner) {
  await runner.startTransaction();
  try {
    await assert.rejects(
      bulkMigration.down(runner),
      (error) => pgCode(error) === '23514',
    );
  } finally {
    await runner.rollbackTransaction();
  }
  await runner.startTransaction();
  try {
    await assert.rejects(
      migration.down(runner),
      (error) => pgCode(error) === '23514',
    );
  } finally {
    await runner.rollbackTransaction();
  }
  assert.equal(await runner.hasColumn('game_rings', 'unspent_attribute_points'), true);
  assert.equal(await runner.hasTable('copper_attribute_allocation_operations'), true);
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
