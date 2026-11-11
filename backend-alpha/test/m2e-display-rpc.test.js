import test from 'node:test';
import assert from 'node:assert/strict';
import { withM2eDisplayRpc } from '../src/m2e-display-rpc.js';
const opts = { encoding: 'base64', commitment: 'finalized' };
const wrapped = value => ({ context: { slot: 5n }, value });

test('account reads batch, repeated reads reuse only within one request and copies are isolated', async () => {
  const calls = [];
  let version = 1;
  const source = { getMultipleAccounts: (keys, options) => ({ send: async () => {
    calls.push({ keys, options }); return wrapped(keys.map(key => ({ key, version })));
  } }) };
  const read = rpc => Promise.all(['a','b','a'].map(key => rpc.getAccountInfo(key, opts).send()));
  await withM2eDisplayRpc(source, async rpc => {
    const values = await read(rpc); values[0].value.version = 99;
    assert.equal(values[2].value.version, 1);
    assert.equal((await rpc.getAccountInfo('a', opts).send()).value.version, 1);
  });
  assert.deepEqual(calls[0].keys, ['a','b']); assert.equal(calls.length, 1);
  version = 2; const values = await withM2eDisplayRpc(source, read);
  assert.equal(values[0].value.version, 2); assert.equal(calls.length, 2);
});

test('existing account batches seed exact encoding only; null remains null', async () => {
  let calls = 0;
  const source = { getMultipleAccounts: keys => ({ send: async () => { calls++; return wrapped(keys.map(() => null)); } }) };
  await withM2eDisplayRpc(source, async rpc => {
    await rpc.getMultipleAccounts(['a'], opts).send();
    assert.equal((await rpc.getAccountInfo('a', opts).send()).value, null);
    assert.equal(calls, 1);
    await rpc.getAccountInfo('a', { ...opts, encoding: 'jsonParsed' }).send();
    assert.equal(calls, 2);
  });
});

test('partial batches and provider errors fail; later requests retry', async () => {
  let fail = true;
  const source = { getMultipleAccounts: () => ({ send: async () => fail ? wrapped([]) : wrapped([null]) }) };
  await assert.rejects(withM2eDisplayRpc(source, rpc => rpc.getAccountInfo('a', opts).send()), /Incomplete/);
  fail = false;
  assert.equal((await withM2eDisplayRpc(source, rpc => rpc.getAccountInfo('a', opts).send())).value, null);
  const error = new Error('provider'); source.getMultipleAccounts = () => ({ send: async () => { throw error; } });
  await assert.rejects(withM2eDisplayRpc(source, rpc => rpc.getAccountInfo('a', opts).send()), e => e === error);
});

test('maximum batch100, concurrent scopes independent, cooldown clock never reused', async () => {
  const sizes = []; let clocks = 0;
  const source = {
    getMultipleAccounts: keys => ({ send: async () => { sizes.push(keys.length); return wrapped(keys.map(() => null)); } }),
    getSlot: () => ({ send: async () => ++clocks }),
  };
  const read = async rpc => {
    await Promise.all(Array.from({ length: 105 }, (_, i) => rpc.getAccountInfo(String(i), opts).send()));
    assert.notEqual(await rpc.getSlot({ commitment: 'finalized' }).send(), await rpc.getSlot({ commitment: 'finalized' }).send());
  };
  await Promise.all([withM2eDisplayRpc(source, read), withM2eDisplayRpc(source, read)]);
  assert.deepEqual(sizes.sort((a,b)=>a-b), [5,5,100,100]);
});

test('timeout cancels in-flight requests and completed scope cannot start more RPC; writes rejected', async () => {
  let active = 0; let saved;
  const source = { getMultipleAccounts: () => ({ send: ({ abortSignal }) => new Promise((resolve, reject) => {
    active++; abortSignal.addEventListener('abort', () => { active--; reject(abortSignal.reason); }, { once: true });
  }) }) };
  await assert.rejects(withM2eDisplayRpc(source, rpc => { saved = rpc; return rpc.getAccountInfo('a', opts).send(); }, { timeoutMs: 10 }), /timed out/);
  assert.equal(active, 0);
  await assert.rejects(saved.getAccountInfo('b', opts).send());
  await assert.rejects(withM2eDisplayRpc({}, rpc => rpc.sendTransaction('x').send()), /Unsupported/);
});
