import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { LedgerTransactionType } from '../src/balance/ledger-transaction.entity';

const databaseUrl = process.env.DATABASE_URL;
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || target.hostname !== '127.0.0.1' || target.pathname !== '/etherings_f03_qa') {
  throw new Error('The loopback disposable etherings_f03_qa database is required');
}
if (process.env.BALANCE_F03_QA_CONFIRM !== 'disposable') {
  throw new Error('BALANCE_F03_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = randomUUID();
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.M2E_EARNING_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = { accessToken: string; user: { id: string } };
type HttpResult = { status: number; body: Record<string, unknown> };
type Gate = {
  userId: string;
  expected: number;
  mode: 'read' | 'insert';
  seen: number;
  ready: Promise<void>;
  signalReady: () => void;
  release: Promise<void>;
  signalRelease: () => void;
};

function createGate(userId: string, expected = 1, mode: Gate['mode'] = 'read'): Gate {
  let signalReady = () => {};
  let signalRelease = () => {};
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const release = new Promise<void>((resolve) => { signalRelease = resolve; });
  return { userId, expected, mode, seen: 0, ready, signalReady, release, signalRelease };
}

async function main() {
  const [{ AppModule }, { HttpExceptionFilter }, { LedgerService }, { EruLedgerService }] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/common/http-exception.filter.js'),
    import('../dist/balance/ledger.service.js'),
    import('../dist/balance/eru-ledger.service.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  let database: DataSource | undefined;
  let restoreQuery: (() => void) | undefined;
  let gate: Gate | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
    const ledger = app.get(LedgerService);
    const eruLedger = app.get(EruLedgerService);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    let sql: string[] = [];
    restoreQuery = captureSql(database, () => gate, (query) => sql.push(query));
    const observations: Record<string, unknown> = {};

    async function race(
      label: string,
      owner: Session,
      mutation: () => Promise<unknown>,
      expectedErt: string,
      expectedEru: string,
    ) {
      sql = [];
      gate = createGate(owner.user.id);
      const profile = api(base, '/me', owner.accessToken, undefined, 'GET');
      await bounded(gate.ready, `${label}: profile did not read balance`);
      await mutation();
      const afterMutation = sql.length;
      gate.signalRelease();
      const result = await profile;
      gate = undefined;
      assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
      const state = await balanceAndLedger(database!, owner.user.id);
      observations[label] = {
        profileStatus: result.status,
        actualErt: state.ert,
        ledgerErt: state.ledgerErt,
        actualEru: state.eru,
        ledgerEru: state.ledgerEru,
        profileSqlAfterMutation: sql.slice(afterMutation).filter((query) => query.includes('balances')),
      };
      assert.equal(sql.slice(afterMutation).some((query) => /^UPDATE "balances"/i.test(query)), false,
        `${label}: profile issued a balance UPDATE`);
      assert.equal(state.ert, expectedErt, `${label}: ERT lost update`);
      assert.equal(state.ert, state.ledgerErt, `${label}: ERT ledger diverged`);
      assert.equal(state.eru, expectedEru, `${label}: ERU lost update`);
      assert.equal(state.eru, state.ledgerEru, `${label}: ERU ledger diverged`);
    }

    const drawOwner = await register(base);
    await ledger.creditDecimal({ userId: drawOwner.user.id, amount: '100', type: LedgerTransactionType.AdminAdjustment });
    await race('profile_vs_draw_debit_core', drawOwner, () => ledger.debitDecimal({
      userId: drawOwner.user.id,
      amount: '10',
      type: LedgerTransactionType.RaffleSpend,
      referenceType: 'raffle_draw',
      referenceId: randomUUID(),
    }), '90', '0');

    const stepOwner = await register(base);
    await race('profile_vs_step_sync_reward', stepOwner, async () => {
      const start = new Date(Date.now() - 120_000);
      const response = await api(base, '/step-sync/batches', stepOwner.accessToken, {
        installationId: randomUUID(),
        batchId: randomUUID(),
        sequence: 1,
        localDate: start.toISOString().slice(0, 10),
        timezoneOffsetMinutes: 0,
        observedStartedAt: start.toISOString(),
        observedEndedAt: new Date(start.getTime() + 60_000).toISOString(),
        stepDelta: 1000,
        sensorEventCount: 5,
        source: 'android_step_counter',
        algorithmVersion: 'f03-qa',
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, 'ACCEPTED');
    }, '10', '0');

    const eruDebitOwner = await register(base);
    await eruLedger.credit({
      userId: eruDebitOwner.user.id, amount: '5', type: LedgerTransactionType.RaffleReward,
      referenceType: 'raffle_draw', referenceId: randomUUID(),
    });
    await race('profile_vs_eru_debit', eruDebitOwner, () => eruLedger.debit({
      userId: eruDebitOwner.user.id, amount: '1.25', type: LedgerTransactionType.CopperLevelUpSpend,
      referenceType: 'copper_level_up_operation', referenceId: randomUUID(),
    }), '0', '3.75');

    const eruCreditOwner = await register(base);
    await race('profile_vs_eru_credit', eruCreditOwner, () => eruLedger.credit({
      userId: eruCreditOwner.user.id, amount: '2.5', type: LedgerTransactionType.RaffleReward,
      referenceType: 'raffle_draw', referenceId: randomUUID(),
    }), '0', '2.5');

    const newOwner = await register(base);
    await database.query('DELETE FROM balances WHERE user_id = $1', [newOwner.user.id]);
    sql = [];
    gate = createGate(newOwner.user.id, 2, 'insert');
    const first = api(base, '/me', newOwner.accessToken, undefined, 'GET');
    const second = api(base, '/me', newOwner.accessToken, undefined, 'GET');
    await bounded(gate.ready, 'first-creation profiles did not both attempt balance initialization');
    gate.signalRelease();
    const results = await Promise.all([first, second]);
    gate = undefined;
    const created = await balanceAndLedger(database, newOwner.user.id);
    observations.concurrent_first_creation = {
      profileStatuses: results.map((result) => result.status),
      actualErt: created.ert,
      ledgerErt: created.ledgerErt,
      actualEru: created.eru,
      ledgerEru: created.ledgerEru,
      sql: sql.filter((query) => query.includes('balances')).slice(0, 12),
    };
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 200]);
    assert.equal(created.ert, '0');
    assert.equal(created.eru, '0');
    console.log(JSON.stringify(observations, null, 2));
  } finally {
    gate?.signalRelease();
    restoreQuery?.();
    if (database?.isInitialized) await database.dropDatabase();
    await app.close();
  }
}

function captureSql(database: DataSource, currentGate: () => Gate | undefined, record: (sql: string) => void) {
  const runner = database.createQueryRunner();
  const prototype = Object.getPrototypeOf(runner) as {
    query: (query: string, parameters?: unknown[], useStructuredResult?: boolean) => Promise<unknown>;
  };
  const original = prototype.query;
  prototype.query = async function (query, parameters, useStructuredResult) {
    if (query.includes('balances') || query.includes('ledger_transactions')) {
      record(query.replace(/\s+/g, ' ').trim());
    }
    const gate = currentGate();
    const inserting = /^INSERT INTO "?balances"?/i.test(query.trimStart());
    if (gate && gate.mode === 'insert' && inserting && parameters?.includes(gate.userId)
      && gate.seen < gate.expected) {
      gate.seen += 1;
      if (gate.seen === gate.expected) gate.signalReady();
      await gate.release;
    }
    const result = await original.call(this, query, parameters, useStructuredResult);
    if (gate && gate.mode === 'read' && query.trimStart().startsWith('SELECT') && query.includes('balances')
      && parameters?.includes(gate.userId) && gate.seen < gate.expected) {
      gate.seen += 1;
      if (gate.seen === gate.expected) gate.signalReady();
      await gate.release;
    }
    return result;
  };
  return () => { prototype.query = original; void runner.release(); };
}

async function bounded(promise: Promise<void>, label: string) {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), 10_000)),
  ]);
}

async function register(base: string): Promise<Session> {
  const result = await api(base, '/auth/mobile-register', undefined, {
    username: `f03_${randomUUID().slice(0, 8)}`,
    password: `Qa-${randomUUID()}`,
    displayName: 'F03 Synthetic',
    installationId: randomUUID(),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body as Session;
}

async function balanceAndLedger(database: DataSource, userId: string) {
  const [balance] = await database.query(`
    SELECT ert_balance::text AS ert, eru_balance::text AS eru
    FROM balances WHERE user_id = $1
  `, [userId]);
  assert.ok(balance);
  const [sum] = await database.query(`
    SELECT COALESCE(sum(amount) FILTER (WHERE currency = 'ERT'), 0)::text AS ert,
      COALESCE(sum(amount) FILTER (WHERE currency = 'ERU'), 0)::text AS eru
    FROM ledger_transactions WHERE user_id = $1
  `, [userId]);
  return { ert: normalized(balance.ert), eru: normalized(balance.eru),
    ledgerErt: normalized(sum.ert), ledgerEru: normalized(sum.eru) };
}

function normalized(value: string) { return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }

async function api(base: string, path: string, token?: string, body?: object, method = 'POST'): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
