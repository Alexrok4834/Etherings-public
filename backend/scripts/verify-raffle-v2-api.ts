import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.slice(1).toLowerCase().includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}
if (process.env.RAFFLE_V2_API_QA_CONFIRM !== 'disposable') {
  throw new Error('RAFFLE_V2_API_QA_CONFIRM=disposable is required');
}
const schemaMode = process.env.RAFFLE_V2_API_QA_SCHEMA ?? 'synchronized';
if (!['synchronized', 'migrated'].includes(schemaMode)) {
  throw new Error('RAFFLE_V2_API_QA_SCHEMA must be synchronized or migrated');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = schemaMode === 'migrated' ? 'false' : 'true';
process.env.JWT_SECRET = 'raffle-v2-api-qa-secret-not-production';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = { accessToken: string; user: { id: string } };
type ApiResponse<T> = { status: number; body: T };
type DrawRead = {
  contractVersion: string;
  draw: { configurationVersion: string; attempts: { used: number }; rewards: unknown[] };
};
type DrawWrite = {
  operation: { operationId: string; replayed: boolean };
  draw: { drawResultId: string };
};
type History = {
  items: Array<{ operationId: string; draw: { drawResultId: string } }>;
  nextCursor: string | null;
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
    const ownerA = await register(baseUrl, 'raffle_v2_api_owner_a');
    const ownerB = await register(baseUrl, 'raffle_v2_api_owner_b');
    await setBalance(ownerA.user.id, '100');
    await setBalance(ownerB.user.id, '100');

    await assertError(baseUrl, '/raffle/v2/draw', token(ownerA), 404, 'RAFFLE_UNAVAILABLE');
    const configurationId = await seedActiveDraw(ownerA.user.id);

    const current = await api<DrawRead>(baseUrl, '/raffle/v2/draw', token(ownerA));
    assert.equal(current.status, 200);
    assert.equal(current.body.contractVersion, 'raffle-v2');
    assert.equal(current.body.draw.configurationVersion, configurationId);
    assert.equal(current.body.draw.attempts.used, 0);
    assert.equal(current.body.draw.rewards.length, 1);

    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const ownerAWrites: DrawWrite[] = [];
    for (const key of keys) ownerAWrites.push(await draw(baseUrl, ownerA, configurationId, key));
    const replay = await draw(baseUrl, ownerA, configurationId, keys[0]);
    assert.equal(replay.operation.replayed, true);
    assert.equal(replay.operation.operationId, ownerAWrites[0].operation.operationId);
    assert.equal(replay.draw.drawResultId, ownerAWrites[0].draw.drawResultId);

    const ownerBWrite = await draw(baseUrl, ownerB, configurationId, randomUUID());
    const firstPage = await api<History>(baseUrl, '/raffle/v2/history?limit=2', token(ownerA));
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.items.length, 2);
    assert.ok(firstPage.body.nextCursor);
    const secondPage = await api<History>(
      baseUrl,
      `/raffle/v2/history?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`,
      token(ownerA),
    );
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.items.length, 1);
    assert.equal(secondPage.body.nextCursor, null);
    const ownerAResultIds = [...firstPage.body.items, ...secondPage.body.items]
      .map((item) => item.draw.drawResultId);
    assert.equal(new Set(ownerAResultIds).size, 3);
    assert.equal(ownerAResultIds.includes(ownerBWrite.draw.drawResultId), false);

    const replacementId = await replaceActiveDraw(ownerA.user.id, configurationId);
    await assertError(baseUrl, '/raffle/v2/draw', {
      ...token(ownerA),
      method: 'POST',
      headers: { ...token(ownerA).headers, 'content-type': 'application/json' },
      body: JSON.stringify(command(configurationId, randomUUID())),
    }, 409, 'RAFFLE_CONFIGURATION_STALE');
    await disableConfiguration(replacementId);
    await assertError(baseUrl, '/raffle/v2/draw', token(ownerA), 404, 'RAFFLE_UNAVAILABLE');

    console.log(JSON.stringify({
      schemaMode,
      unavailableFailsClosed: true,
      authenticatedCurrentRead: true,
      realPostgresDrawWrite: true,
      completedReplayNoDuplicate: true,
      ownerHistoryIsolated: true,
      opaqueCursorPagination: true,
      staleConfigurationRejected: true,
      disabledConfigurationFailsClosed: true,
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

async function seedActiveDraw(creatorId: string) {
  const machineId = randomUUID();
  const configurationId = randomUUID();
  const rewardId = randomUUID();
  await dataSource!.query(`
    INSERT INTO rewards (id, code, title, type, amount, amount_exact, is_active)
    VALUES ($1, 'raffle-v2-api-ert-5', '5 ERT', 'ERT', 5, 5, true)
  `, [rewardId]);
  await dataSource!.query(`
    INSERT INTO raffle_machines (singleton_key, id, code) VALUES (1, $1, 'daily-draw')
  `, [machineId]);
  await insertConfiguration(configurationId, machineId, creatorId, rewardId);
  await dataSource!.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
  return configurationId;
}

async function replaceActiveDraw(creatorId: string, currentId: string) {
  const [machine] = await dataSource!.query(`SELECT id FROM raffle_machines WHERE singleton_key = 1`);
  const [reward] = await dataSource!.query(`SELECT id FROM rewards WHERE code = 'raffle-v2-api-ert-5'`);
  await disableConfiguration(currentId);
  const replacementId = randomUUID();
  await insertConfiguration(replacementId, machine.id, creatorId, reward.id);
  await dataSource!.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [replacementId]);
  return replacementId;
}

async function insertConfiguration(configurationId: string, machineId: string, creatorId: string, rewardId: string) {
  await dataSource!.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, 'raffle-v2', 'DRAFT', 'Daily Draw', 5, 5, $3)
  `, [configurationId, machineId, creatorId]);
  await dataSource!.query(`
    INSERT INTO raffle_configuration_rewards
      (configuration_id, reward_id, segment_index, weight, reward_snapshot)
    VALUES ($1, $2, 0, 100, $3::jsonb)
  `, [configurationId, rewardId, JSON.stringify(rewardSnapshot(rewardId))]);
}

async function disableConfiguration(configurationId: string) {
  await dataSource!.query(`
    UPDATE raffle_configurations
    SET status = 'DISABLED', disabled_at = now()
    WHERE id = $1 AND status = 'ACTIVE'
  `, [configurationId]);
}

function rewardSnapshot(rewardId: string) {
  return {
    rewardId,
    code: 'raffle-v2-api-ert-5',
    title: '5 ERT',
    type: 'ERT',
    segmentIndex: 0,
    weight: '100',
    probability: { numerator: '100', denominator: '100' },
    imageUrl: null,
    amountExact: '5',
    amountDisplay: '5.00',
  };
}

async function draw(baseUrl: string, session: Session, configurationVersion: string, idempotencyKey: string) {
  const response = await api<DrawWrite>(baseUrl, '/raffle/v2/draw', {
    method: 'POST',
    headers: { ...token(session).headers, 'content-type': 'application/json' },
    body: JSON.stringify(command(configurationVersion, idempotencyKey)),
  });
  assert.equal(response.status, 201);
  return response.body;
}

function command(configurationVersion: string, idempotencyKey: string) {
  return { contractVersion: 'raffle-v2', configurationVersion, idempotencyKey };
}

function token(session: Session) {
  return { headers: { authorization: `Bearer ${session.accessToken}` } };
}

async function assertError(
  baseUrl: string,
  path: string,
  init: RequestInit,
  status: number,
  code: string,
) {
  const response = await api<{ code: string }>(baseUrl, path, init);
  assert.deepEqual({ status: response.status, code: response.body.code }, { status, code });
}

async function api<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

void main();
