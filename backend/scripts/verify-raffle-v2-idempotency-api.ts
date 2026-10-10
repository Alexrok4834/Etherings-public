import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.slice(1).toLowerCase().includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}
if (process.env.RAFFLE_V2_IDEMPOTENCY_QA_CONFIRM !== 'disposable') {
  throw new Error('RAFFLE_V2_IDEMPOTENCY_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'raffle-v2-idempotency-qa-secret-not-production';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = { accessToken: string; user: { id: string } };
type ApiResponse<T> = { status: number; body: T };
type DrawWrite = {
  operation: { operationId: string; replayed: boolean };
  draw: { drawResultId: string };
  fulfillment: { type: string; ringId?: string; ringEventId?: string };
};

let app: INestApplication | undefined;
let dataSource: DataSource | undefined;

async function main() {
  try {
    const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
      import('../dist/app.module.js'),
      import('../dist/common/http-exception.filter.js'),
    ]);
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    dataSource = app.get(DataSource);

    const address = app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sequentialOwner = await register(baseUrl, 'raffle_v2_sequential_owner');
    const concurrentOwner = await register(baseUrl, 'raffle_v2_concurrent_owner');
    const conflictOwner = await register(baseUrl, 'raffle_v2_conflict_owner');
    for (const owner of [sequentialOwner, concurrentOwner, conflictOwner]) {
      await setBalance(owner.user.id, '100');
    }

    const seeded = await seedActiveCooperDraw(sequentialOwner.user.id);

    const sequentialKey = randomUUID();
    const sequentialFirst = await draw(baseUrl, sequentialOwner, seeded.configurationId, sequentialKey);
    const sequentialReplay = await draw(baseUrl, sequentialOwner, seeded.configurationId, sequentialKey);
    assertReplay(sequentialReplay, sequentialFirst);
    await assertExactlyOnce(sequentialOwner.user.id, sequentialFirst);

    const concurrentKey = randomUUID();
    const concurrentResponses = await Promise.all([
      draw(baseUrl, concurrentOwner, seeded.configurationId, concurrentKey),
      draw(baseUrl, concurrentOwner, seeded.configurationId, concurrentKey),
    ]);
    const concurrentFirst = concurrentResponses.find((response) => !response.operation.replayed);
    const concurrentReplay = concurrentResponses.find((response) => response.operation.replayed);
    assert.ok(concurrentFirst && concurrentReplay);
    assertReplay(concurrentReplay, concurrentFirst);
    await assertExactlyOnce(concurrentOwner.user.id, concurrentFirst);

    const conflictKey = randomUUID();
    const conflictFirst = await draw(baseUrl, conflictOwner, seeded.configurationId, conflictKey);
    await assertExactlyOnce(conflictOwner.user.id, conflictFirst);
    const replacementId = await replaceActiveDraw(
      conflictOwner.user.id,
      seeded.configurationId,
      seeded.machineId,
      seeded.rewardId,
    );
    const beforeConflict = await databaseFingerprint();
    const conflict = await postDraw(baseUrl, conflictOwner, replacementId, conflictKey);
    assert.deepEqual(
      { status: conflict.status, code: (conflict.body as { code?: string }).code },
      { status: 409, code: 'RAFFLE_IDEMPOTENCY_CONFLICT' },
    );
    const afterConflict = await databaseFingerprint();
    assert.deepEqual(afterConflict, beforeConflict);
    await assertExactlyOnce(conflictOwner.user.id, conflictFirst);

    console.log(JSON.stringify({
      authenticatedApiBoundary: true,
      sequentialIdenticalReplay: true,
      concurrentIdenticalReplay: true,
      conflictingKeyRejected: true,
      exactlyOnceDebitAttemptResultRewardAndRing: true,
      conflictDatabaseFingerprintUnchanged: true,
      protectedTableCount: beforeConflict.tableCount,
    }, null, 2));
  } finally {
    if (dataSource?.isInitialized) await dataSource.dropDatabase();
    if (app) await app.close();
  }
}

async function register(baseUrl: string, username: string) {
  const response = await api<Session>(baseUrl, '/auth/mobile-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `Qa-${randomUUID()}`,
      displayName: username,
      installationId: randomUUID(),
    }),
  });
  assert.equal(response.status, 201);
  assert.ok(response.body.accessToken);
  return response.body;
}

async function setBalance(ownerId: string, amount: string) {
  await dataSource!.query(`
    UPDATE balances SET ert_balance = $2, lifetime_earned_ert = $2 WHERE user_id = $1
  `, [ownerId, amount]);
}

async function seedActiveCooperDraw(creatorId: string) {
  const machineId = randomUUID();
  const configurationId = randomUUID();
  const rewardId = randomUUID();
  await dataSource!.query(`
    INSERT INTO rewards (id, code, title, type, amount, amount_exact, is_active)
    VALUES ($1, 'raffle-v2-idempotency-cooper', 'Cooper Ring', 'COPPER_RING', NULL, NULL, true)
  `, [rewardId]);
  await dataSource!.query(`
    INSERT INTO raffle_machines (singleton_key, id, code) VALUES (1, $1, 'daily-draw')
  `, [machineId]);
  await insertConfiguration(configurationId, machineId, creatorId, rewardId, 'Idempotency QA A');
  await dataSource!.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
  return { machineId, configurationId, rewardId };
}

async function replaceActiveDraw(
  creatorId: string,
  currentId: string,
  machineId: string,
  rewardId: string,
) {
  await dataSource!.query(`
    UPDATE raffle_configurations
    SET status = 'DISABLED', disabled_at = now()
    WHERE id = $1 AND status = 'ACTIVE'
  `, [currentId]);
  const replacementId = randomUUID();
  await insertConfiguration(replacementId, machineId, creatorId, rewardId, 'Idempotency QA B');
  await dataSource!.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [replacementId]);
  return replacementId;
}

async function insertConfiguration(
  configurationId: string,
  machineId: string,
  creatorId: string,
  rewardId: string,
  title: string,
) {
  await dataSource!.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, 'raffle-v2', 'DRAFT', $3, 5, 5, $4)
  `, [configurationId, machineId, title, creatorId]);
  await dataSource!.query(`
    INSERT INTO raffle_configuration_rewards
      (configuration_id, reward_id, segment_index, weight, reward_snapshot)
    VALUES ($1, $2, 0, 100, $3::jsonb)
  `, [configurationId, rewardId, JSON.stringify(cooperSnapshot(rewardId))]);
}

function cooperSnapshot(rewardId: string) {
  return {
    rewardId,
    code: 'raffle-v2-idempotency-cooper',
    title: 'Cooper Ring',
    type: 'COPPER_RING',
    segmentIndex: 0,
    weight: '100',
    probability: { numerator: '100', denominator: '100' },
    imageUrl: null,
    amountExact: null,
    asset: { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 },
  };
}

async function draw(baseUrl: string, session: Session, configurationVersion: string, idempotencyKey: string) {
  const response = await postDraw(baseUrl, session, configurationVersion, idempotencyKey);
  assert.equal(response.status, 201);
  return response.body as DrawWrite;
}

function postDraw(baseUrl: string, session: Session, configurationVersion: string, idempotencyKey: string) {
  return api<DrawWrite | { code?: string }>(baseUrl, '/raffle/v2/draw', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ contractVersion: 'raffle-v2', configurationVersion, idempotencyKey }),
  });
}

function assertReplay(replay: DrawWrite, first: DrawWrite) {
  assert.equal(first.operation.replayed, false);
  assert.equal(replay.operation.replayed, true);
  assert.equal(replay.operation.operationId, first.operation.operationId);
  assert.equal(replay.draw.drawResultId, first.draw.drawResultId);
  assert.equal(replay.fulfillment.ringId, first.fulfillment.ringId);
  assert.equal(replay.fulfillment.ringEventId, first.fulfillment.ringEventId);
}

async function assertExactlyOnce(ownerId: string, response: DrawWrite) {
  const [state] = await dataSource!.query(`
    SELECT
      (SELECT ert_balance = 95 FROM balances WHERE user_id = $1) AS "balanceExact",
      (SELECT count(*)::int FROM ledger_transactions
        WHERE user_id = $1 AND type = 'RAFFLE_SPEND' AND currency = 'ERT') AS "spendLedgers",
      (SELECT count(*)::int FROM ledger_transactions
        WHERE user_id = $1 AND type = 'RAFFLE_REWARD') AS "rewardLedgers",
      (SELECT coalesce(sum(raffle_attempts), 0)::int FROM daily_user_stats
        WHERE user_id = $1) AS attempts,
      (SELECT count(*)::int FROM raffle_draw_operations WHERE owner_user_id = $1) AS operations,
      (SELECT count(*)::int FROM raffle_draw_results_v2 WHERE owner_user_id = $1) AS results,
      (SELECT count(*)::int FROM user_rewards
        WHERE user_id = $1 AND raffle_draw_result_v2_id IS NOT NULL) AS "userRewards",
      (SELECT count(*)::int FROM raffle_ring_awards WHERE owner_user_id = $1) AS "ringAwards",
      (SELECT count(*)::int FROM game_rings WHERE owner_user_id = $1) AS rings,
      (SELECT count(*)::int FROM game_rings
        WHERE owner_user_id = $1 AND issued_reason = 'RAFFLE') AS "raffleRings",
      (SELECT count(*)::int FROM ring_events
        WHERE owner_user_id = $1 AND event_type = 'RAFFLE_AWARDED') AS "raffleRingEvents"
  `, [ownerId]) as Array<Record<string, unknown>>;
  assert.deepEqual(state, {
    balanceExact: true,
    spendLedgers: 1,
    rewardLedgers: 0,
    attempts: 1,
    operations: 1,
    results: 1,
    userRewards: 1,
    ringAwards: 1,
    rings: 2,
    raffleRings: 1,
    raffleRingEvents: 1,
  });
  const [identity] = await dataSource!.query(`
    SELECT operation.id AS "operationId", result.id AS "drawResultId",
      award.ring_id AS "ringId", award.ring_event_id AS "ringEventId"
    FROM raffle_draw_operations operation
    JOIN raffle_draw_results_v2 result ON result.operation_id = operation.id
    JOIN raffle_ring_awards award ON award.draw_result_id = result.id
    WHERE operation.owner_user_id = $1
  `, [ownerId]) as Array<Record<string, unknown>>;
  assert.deepEqual(identity, {
    operationId: response.operation.operationId,
    drawResultId: response.draw.drawResultId,
    ringId: response.fulfillment.ringId,
    ringEventId: response.fulfillment.ringEventId,
  });
}

async function databaseFingerprint() {
  const tables = await dataSource!.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  const tableDigests: string[] = [];
  for (const { table_name: tableName } of tables) {
    const identifier = `"${tableName.replaceAll('"', '""')}"`;
    const [row] = await dataSource!.query(`
      SELECT count(*)::text AS count,
        coalesce(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM ${identifier} t
    `) as Array<{ count: string; digest: string }>;
    tableDigests.push(`${tableName}:${row.count}:${row.digest}`);
  }
  return {
    tableCount: tables.length,
    digest: createHash('sha256').update(tableDigests.join('\n')).digest('hex'),
  };
}

async function api<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

void main();
