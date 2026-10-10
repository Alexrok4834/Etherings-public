import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { CopperAttributeAllocationErrorCode } from '../src/ring/copper-attribute-allocation-errors';
import {
  COPPER_ATTRIBUTE_ALLOCATION_V1,
  COPPER_ATTRIBUTE_ALLOCATION_VERSION,
  CopperAttributeAllocationOperation,
} from '../src/ring/copper-attribute-allocation-operation.entity';
import { CopperAttributeAllocationService } from '../src/ring/copper-attribute-allocation.service';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { GameRing } from '../src/ring/game-ring.entity';
import { RingEvent } from '../src/ring/ring-event.entity';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, GameRing, RingEvent, CopperAttributeAllocationOperation],
});
const service = new CopperAttributeAllocationService(new CopperRingRepository(dataSource));

type Fixture = { user: User; ringId: string };

async function main() {
  await dataSource.initialize();
  try {
    await assertSchemaReady();
    const primary = await seedFixture(76);

    const firstKey = randomUUID();
    const firstRequest = request(76, { comfort: 1, charm: 0, quality: 0, luck: 0 }, firstKey);
    const first = await service.allocate(primary.user, primary.ringId, firstRequest);
    const replay = await service.allocate(primary.user, primary.ringId, firstRequest);
    assert.deepEqual(replay, first);
    await assertState(primary, { unspent: 75, comfort: 21, charm: 7, quality: 11, luck: 2, operations: 1, events: 1 });

    const sameKey = randomUUID();
    const sameRequest = request(75, { comfort: 0, charm: 4, quality: 0, luck: 0 }, sameKey);
    const sameRace = await Promise.all([
      service.allocate(primary.user, primary.ringId, sameRequest),
      service.allocate(primary.user, primary.ringId, sameRequest),
    ]);
    assert.deepEqual(sameRace[1], sameRace[0]);
    await assertState(primary, { unspent: 71, comfort: 21, charm: 11, quality: 11, luck: 2, operations: 2, events: 2 });

    const differentKeyRace = await Promise.allSettled([
      service.allocate(primary.user, primary.ringId,
        request(71, { comfort: 0, charm: 0, quality: 20, luck: 0 }, randomUUID())),
      service.allocate(primary.user, primary.ringId,
        request(71, { comfort: 0, charm: 0, quality: 20, luck: 0 }, randomUUID())),
    ]);
    assert.equal(differentKeyRace.filter((result) => result.status === 'fulfilled').length, 1);
    const stale = differentKeyRace.find((result) => result.status === 'rejected');
    assert.ok(stale && stale.status === 'rejected');
    assert.equal(codeOf(stale.reason), CopperAttributeAllocationErrorCode.StalePoints);
    await assertState(primary, { unspent: 51, comfort: 21, charm: 11, quality: 31, luck: 2, operations: 3, events: 3 });

    await service.allocate(primary.user, primary.ringId,
      request(51, { comfort: 10, charm: 10, quality: 10, luck: 21 }, randomUUID()));
    await assertState(primary, { unspent: 0, comfort: 31, charm: 21, quality: 41, luck: 23, operations: 4, events: 4 });

    await assert.rejects(
      service.allocate(primary.user, primary.ringId,
        request(1, { comfort: 1, charm: 0, quality: 0, luck: 0 }, firstKey)),
      (error) => codeOf(error) === CopperAttributeAllocationErrorCode.IdempotencyConflict,
    );
    await assert.rejects(
      service.allocate(primary.user, primary.ringId,
        request(1, { comfort: 1, charm: 0, quality: 0, luck: 0 }, randomUUID())),
      (error) => codeOf(error) === CopperAttributeAllocationErrorCode.StalePoints,
    );

    await verifyAll76Points();
    await verifyV1Replay();
    await verifyInvalidBounds();
    await verifyAccountIsolation(primary.ringId);
    await verifyAuditFailureRollback();
    await assertReconciliation(primary);

    console.log(JSON.stringify({
      database: databaseName,
      totalsOneFourIntermediateAndAll76: true,
      accumulatedRemainderRetained: true,
      historicalV1ReplayPreserved: true,
      sameKeySequentialOneMutation: true,
      sameKeyConcurrentOneMutation: true,
      differentKeyConcurrentOneWinner: true,
      idempotencyConflict: true,
      staleAndInvalidBoundsRollback: true,
      accountIsolation: true,
      injectedAuditFailureFullRollback: true,
      ringOperationAuditReconciled: true,
    }, null, 2));
  } finally {
    await dropFaultTrigger();
    await dataSource.destroy();
  }
}

async function assertSchemaReady() {
  const [row] = await dataSource.query(`
    SELECT to_regclass('public.copper_attribute_allocation_operations') AS operations,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'game_rings' AND column_name = 'unspent_attribute_points'
      ) AS points,
      (
        SELECT pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE conrelid = 'copper_attribute_allocation_operations'::regclass
          AND conname = 'CHK_copper_attribute_allocation_operation_rules'
      ) AS rules
  `);
  assert.ok(row.operations && row.points, 'Deferred allocation migration is not applied');
  assert.match(row.rules, /copper-attribute-allocation-v1/);
  assert.match(row.rules, /copper-attribute-allocation-v2/);
}

async function seedFixture(unspent: number): Promise<Fixture> {
  const userId = randomUUID();
  const ringId = randomUUID();
  await dataSource.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
    VALUES ($1, $2, $3, 'Allocation QA', false, now(), now())
  `, [userId, `allocation-qa-${randomUUID()}`, `allocation_qa_${randomUUID().replaceAll('-', '')}`]);
  await dataSource.query(`
    INSERT INTO game_rings (
      id, owner_user_id, entitlement_code, ring_kind, status, level, shine,
      comfort, charm, quality, luck, unspent_attribute_points,
      visual_variant_code, ruleset_version, generation_version, visual_set_version,
      issued_reason, created_at, updated_at
    ) VALUES (
      $1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', 4, 100,
      20, 7, 11, 2, $3, 'copper_plain_polished', 'copper-rules-v1',
      'copper-generation-v1', 'copper-visual-v1', 'REGISTRATION', now(), now()
    )
  `, [ringId, userId, unspent]);
  return { user: Object.assign(new User(), { id: userId }), ringId };
}

function request(
  expectedUnspentPoints: number,
  allocation: Record<string, number>,
  idempotencyKey: string,
) {
  return { expectedUnspentPoints, allocation, idempotencyKey };
}

async function assertState(
  fixture: Fixture,
  expected: {
    unspent: number;
    comfort: number;
    charm: number;
    quality: number;
    luck: number;
    operations: number;
    events: number;
  },
) {
  const [ring] = await dataSource.query(`
    SELECT unspent_attribute_points::int AS unspent, comfort, charm, quality, luck
    FROM game_rings WHERE id = $1
  `, [fixture.ringId]);
  const [counts] = await dataSource.query(`
    SELECT
      (SELECT COUNT(*)::int FROM copper_attribute_allocation_operations
        WHERE owner_user_id = $1 AND status = 'COMPLETED') AS operations,
      (SELECT COUNT(*)::int FROM ring_events
        WHERE owner_user_id = $1 AND event_type = 'ATTRIBUTE_POINTS_ALLOCATED') AS events
  `, [fixture.user.id]);
  assert.deepEqual(ring, {
    unspent: expected.unspent,
    comfort: expected.comfort,
    charm: expected.charm,
    quality: expected.quality,
    luck: expected.luck,
  });
  assert.deepEqual(counts, { operations: expected.operations, events: expected.events });
}

async function verifyAll76Points() {
  const fixture = await seedFixture(76);
  const result = await service.allocate(fixture.user, fixture.ringId,
    request(76, { comfort: 76, charm: 0, quality: 0, luck: 0 }, randomUUID())) as Record<string, any>;
  assert.equal(result.rulesVersion, COPPER_ATTRIBUTE_ALLOCATION_VERSION);
  await assertState(fixture, { unspent: 0, comfort: 96, charm: 7, quality: 11, luck: 2, operations: 1, events: 1 });
}

async function verifyV1Replay() {
  const fixture = await seedFixture(8);
  const body = request(8, { comfort: 4, charm: 0, quality: 0, luck: 0 }, randomUUID());
  const operationId = randomUUID();
  const snapshot = {
    operationId,
    rulesVersion: COPPER_ATTRIBUTE_ALLOCATION_V1,
    ringId: fixture.ringId,
    idempotencyKey: body.idempotencyKey,
    historical: true,
  };
  await dataSource.query(`
    INSERT INTO copper_attribute_allocation_operations (
      id, owner_user_id, ring_id, idempotency_key, request_fingerprint,
      rules_version, status, response_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', $7::jsonb)
  `, [
    operationId,
    fixture.user.id,
    fixture.ringId,
    body.idempotencyKey,
    requestFingerprint(fixture.user.id, fixture.ringId, body, COPPER_ATTRIBUTE_ALLOCATION_V1),
    COPPER_ATTRIBUTE_ALLOCATION_V1,
    JSON.stringify(snapshot),
  ]);
  assert.deepEqual(await service.allocate(fixture.user, fixture.ringId, body), snapshot);
  await assertState(fixture, { unspent: 8, comfort: 20, charm: 7, quality: 11, luck: 2, operations: 1, events: 0 });
}

async function verifyInvalidBounds() {
  const fixture = await seedFixture(8);
  const invalid = [
    request(8, { comfort: 0, charm: 0, quality: 0, luck: 0 }, randomUUID()),
    request(8, { comfort: 9, charm: 0, quality: 0, luck: 0 }, randomUUID()),
    request(8, { comfort: 1.5, charm: 0, quality: 0, luck: 0 }, randomUUID()),
    request(8, { comfort: -1, charm: 1, quality: 0, luck: 0 }, randomUUID()),
    request(76, { comfort: 77, charm: 0, quality: 0, luck: 0 }, randomUUID()),
  ];
  for (const body of invalid) {
    await assert.rejects(
      service.allocate(fixture.user, fixture.ringId, body),
      (error) => codeOf(error) === CopperAttributeAllocationErrorCode.AllocationInvalid,
    );
  }
  await assert.rejects(
    service.allocate(fixture.user, fixture.ringId,
      request(77, { comfort: 1, charm: 0, quality: 0, luck: 0 }, randomUUID())),
    (error) => codeOf(error) === CopperAttributeAllocationErrorCode.RequestInvalid,
  );
  await assertState(fixture, { unspent: 8, comfort: 20, charm: 7, quality: 11, luck: 2, operations: 0, events: 0 });
}

async function verifyAccountIsolation(otherRingId: string) {
  const fixture = await seedFixture(4);
  await assert.rejects(
    service.allocate(fixture.user, otherRingId,
      request(4, { comfort: 1, charm: 0, quality: 0, luck: 0 }, randomUUID())),
    (error) => (error as HttpException).getStatus() === 404,
  );
  const [count] = await dataSource.query(`
    SELECT COUNT(*)::int AS count FROM copper_attribute_allocation_operations
    WHERE owner_user_id = $1
  `, [fixture.user.id]);
  assert.equal(count.count, 0);
}

async function verifyAuditFailureRollback() {
  const fixture = await seedFixture(8);
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION qa_reject_attribute_allocation_event() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'qa injected allocation audit failure' USING ERRCODE = '23514'; END;
    $$ LANGUAGE plpgsql
  `);
  await dataSource.query(`
    CREATE TRIGGER qa_reject_attribute_allocation_event
    BEFORE INSERT ON ring_events FOR EACH ROW
    WHEN (NEW.event_type = 'ATTRIBUTE_POINTS_ALLOCATED')
    EXECUTE FUNCTION qa_reject_attribute_allocation_event()
  `);
  try {
    await assert.rejects(
      service.allocate(fixture.user, fixture.ringId,
        request(8, { comfort: 1, charm: 1, quality: 1, luck: 1 }, randomUUID())),
      (error) => codeOf(error) === CopperAttributeAllocationErrorCode.WriteUnavailable,
    );
  } finally {
    await dropFaultTrigger();
  }
  await assertState(fixture, { unspent: 8, comfort: 20, charm: 7, quality: 11, luck: 2, operations: 0, events: 0 });
}

async function assertReconciliation(fixture: Fixture) {
  const rows = await dataSource.query(`
    SELECT operation.response_snapshot AS operation_snapshot, event.snapshot AS event_snapshot
    FROM copper_attribute_allocation_operations operation
    JOIN ring_events event ON event.operation_key = 'attribute-allocation:' || operation.id::text
    WHERE operation.owner_user_id = $1 AND operation.status = 'COMPLETED'
    ORDER BY operation.created_at, operation.id
  `, [fixture.user.id]);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.deepEqual(row.event_snapshot, row.operation_snapshot);
  assert.deepEqual(
    rows
      .map((row: { operation_snapshot: { unspentAttributePoints: { spent: number } } }) =>
        row.operation_snapshot.unspentAttributePoints.spent)
      .sort((left: number, right: number) => left - right),
    [1, 4, 20, 51],
  );
}

function requestFingerprint(
  ownerUserId: string,
  ringId: string,
  body: ReturnType<typeof request>,
  rulesVersion: string,
) {
  return createHash('sha256').update(JSON.stringify({
    ownerUserId,
    ringId,
    expectedUnspentPoints: body.expectedUnspentPoints,
    allocation: body.allocation,
    rulesVersion,
  })).digest('hex');
}

async function dropFaultTrigger() {
  if (!dataSource.isInitialized) return;
  await dataSource.query('DROP TRIGGER IF EXISTS qa_reject_attribute_allocation_event ON ring_events');
  await dataSource.query('DROP FUNCTION IF EXISTS qa_reject_attribute_allocation_event()');
}

function codeOf(error: unknown) {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    ? String((response as { code: unknown }).code)
    : null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
