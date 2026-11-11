import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchedDisplayInventory } from '../src/batched-display-inventory.js';
import { createVerifiedDisplayReader } from '../src/verified-display-reader.js';
import { createReadOnlyRpcScope, createScopedReadRpc, createReadOnlyRpcRoute } from '../src/read-only-rpc-route.js';
const options = { encoding: 'base64', commitment: 'finalized' };

test('cold batching composes with warm dependency validation; external changes and errors stay visible', async () => {
  let value = 1, failure = false, genesis = 'devnet'; const calls = [];
  const rpc = new Proxy({}, { get: (_, method) => (...args) => ({ async send() {
    calls.push(method); if (failure) throw new Error('offline');
    if (method === 'getGenesisHash') return genesis;
    return { context: { slot: 10n }, value: method === 'getTokenAccountsByOwner'
      ? ['ring'] : args[0].map(() => ({ value })) };
  } }) });
  const inventory = createBatchedDisplayInventory({ rpc, createService: routed => {
    const reader = createVerifiedDisplayReader({ rpc: routed, createReader: observed => ({
      async listOwnedAssets() {
        assert.equal(await observed.getGenesisHash().send(), 'devnet');
        await observed.getTokenAccountsByOwner('wallet', { programId: 'token' }, { encoding: 'jsonParsed', commitment: 'finalized' }).send();
        const [a,b] = await Promise.all([observed.getAccountInfo('ring', options).send(), observed.getAccountInfo('ring', options).send()]);
        return [a.value.value,b.value.value];
      },
    }) });
    return { inventory: () => reader.listOwnedAssets({ walletAddress: 'wallet' }) };
  } });
  assert.deepEqual(await inventory.inventory(), [1,1]);
  assert.equal(calls.filter(x => x === 'getMultipleAccounts').length, 1);
  assert.deepEqual(await inventory.inventory(), [1,1]);
  value = 2; assert.deepEqual(await inventory.inventory(), [2,2]);
  failure = true; await assert.rejects(inventory.inventory(), /offline/);
  failure = false; genesis = 'wrong'; await assert.rejects(inventory.inventory());
  genesis = 'devnet'; assert.deepEqual(await inventory.inventory(), [2,2]);
});

test('concurrent users have separate raw scopes and response copies', async () => {
  const calls = [];
  const rpc = { getMultipleAccounts: keys => ({ send: async () => {
    calls.push(keys); return { context: { slot: 1n }, value: keys.map(key => ({ key })) };
  } }) };
  const inventory = createBatchedDisplayInventory({ rpc, createService: observed => ({ inventory: async user => {
    const first = await observed.getAccountInfo(user, options).send();
    const second = await observed.getAccountInfo(user, options).send();
    first.value.key = 'changed'; return second.value.key;
  } }) });
  assert.deepEqual(await Promise.all([inventory.inventory('a'), inventory.inventory('b')]), ['a','b']);
  assert.equal(calls.length, 2);
});

test('provider timeout cancels inventory batches before compatible fallback; no background calls', async () => {
  const scope = createReadOnlyRpcScope(); let active = 0;
  const source = createScopedReadRpc('test-provider', scope, () => ({ getMultipleAccounts: () => ({ send: ({ abortSignal }) => new Promise((resolve,reject) => {
    active++; abortSignal.addEventListener('abort', () => { active--; reject(abortSignal.reason); }, { once: true });
  }) }) }));
  const inventory = createBatchedDisplayInventory({ rpc: source, createService: observed => ({
    inventory: () => observed.getAccountInfo('ring', options).send(),
  }) });
  const route = createReadOnlyRpcRoute({ primary: () => inventory.inventory(), alternative: async () => {
    assert.equal(active,0); return 'fallback';
  }, mode: 'primary-failover', scope, firstAttemptTimeoutMs: 10, totalTimeoutMs: 40 });
  assert.equal(await route(), 'fallback'); assert.equal(active,0);
});
