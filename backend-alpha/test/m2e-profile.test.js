import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createM2eProfile } from '../src/m2e-profile.js';
import { createAlphaServer } from '../src/server.js';

test('M2E profile reads authenticated balance and live capacity with frozen day rules', async () => {
  const calls = [];
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    return { rows: [{ ert_balance: '0.137136170212765957', step_cap: 6000,
      base_steps: 5000, extra_steps_per_ring: 1000 }] };
  } };
  const auth = { async me(token) {
    return token === 'valid' ? { status: 200, body: { id: 'account-a' } }
      : { status: 401, body: { message: 'Unauthorized.' } };
  } };
  let ringCount = 2;
  const profile = createM2eProfile({ pool, auth,
    resolveEligibleRingCount: async () => ringCount });
  assert.equal((await profile.today('valid', new URLSearchParams('date=2026-09-27'))).body
    .ertBalanceExact, '0.137136170212765957');
  assert.deepEqual((await profile.today('valid', new URLSearchParams('date=2026-09-27'))).body,
    { date: '2026-09-27', ertBalanceExact: '0.137136170212765957',
      ertBalanceDisplay: '0.14', dailyStepCap: 6000 });
  assert.deepEqual(calls[0].args, ['account-a', '2026-09-27']);
  assert.match(calls[0].sql, /alpha_ert_available/);
  assert.match(calls[0].sql, /alpha_m2e_daily_snapshots/);
  ringCount = 1;
  assert.equal((await profile.today('valid', new URLSearchParams('date=2026-09-27')))
    .body.dailyStepCap, 5000);
  ringCount = 3;
  assert.equal((await profile.today('valid', new URLSearchParams('date=2026-09-27')))
    .body.dailyStepCap, 7000);
  assert.equal((await profile.today('invalid', new URLSearchParams('date=2026-09-27'))).status, 401);
  assert.equal(calls.length, 4);
  for (const query of ['date=2026-02-30', 'date=2026-09-27&date=2026-09-28', 'date=bad'])
    assert.equal((await profile.today('valid', new URLSearchParams(query))).status, 400);
  assert.equal(calls.length, 4);
});

test('M2E profile projects current capacity before snapshot and fails closed on UNKNOWN', async () => {
  let known = true;
  const profile = createM2eProfile({
    pool: { async query() { return { rows: [{ ert_balance: '0', step_cap: null }] }; } },
    auth: { async me() { return { status: 200, body: { id: 'account-a' } }; } },
    resolveEligibleRingCount: async () => {
      if (!known) throw new Error('provider unavailable');
      return 1;
    },
  });
  assert.deepEqual((await profile.today('valid', new URLSearchParams('date=2026-09-28'))).body,
    { date: '2026-09-28', ertBalanceExact: '0', ertBalanceDisplay: '0.00',
      dailyStepCap: 5000 });
  known = false;
  assert.equal((await profile.today('valid', new URLSearchParams('date=2026-09-28')))
    .body.dailyStepCap, null);
});

test('M2E activity reads exact account-scoped stats and immutable snapshot caps', async () => {
  const calls = [];
  const profile = createM2eProfile({
    pool: { async query(sql, args) {
      calls.push({ sql, args });
      return { rows: [{ date: '2026-09-27', accepted_steps: 205,
        earned_ert: '0.281129148936170213', step_cap: 6000 }] };
    } },
    auth: { async me(token) { return token === 'valid'
      ? { status: 200, body: { id: 'account-a' } }
      : { status: 401, body: { message: 'Unauthorized.' } }; } },
  });
  const query = new URLSearchParams('from=2026-08-29&to=2026-09-27');
  assert.deepEqual((await profile.history('valid', query)).body, {
    from: '2026-08-29', to: '2026-09-27', days: [{ date: '2026-09-27',
      acceptedSteps: 205, earnedErtExact: '0.281129148936170213',
      earnedErtDisplay: '0.28', raffleAttempts: 0, stepCap: 6000 }],
  });
  assert.deepEqual(calls[0].args, ['account-a', '2026-08-29', '2026-09-27']);
  assert.match(calls[0].sql, /alpha_m2e_daily_stats/);
  assert.match(calls[0].sql, /alpha_m2e_daily_snapshots/);
  assert.match(calls[0].sql, /d\.accounting_date::text AS date/);
  assert.equal((await profile.history('invalid', query)).status, 401);
  assert.equal(calls.length, 1);
  for (const range of ['from=2026-09-27&to=2026-08-29',
    'from=2026-08-01&to=2026-09-27', 'from=2026-02-30&to=2026-03-01',
    'from=2026-09-27&to=2026-09-27&to=2026-09-28'])
    assert.equal((await profile.history('valid', new URLSearchParams(range))).status, 400);
  assert.equal(calls.length, 1);
});

test('GET route keeps account read separate from POST step-sync', async () => {
  const profile = { async today(token, query) {
    return { status: token ? 200 : 401, body: { date: query.get('date') } };
  }, async history(token, query) {
    return { status: token ? 200 : 401, body: { from: query.get('from'), days: [] } };
  } };
  const server = createAlphaServer({}, null, null, null, null, null, null, null,
    undefined, null, null, profile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/m2e/today?date=2026-09-27`;
    assert.equal((await fetch(url)).status, 401);
    const ok = await fetch(url, { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { date: '2026-09-27' });
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    const history = url.replace('/m2e/today?date=2026-09-27',
      '/m2e/activity?from=2026-08-29&to=2026-09-27');
    assert.equal((await fetch(history)).status, 401);
    assert.equal((await fetch(history, { method: 'POST' })).status, 404);
    const accountHistory = await fetch(history,
      { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
    assert.equal(accountHistory.status, 200);
    assert.deepEqual(await accountHistory.json(), { from: '2026-08-29', days: [] });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
