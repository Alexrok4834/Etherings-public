import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerifiedDisplayReader } from '../src/verified-display-reader.js';
import { createReadOnlyRpcRoute, createReadOnlyRpcScope, createScopedReadRpc }
  from '../src/read-only-rpc-route.js';

const options = { commitment: 'finalized', encoding: 'base64' };
function fixture() {
  const state = { genesis: 'devnet', slot: 10n, accounts: new Map([
    ['ring', { owner: 'program', data: ['level-4', 'base64'] }],
    ['life', { owner: 'program', data: ['sealed', 'base64'] }],
  ]), tokens: ['ring'], calls: [], builds: 0, failure: null, truncated: false,
  stale: false, clock: 0 };
  const response = value => ({ context: { slot: state.stale ? 0n : state.slot },
    value: structuredClone(value) });
  const rpc = new Proxy({}, { get: (_, method) => (...args) => ({ async send() {
    state.calls.push({ method, args });
    if (state.failure) throw state.failure;
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getAccountInfo') return response(state.accounts.get(args[0]) ?? null);
    if (method === 'getMultipleAccounts') return response(state.truncated ? [] :
      args[0].map(key => state.accounts.get(key) ?? null));
    if (method === 'getTokenAccountsByOwner') return response(state.tokens);
    if (method === 'getSlot') return state.slot;
    throw new Error('Unexpected fixture method');
  } }) });
  const reader = createVerifiedDisplayReader({ rpc, now: () => state.clock,
    createReader: observed => ({
      async listOwnedAssets({ walletAddress }) {
        state.builds++;
        await observed.getGenesisHash().send();
        const tokens = await observed.getTokenAccountsByOwner(walletAddress,
          { programId: 'token' }, { encoding: 'jsonParsed', commitment: 'finalized' }).send();
        const result = [];
        for (const key of tokens.value) {
          const ring = await observed.getAccountInfo(key, options).send();
          const life = await observed.getAccountInfo('life', options).send();
          result.push({ walletAddress, ring: ring.value, life: life.value });
        }
        return result;
      },
      async readFinalized() {
        await observed.getGenesisHash().send();
        try { return (await observed.getAccountInfo('ring', options).send()).value; }
        catch { return null; }
      },
      async readBoxMedia() {
        await observed.getGenesisHash().send();
        await observed.getSlot().send(); // Unsupported time dependency: never memoize.
        return (await observed.getAccountInfo('ring', options).send()).value;
      },
      async submit() { state.builds++; return 'submitted'; },
    }),
  });
  return { state, reader, read: walletAddress => reader.listOwnedAssets({ walletAddress }) };
}

test('unchanged display revalidates genesis, owner discovery and one account batch', async () => {
  const { state, read } = fixture();
  const before = await read('a');
  state.calls = [];
  state.slot = 11n;
  assert.deepEqual(await read('a'), before);
  assert.equal(state.builds, 1);
  assert.deepEqual(state.calls.map(call => call.method),
    ['getGenesisHash', 'getTokenAccountsByOwner', 'getMultipleAccounts']);
  assert.equal(state.calls[1].args[2].minContextSlot, 10n);
  assert.equal(state.calls[2].args[1].minContextSlot, 11n);
  before[0].ring.owner = 'tampered';
  assert.equal((await read('a'))[0].ring.owner, 'program');
});

test('external incoming/outgoing assets and changed attributes/lifecycle rebuild', async () => {
  const { state, read } = fixture();
  await read('a');
  state.accounts.set('ring', { owner: 'program', data: ['level-5', 'base64'] });
  assert.equal((await read('a'))[0].ring.data[0], 'level-5');
  state.accounts.set('life', { owner: 'program', data: ['opening', 'base64'] });
  assert.equal((await read('a'))[0].life.data[0], 'opening');
  state.tokens = [];
  assert.deepEqual(await read('a'), []);
  state.tokens = ['new-ring'];
  state.accounts.set('new-ring', { owner: 'program', data: ['new', 'base64'] });
  assert.equal((await read('a'))[0].ring.data[0], 'new');
  assert.equal(state.builds, 5);
});

test('closed/reassigned accounts invalidate even if token list stays unchanged', async () => {
  const { state, read } = fixture();
  await read('a');
  state.accounts.delete('ring');
  assert.equal((await read('a'))[0].ring, null);
  state.accounts.set('ring', { owner: 'different', data: ['level-4', 'base64'] });
  assert.equal((await read('a'))[0].ring.owner, 'different');
  assert.equal(state.builds, 3);
});

test('RPC failures never serve last good data; error entry is removed', async () => {
  for (const code of ['ETIMEDOUT', '429', '403']) {
    const { state, read } = fixture();
    await read('a');
    state.failure = Object.assign(new Error('provider unavailable'), { code });
    await assert.rejects(read('a'), { code });
    state.failure = null;
    await read('a');
    assert.equal(state.builds, 2);
  }
});

test('wrong chain, incomplete batch and stale slot fail closed', async () => {
  for (const change of [s => { s.genesis = 'other'; },
    s => { s.truncated = true; }, s => { s.stale = true; }]) {
    const { state, read } = fixture();
    await read('a');
    change(state);
    await assert.rejects(read('a'), /cluster mismatch|Incomplete finalized/);
  }
});

test('different wallet and reader/provider never share cached results', async () => {
  const a = fixture(), b = fixture();
  await a.read('a');
  await a.read('b');
  await b.read('a');
  assert.equal(a.state.builds, 2);
  assert.equal(b.state.builds, 1);
});

test('retention expires, unsupported reads and operation methods always execute', async () => {
  const { state, read, reader } = fixture();
  await read('a');
  state.clock = 300_001;
  await read('a');
  assert.equal(state.builds, 2);
  await reader.readBoxMedia();
  await reader.readBoxMedia();
  assert.equal(state.calls.filter(c => c.method === 'getSlot').length, 2);
  await reader.submit();
  await reader.submit();
  assert.equal(state.builds, 4);
});

test('bounded retention evicts old wallet entries', async () => {
  const { state, read } = fixture();
  for (let i = 0; i < 65; i++) await read(`wallet-${i}`);
  await read('wallet-0');
  assert.equal(state.builds, 66);
});

test('swallowed RPC failure cannot be retained as an empty successful result', async () => {
  let failed = true, calls = 0;
  const rpc = {
    getGenesisHash: () => ({ send: async () => 'devnet' }),
    getAccountInfo: () => ({ async send() {
      calls++;
      if (failed) throw new Error('unavailable');
      return { context: { slot: 1n }, value: { owner: 'program' } };
    } }),
  };
  const reader = createVerifiedDisplayReader({ rpc, createReader: observed => ({
    async readFinalized() {
      await observed.getGenesisHash().send();
      try { return (await observed.getAccountInfo('a', options).send()).value; }
      catch { return null; }
    },
  }) });
  assert.equal(await reader.readFinalized(), null);
  failed = false;
  assert.deepEqual(await reader.readFinalized(), { owner: 'program' });
  assert.equal(calls, 2);
});

test('account batches never exceed 100 and a later changed batch rebuilds', async () => {
  const { state, read } = fixture();
  state.tokens = Array.from({ length: 105 }, (_, i) => `ring-${i}`);
  state.tokens.forEach(key => state.accounts.set(key, { owner: 'program' }));
  await read('a');
  state.calls = [];
  await read('a');
  assert.deepEqual(state.calls.filter(c => c.method === 'getMultipleAccounts')
    .map(c => c.args[0].length), [100, 6]);
  state.accounts.set('ring-104', { owner: 'changed' });
  assert.equal((await read('a'))[104].ring.owner, 'changed');
  assert.equal(state.builds, 2);
});

test('snapshot batch cancellation uses existing fallback budget with zero remaining RPCs', async () => {
  const scope = createReadOnlyRpcScope();
  let hang = false, active = 0, fallbackCalls = 0;
  const rpc = createScopedReadRpc('primary', scope, () => ({
    getGenesisHash: () => ({ send: async () => 'devnet' }),
    getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: 'ok' }) }),
    getMultipleAccounts: () => ({ send: ({ abortSignal }) => {
      if (!hang) return Promise.resolve({ context: { slot: 1n }, value: ['ok'] });
      active++;
      return new Promise((resolve, reject) => {
        const stop = () => { active--; reject(abortSignal.reason); };
        if (abortSignal.aborted) stop();
        else abortSignal.addEventListener('abort', stop, { once: true });
      });
    } }),
  }));
  const reader = createVerifiedDisplayReader({ rpc, createReader: observed => ({
    async readFinalized() {
      await observed.getGenesisHash().send();
      return (await observed.getAccountInfo('a', options).send()).value;
    },
  }) });
  const route = createReadOnlyRpcRoute({ scope, mode: 'primary-failover',
    totalTimeoutMs: 200, firstAttemptTimeoutMs: 50,
    primary: () => reader.readFinalized(),
    alternative: async () => { fallbackCalls++; return 'fresh alternative'; },
  });
  assert.equal(await route(), 'ok');
  hang = true;
  assert.equal(await route(), 'fresh alternative');
  assert.equal(fallbackCalls, 1);
  assert.equal(active, 0);
});

test('parsed mint and raw account at same address are independently revalidated', async () => {
  let supply = '1', builds = 0;
  const batches = [];
  const value = encoding => encoding === 'jsonParsed'
    ? { data: { parsed: { info: { supply } } } } : { data: ['raw', 'base64'] };
  const rpc = {
    getGenesisHash: () => ({ send: async () => 'devnet' }),
    getAccountInfo: (_key, config) => ({ send: async () =>
      ({ context: { slot: 1n }, value: value(config.encoding) }) }),
    getMultipleAccounts: (keys, config) => ({ send: async () => {
      batches.push(config.encoding);
      return { context: { slot: 1n }, value: keys.map(() => value(config.encoding)) };
    } }),
  };
  const reader = createVerifiedDisplayReader({ rpc, createReader: observed => ({
    async readFinalized() {
      builds++;
      await observed.getGenesisHash().send();
      await observed.getAccountInfo('mint', options).send();
      return (await observed.getAccountInfo('mint',
        { ...options, encoding: 'jsonParsed' }).send()).value;
    },
  }) });
  const first = await reader.readFinalized();
  assert.deepEqual(await reader.readFinalized(), first);
  assert.equal(builds, 1);
  assert.deepEqual(batches, ['base64', 'jsonParsed']);
  supply = '0';
  assert.equal((await reader.readFinalized()).data.parsed.info.supply, '0');
  assert.equal(builds, 2);
});
