import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { displayTimingHandler, timeDisplay } from '../src/display-timing.js';
const req = { method: 'GET', url: '/wallet/assets?secret=hidden', headers: { authorization: 'private-token' } };
function response() { return Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true }); }

test('disabled diagnostics and non-display requests produce no records', async () => {
  const records = [];
  for (const [enabled, request] of [[false, req], [true, { ...req, method: 'POST' }], [true, { ...req, url: '/auth/me' }]]) {
    const r = response();
    const h = displayTimingHandler(async () => { await timeDisplay('auth', () => 7); r.emit('finish'); return 7; }, { enabled, emit: x => records.push(x) });
    assert.equal(await h(request, r), 7);
  }
  assert.deepEqual(records, []);
});

test('concurrent requests stay separate; arguments and errors cannot enter records', async () => {
  const records = [];
  const h = displayTimingHandler(async (request, r) => {
    await timeDisplay(request.label, async () => {
      await new Promise(resolve => setTimeout(resolve, 3));
      if (request.fail) throw new Error('private-endpoint');
    }).catch(() => {});
    await timeDisplay('private-label', () => 1);
    r.emit('finish'); r.emit('close');
  }, { enabled: true, emit: x => records.push(x) });
  await Promise.all([h({ ...req, label: 'auth' }, response()), h({ ...req, label: 'binding', fail: true }, response())]);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(x => Object.keys(x.stages)), [['auth'], ['binding']]);
  assert.equal(records[1].stages.binding.failures, 1);
  assert.equal(records[0].stages.auth.calls, 1);
  assert.ok(!/private|hidden|secret/.test(JSON.stringify(records)));
});

test('failed reads retain original error; closed requests record once; sink failure is isolated', async () => {
  const error = new Error('original'); const r = response(); r.writableFinished = false;
  const records = [];
  const h = displayTimingHandler(async () => {
    await assert.rejects(timeDisplay('inventory', () => { throw error; }), e => e === error);
    r.emit('close'); r.emit('finish');
  }, { enabled: true, emit: x => { records.push(x); throw new Error('sink'); } });
  await h(req, r);
  assert.equal(records.length, 1); assert.equal(records[0].completed, false);
  assert.equal(records[0].stages.inventory.failures, 1);
  assert.equal(r.listenerCount('finish') + r.listenerCount('close'), 0);
});

test('logging is bounded to 60 sampled requests per minute', async () => {
  let now = 0; const records = [];
  const h = displayTimingHandler(async (_, r) => { await timeDisplay('auth', () => 1); r.emit('finish'); },
    { enabled: true, now: () => now, emit: x => records.push(x) });
  for (let i = 0; i < 80; i++) await h(req, response());
  assert.equal(records.length, 60);
  now = 60_000; await h(req, response()); assert.equal(records.length, 61);
});


test('M2E records only display mode, never the query or date', async () => {
  const records = [];
  const h = displayTimingHandler(async (_, r) => { await timeDisplay('m2e_db', () => 1); r.emit('finish'); },
    { enabled: true, emit: x => records.push(x) });
  await h({ method: 'GET', url: '/m2e/today?date=private&displayOnly=true' }, response());
  await h({ method: 'GET', url: '/m2e/today?date=private' }, response());
  assert.deepEqual(records.map(x => x.displayOnly), [true, false]);
  assert.equal(records[0].stages.m2e_db.calls, 1);
  assert.ok(!JSON.stringify(records).includes('private'));
});
