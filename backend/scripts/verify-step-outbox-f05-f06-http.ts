import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const target = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (!target || target.hostname !== '127.0.0.1' || target.pathname !== '/etherings_f05_f06_qa'
  || process.env.STEP_OUTBOX_QA_CONFIRM !== 'disposable') {
  throw new Error('A confirmed loopback etherings_f05_f06_qa database is required');
}
process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = randomUUID();
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.M2E_EARNING_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = { accessToken: string; user: { id: string } };

async function main() {
  const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/common/http-exception.filter.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  let database: DataSource | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const installationId = randomUUID();
    const a = await register(base, installationId);
    const b = await register(base, installationId);
    const start = Date.now() - 300_000;
    const aBatch = batch(installationId, 1, start);
    const wrongOwnerResponse = await submit(base, b.accessToken, aBatch);
    const committedReplay = await submit(base, b.accessToken, aBatch);
    const aLedger = await ertLedger(database, a.user.id);
    const bLedger = await ertLedger(database, b.user.id);
    const wrongOwner = {
      httpStatus: wrongOwnerResponse.status,
      batchStatus: wrongOwnerResponse.body.status,
      replayStatus: committedReplay.body.status,
      aLedger,
      bLedger,
    };
    assert.equal(wrongOwnerResponse.status, 200);
    assert.equal(wrongOwnerResponse.body.status, 'ACCEPTED');
    assert.equal(committedReplay.body.status, 'ACCEPTED');
    assert.equal(aLedger, '0');
    assert.notEqual(bLedger, '0');
    assert.equal(bLedger, '10.000000000000000000');

    const c = await register(base, randomUUID());
    const early = batch(randomUUID(), 1, start);
    const late = batch(early.installationId, 2, start + 90_000);
    const lateFirst = await submit(base, c.accessToken, late);
    const earlyAfter = await submit(base, c.accessToken, early);
    const earlyReplay = await submit(base, c.accessToken, early);
    const sequence = {
      lateFirstHttp: lateFirst.status,
      lateFirstStatus: lateFirst.body.status,
      earlyAfterHttp: earlyAfter.status,
      earlyAfterStatus: earlyAfter.body.status,
      earlyAfterCode: earlyAfter.body.resultCode,
      earlyReplayStatus: earlyReplay.body.status,
      cLedger: await ertLedger(database, c.user.id),
    };
    assert.equal(lateFirst.status, 200);
    assert.equal(lateFirst.body.status, 'ACCEPTED');
    assert.equal(earlyAfter.status, 200);
    assert.equal(earlyAfter.body.status, 'REJECTED');
    assert.equal(earlyAfter.body.resultCode, 'SEQUENCE_OUT_OF_ORDER');
    assert.equal(earlyReplay.body.resultCode, 'SEQUENCE_OUT_OF_ORDER');
    console.log(JSON.stringify({ wrongOwner, sequence }, null, 2));
  } finally {
    if (database?.isInitialized) await database.dropDatabase();
    await app.close();
  }
}

function batch(installationId: string, sequence: number, start: number) {
  return {
    installationId,
    batchId: randomUUID(),
    sequence,
    localDate: new Date(start).toISOString().slice(0, 10),
    timezoneOffsetMinutes: 0,
    observedStartedAt: new Date(start).toISOString(),
    observedEndedAt: new Date(start + 60_000).toISOString(),
    stepDelta: 1000,
    sensorEventCount: 5,
    source: 'android_step_counter',
    algorithmVersion: 'f05-f06-qa',
  };
}

async function register(base: string, installationId: string): Promise<Session> {
  const response = await fetch(`${base}/auth/mobile-register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `f05_${randomUUID().slice(0, 8)}`, password: `Qa-${randomUUID()}`,
      displayName: 'Step Outbox QA', installationId }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body as Session;
}

async function submit(base: string, token: string, payload: ReturnType<typeof batch>) {
  const response = await fetch(`${base}/step-sync/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function ertLedger(database: DataSource, userId: string): Promise<string> {
  const [row] = await database.query(`
    SELECT COALESCE(sum(amount) FILTER (WHERE currency = 'ERT'), 0)::text AS amount
    FROM ledger_transactions WHERE user_id = $1
  `, [userId]);
  return row.amount;
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
