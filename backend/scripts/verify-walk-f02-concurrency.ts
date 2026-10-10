import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AddWalkRewardIdempotency1788393600000 } from '../src/migrations/1788393600000-add-walk-reward-idempotency';

const databaseUrl = process.env.DATABASE_URL;
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || target.hostname !== '127.0.0.1' || target.pathname !== '/etherings_f02_qa') {
  throw new Error('The loopback disposable etherings_f02_qa database is required');
}
if (process.env.WALK_F02_QA_CONFIRM !== 'disposable') {
  throw new Error('WALK_F02_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = process.env.WALK_F02_QA_SCHEMA === 'migrated' ? 'false' : 'true';
process.env.JWT_SECRET = 'walk-f02-local-qa-only';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.M2E_EARNING_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = { accessToken: string; user: { id: string } };
type Walk = { id: string; startedAt: string; source: string; status: string; earnedErt: number };
type ApiResult<T> = { status: number; body: T };

async function main() {
  const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/common/http-exception.filter.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  const holder = new Client({ connectionString: databaseUrl });
  const observer = new Client({ connectionString: databaseUrl });
  let database: DataSource | undefined;
  let lockHeld = false;
  try {
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
    await holder.connect();
    await observer.connect();
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const registration = await api<Session>(base, '/auth/mobile-register', undefined, {
      username: `f02_${randomUUID().slice(0, 8)}`,
      password: `Qa-${randomUUID()}`,
      displayName: 'F02 Synthetic',
      installationId: randomUUID(),
    });
    assert.equal(registration.status, 201);
    const owner = registration.body;
    const started = await api<Walk>(base, '/walk/sessions/start', owner.accessToken);
    assert.equal(started.status, 201);
    const startedAt = new Date(Date.now() - 120_000);
    await database.query('UPDATE walk_sessions SET started_at = $2 WHERE id = $1', [started.body.id, startedAt]);
    const endedAt = new Date(Date.now() - 1000);
    const finishBody = {
      clientStepCount: 1200,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
      distanceMeters: null,
      samplesCount: 60,
      algorithmVersion: 'f02-qa',
    };
    const finishPath = `/walk/sessions/${started.body.id}/finish`;

    await holder.query('BEGIN');
    lockHeld = true;
    await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.user.id]);
    const first = api<Walk>(base, finishPath, owner.accessToken, finishBody);
    const second = api<Walk>(base, finishPath, owner.accessToken, finishBody);
    const blockedConnections = await waitForTwoBlockedConnections(observer, holder.processID);
    await holder.query('COMMIT');
    lockHeld = false;

    const responses = await Promise.all([first, second]);
    const retry = await api<Walk>(base, finishPath, owner.accessToken, finishBody);
    const ledger = await database.query(`
      SELECT id, amount::text AS amount, balance_after::text AS balance_after
      FROM ledger_transactions
      WHERE currency = 'ERT' AND type = 'WALK_REWARD'
        AND reference_type = 'walk_session' AND reference_id = $1
      ORDER BY created_at, id
    `, [started.body.id]);
    const [balance] = await database.query(`
      SELECT ert_balance::text AS balance, lifetime_earned_ert::text AS earned
      FROM balances WHERE user_id = $1
    `, [owner.user.id]);
    const [walk] = await database.query(`
      SELECT status, earned_ert::text AS earned, accepted_step_count AS steps
      FROM walk_sessions WHERE id = $1
    `, [started.body.id]);
    const indexes = await database.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'ledger_transactions'
        AND indexdef ILIKE '%reference_id%'
      ORDER BY indexname
    `);
    const observation = {
      blockedConnections,
      httpStatuses: responses.map((response) => response.status),
      successfulFinishes: responses.filter((response) => response.status === 201).length,
      retryStatus: retry.status,
      ledgerEvents: ledger.length,
      ledgerAmounts: ledger.map((row: { amount: string }) => row.amount),
      balance: balance.balance,
      lifetimeEarned: balance.earned,
      walk,
      source: started.body.source,
      referenceIndexes: indexes,
    };
    console.log(JSON.stringify(observation, null, 2));

    if (process.env.WALK_F02_OBSERVE !== 'true') {
      assert.equal(observation.blockedConnections.length, 2);
      assert.equal(observation.successfulFinishes, 1);
      assert.equal(observation.ledgerEvents, 1);
      assert.equal(Number(observation.balance), 12);
      assert.equal(Number(observation.lifetimeEarned), 12);
      assert.equal(walk.status, 'ACCEPTED');
      assert.equal(Number(walk.earned), 12);
      assert.equal(walk.steps, 1200);
      assert.equal(retry.status, 400);
      assert.ok(indexes.some((index: { indexname: string }) => index.indexname === 'UQ_ledger_walk_reward_reference'));
      await verifyMigrationAndUniqueConstraint(database, started.body.id);
    }
  } finally {
    if (lockHeld) await holder.query('ROLLBACK');
    await holder.end();
    await observer.end();
    if (database?.isInitialized) await database.dropDatabase();
    await app.close();
  }
}

async function waitForTwoBlockedConnections(observer: Client, holderPid: number | undefined) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(`
      SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND pid <> $1 AND state = 'active' AND wait_event_type = 'Lock'
      ORDER BY pid
    `, [holderPid ?? 0]);
    if (rows.length >= 2) return rows.slice(0, 2).map((row: { pid: number; query: string }) => ({
      pid: row.pid,
      waitingQuery: row.query.includes('walk_sessions') ? 'walk_sessions' : 'users',
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Two distinct backend PostgreSQL connections did not reach the user-row lock');
}

async function verifyMigrationAndUniqueConstraint(database: DataSource, sessionId: string) {
  const indexName = 'UQ_ledger_walk_reward_reference';
  await database.query(`DROP INDEX "${indexName}"`);
  const duplicateId = randomUUID();
  const duplicateSql = `
    INSERT INTO ledger_transactions (
      id, user_id, type, currency, amount, balance_after,
      reference_type, reference_id, metadata, created_at
    )
    SELECT $1, user_id, type, currency, amount, balance_after,
      reference_type, reference_id, metadata, now()
    FROM ledger_transactions WHERE reference_id = $2 AND type = 'WALK_REWARD'
  `;
  await database.query(duplicateSql, [duplicateId, sessionId]);
  const migration = new AddWalkRewardIdempotency1788393600000();
  const runner = database.createQueryRunner();
  try {
    await assert.rejects(() => migration.up(runner), (error: unknown) => pgCode(error) === '23505');
    await database.query('DELETE FROM ledger_transactions WHERE id = $1', [duplicateId]);
    await migration.up(runner);
    const [index] = await database.query(`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1
    `, [indexName]);
    assert.ok(index?.indexdef.includes('UNIQUE INDEX'));
    await assert.rejects(
      () => database.query(duplicateSql, [randomUUID(), sessionId]),
      (error: unknown) => pgCode(error) === '23505',
    );
    await assert.rejects(() => migration.down(runner), (error: unknown) => pgCode(error) === '23514');
    console.log(JSON.stringify({
      migrationPreflightRejectedDuplicate: true,
      dbUniqueRejectedDuplicate: true,
      downgradeWithRewardEvidenceRejected: true,
    }));
  } finally {
    await runner.release();
  }
}

function pgCode(error: unknown) {
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.driverError?.code ?? candidate.code;
}

async function api<T>(base: string, path: string, token?: string, body?: object): Promise<ApiResult<T>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
