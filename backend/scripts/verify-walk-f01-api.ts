import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
if (!parsedDatabaseUrl || parsedDatabaseUrl.hostname !== '127.0.0.1'
  || parsedDatabaseUrl.pathname !== '/etherings_f01_qa') {
  throw new Error('The local disposable etherings_f01_qa database is required');
}
if (process.env.WALK_F01_QA_CONFIRM !== 'disposable') {
  throw new Error('WALK_F01_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'walk-f01-local-qa-only';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.M2E_EARNING_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type ResponseBody = Record<string, unknown>;
type Session = { accessToken: string; user: { id: string } };
type Walk = { id: string; startedAt: string; status: string; earnedErt: number; source: string };
type ApiResult<T> = { status: number; body: T };

async function main() {
  const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/common/http-exception.filter.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  let database: DataSource | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = await register(base);
    const observed: Record<string, number> = {};

    const normal = await start(base, owner);
    const normalStart = await backdate(database, normal.id, 120_000);
    const normalResult = await finish(base, owner, normal.id, payload(normalStart));
    assert.equal(normalResult.status, 201, JSON.stringify(normalResult.body));
    assert.equal(normalResult.body.status, 'ACCEPTED');
    assert.equal(normalResult.body.earnedErt, 12);
    assert.equal(normal.source, 'telegram_accelerometer');
    observed.normal = normalResult.status;

    const past = await start(base, owner);
    const pastStart = new Date(Date.now() - 2 * 86400_000);
    const pastResult = await finish(base, owner, past.id, payload(pastStart, new Date(pastStart.getTime() + 120_000)));
    observed.pastDate = pastResult.status;

    const future = await start(base, owner);
    const futureStart = new Date(Date.now() + 2 * 86400_000);
    const futureResult = await finish(base, owner, future.id, payload(futureStart, new Date(futureStart.getTime() + 120_000)));
    observed.futureDate = futureResult.status;

    const futureEnd = await start(base, owner);
    const futureEndStart = await backdate(database, futureEnd.id, 120_000);
    const futureEndResult = await finish(
      base,
      owner,
      futureEnd.id,
      payload(futureEndStart, new Date(Date.now() + 2 * 3600_000)),
    );
    observed.futureEnd = futureEndResult.status;

    const inconsistent = await start(base, owner);
    const inconsistentStart = await backdate(database, inconsistent.id, 120_000);
    const inconsistentResult = await finish(base, owner, inconsistent.id, {
      ...payload(inconsistentStart),
      durationSeconds: 30,
    });
    observed.inconsistentDuration = inconsistentResult.status;

    const overlapOwner = await register(base);
    const overlapStart = new Date(Date.now() - 120_000);
    const batch = await api<ResponseBody>(base, '/step-sync/batches', overlapOwner.accessToken, {
      installationId: randomUUID(),
      batchId: randomUUID(),
      sequence: 1,
      localDate: overlapStart.toISOString().slice(0, 10),
      timezoneOffsetMinutes: 0,
      observedStartedAt: new Date(overlapStart.getTime() + 30_000).toISOString(),
      observedEndedAt: new Date(overlapStart.getTime() + 60_000).toISOString(),
      stepDelta: 500,
      sensorEventCount: 5,
      source: 'android_step_counter',
      algorithmVersion: 'f01-qa',
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.status, 'ACCEPTED');
    const overlap = await start(base, overlapOwner);
    await database.query('UPDATE walk_sessions SET started_at = $2 WHERE id = $1', [overlap.id, overlapStart]);
    const overlapResult = await finish(base, overlapOwner, overlap.id, payload(overlapStart));
    observed.stepSyncOverlap = overlapResult.status;

    console.log(JSON.stringify({ m2eEarningEnabled: false, observed }, null, 2));
    if (process.env.WALK_F01_OBSERVE !== 'true') {
      for (const [scenario, status] of Object.entries(observed)) {
        if (scenario !== 'normal') assert.equal(status, 400, `${scenario} must be rejected`);
      }
      const [ledger] = await database.query(
        "SELECT count(*)::int AS count FROM ledger_transactions WHERE reference_type = 'walk_session'",
      );
      assert.equal(ledger.count, 1, 'only the normal Walk may credit the ledger');
      const [walks] = await database.query(
        "SELECT count(*)::int AS count FROM walk_sessions WHERE status = 'ACCEPTED'",
      );
      assert.equal(walks.count, 1, 'rejected Walk attempts must not become accepted sessions');
      const [unexpectedDays] = await database.query(
        'SELECT count(*)::int AS count FROM daily_user_stats WHERE date <> CURRENT_DATE',
      );
      assert.equal(unexpectedDays.count, 0, 'client-selected dates must not create daily accounting');
    }
  } finally {
    if (database?.isInitialized) await database.dropDatabase();
    await app.close();
  }
}

async function register(base: string): Promise<Session> {
  const result = await api<Session>(base, '/auth/mobile-register', undefined, {
    username: `f01_${randomUUID().slice(0, 8)}`,
    password: `Qa-${randomUUID()}`,
    displayName: 'F01 Synthetic',
    installationId: randomUUID(),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function start(base: string, owner: Session): Promise<Walk> {
  const result = await api<Walk>(base, '/walk/sessions/start', owner.accessToken);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function backdate(database: DataSource, id: string, elapsedMs: number): Promise<Date> {
  const startedAt = new Date(Date.now() - elapsedMs);
  await database.query('UPDATE walk_sessions SET started_at = $2 WHERE id = $1', [id, startedAt]);
  return startedAt;
}

function payload(startedAt: Date, endedAt = new Date(Date.now() - 1000)) {
  return {
    clientStepCount: 1200,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    distanceMeters: null,
    samplesCount: 60,
    algorithmVersion: 'f01-qa',
  };
}

function finish(base: string, owner: Session, id: string, body: ReturnType<typeof payload>) {
  return api<Walk>(base, `/walk/sessions/${id}/finish`, owner.accessToken, body);
}

async function api<T>(base: string, path: string, token?: string, body?: object): Promise<ApiResult<T>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

void main();
