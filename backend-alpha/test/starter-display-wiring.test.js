import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlphaServer } from '../src/server.js';
import { createInventoryDisplay } from '../src/inventory-display.js';
import { createBatchedDisplayInventory } from '../src/batched-display-inventory.js';

const token = 'a'.repeat(64);
async function fixture(t, broken = false) {
  const calls = { reserve: 0, inventory: 0 };
  let bound = true;
  let reserveStatus = 200;
  const auth = { async me(value) { return value === token
    ? { status: 200, body: { id: 'account' } } : { status: 401, body: {} }; } };
  const wallet = { async current() { return { status: 200, body: { walletAddress: 'wallet' } }; } };
  const silver = {
    async reserve(value) {
      if (value !== token) return { status: 401, body: {} };
      calls.reserve++;
      return { status: reserveStatus, body: { status: 'confirmed' } };
    },
    async inventory() { throw new Error('Unoptimized inventory called'); },
  };
  const displaySilver = createBatchedDisplayInventory({ rpc: {}, createService: () => ({
    async inventory() { calls.inventory++; return { status: 200, body: { assets: [] } }; },
  }) });
  const routed = createInventoryDisplay({ auth, wallet,
    silver: broken ? displaySilver : silver, displaySilver });
  const starter = { async claim(value) {
    return value === token ? { status: 200, body: { ring: {}, rings: [], walletBound: bound } }
      : { status: 401, body: {} };
  } };
  const server = createAlphaServer(auth, wallet, null, routed, null, null, null, starter);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, bound: value => { bound = value; }, reserveStatus: value => { reserveStatus = value; },
    async request(path, value = token, method = 'POST') {
      const result = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return { status: result.status, body: await result.json() };
    } };
}

test('old production composition reproduces starter503 without any RPC or database failure', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.request('/starter/claim')).status, 503);
  assert.deepEqual(f.calls, { reserve: 0, inventory: 0 });
});

test('starter and direct first-entry use original reserve while inventory stays batched', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/starter/claim')).body.silver.status, 'confirmed');
  assert.equal((await f.request('/silver/first-entry')).status, 200);
  assert.deepEqual(f.calls, { reserve: 2, inventory: 0 });
  assert.equal((await f.request('/silver/inventory', token, 'GET')).status, 200);
  assert.deepEqual(f.calls, { reserve: 2, inventory: 1 });
});

test('authorization, unbound starter and reservation conflicts retain their semantics', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/starter/claim', 'b'.repeat(64))).status, 401);
  assert.equal((await f.request('/silver/first-entry', 'b'.repeat(64))).status, 401);
  assert.equal(f.calls.reserve, 0);
  f.bound(false);
  assert.equal((await f.request('/starter/claim')).body.silver.status, 'awaiting_wallet');
  assert.equal(f.calls.reserve, 0);
  f.bound(true); f.reserveStatus(409);
  assert.equal((await f.request('/starter/claim')).status, 409);
});
