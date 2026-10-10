import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyRpcRoute, createReadOnlyRpcScope, createScopedReadRpc,
  readRouteMode, retryableRpcFailure } from
  '../src/read-only-rpc-route.js';
import { createSilverChainReader } from '../src/silver-chain.js';

const http = (statusCode, message = '') => Object.assign(new Error(message),
  { context: { statusCode, message } });
const scope = createReadOnlyRpcScope();

test('disabled route keeps the original complete read and needs no alternative', async () => {
  const route = createReadOnlyRpcRoute({ primary: async token => ({ status: 200,
    body: { token } }) });
  assert.deepEqual(await route('session'), { status: 200, body: { token: 'session' } });
  assert.equal(readRouteMode(undefined), 'primary');
  assert.throws(() => readRouteMode('all-transactions'));
});

test('offload selects one complete read; transient failure retries the whole read once', async () => {
  const calls = [];
  const route = createReadOnlyRpcRoute({ mode: 'offload-failover', scope,
    alternative: async (token, mint) => {
      calls.push(['alternative', token, mint]);
      throw http(429);
    },
    primary: async (token, mint) => {
      calls.push(['primary', token, mint]);
      return { status: 200, body: { assets: ['verified'] } };
    } });
  assert.deepEqual(await route('session', 'mint'),
    { status: 200, body: { assets: ['verified'] } });
  assert.deepEqual(calls, [['alternative', 'session', 'mint'],
    ['primary', 'session', 'mint']]);
});

test('primary can retry on transient failure without offloading normal reads', async () => {
  const calls = [];
  const route = createReadOnlyRpcRoute({ mode: 'primary-failover', scope,
    primary: async () => { calls.push('primary'); throw http(503); },
    alternative: async () => { calls.push('alternative'); return { status: 200 }; } });
  assert.deepEqual(await route(), { status: 200 });
  assert.deepEqual(calls, ['primary', 'alternative']);
});

test('both transient failures return unavailable, never an empty inventory', async () => {
  const route = createReadOnlyRpcRoute({ mode: 'offload-failover', scope,
    primary: async () => { throw Object.assign(new Error('network'), { code: 'ETIMEDOUT' }); },
    alternative: async () => { throw http(502); } });
  assert.deepEqual(await route(), { status: 503,
    body: { message: 'Asset data temporarily unavailable.' } });
});

test('authorization, wrong cluster and malformed data do not trigger fallback', async () => {
  for (const failure of [http(403, 'Forbidden'), http(401),
    new Error('Wallet asset reader cluster mismatch'), new Error('Invalid Silver inventory')]) {
    let fallbackCalls = 0;
    const route = createReadOnlyRpcRoute({ mode: 'offload-failover', scope,
      alternative: async () => { throw failure; },
      primary: async () => { fallbackCalls++; return { status: 200 }; } });
    await assert.rejects(route(), error => error === failure);
    assert.equal(fallbackCalls, 0);
  }
});

test('provider-confirmed quota error may fail over; ordinary 403 may not', () => {
  assert.equal(retryableRpcFailure(http(403, 'Quota exceeded')), true);
  assert.equal(retryableRpcFailure(http(403, 'Forbidden')), false);
  assert.equal(retryableRpcFailure(http(400, 'Invalid account data')), false);
  assert.equal(retryableRpcFailure(Object.assign(new Error('fetch failed'),
    { cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })), true);
});

test('isolated Box-media reader propagates transient RPC failure; legacy reader does not',
  async () => {
    const failure = http(429);
    const rpc = {
      getGenesisHash: () => ({ send: async () =>
        'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }),
      getAccountInfo: () => ({ send: async () => { throw failure; } }),
    };
    const input = { programId: '11111111111111111111111111111111', cluster: 'devnet',
      mintAddress: '11111111111111111111111111111111', issuanceId: '0'.repeat(64),
      collectionId: '11111111111111111111111111111111' };
    const strict = createSilverChainReader('https://example.invalid',
      { rpc, propagateTransientReadErrors: true });
    await assert.rejects(strict.readBoxMedia(input), error => error === failure);
    const legacy = createSilverChainReader('https://example.invalid', { rpc });
    assert.deepEqual(await legacy.readBoxMedia(input), {});
  });

function trackedRpc(scope, behavior) {
  const state = { active: 0, calls: [] };
  const createRpc = url => ({ getAccountInfo: () => ({
    send: ({ abortSignal }) => {
      assert.ok(abortSignal);
      state.calls.push(url);
      if (behavior[url] === 'success') return Promise.resolve({ value: url });
      state.active++;
      return new Promise((_, reject) => {
        const stop = () => { state.active--; reject(abortSignal.reason); };
        if (abortSignal.aborted) stop();
        else abortSignal.addEventListener('abort', stop, { once: true });
      });
    },
  }) });
  return { state,
    primary: createScopedReadRpc('primary', scope, createRpc),
    alternative: createScopedReadRpc('alternative', scope, createRpc) };
}

test('successful read uses one provider and its scoped Solana Kit signal', async () => {
  const localScope = createReadOnlyRpcScope();
  const { state, primary, alternative } = trackedRpc(localScope,
    { primary: 'success', alternative: 'success' });
  const route = createReadOnlyRpcRoute({ mode: 'primary-failover', scope: localScope,
    totalTimeoutMs: 120, firstAttemptTimeoutMs: 40,
    primary: () => primary.getAccountInfo().send(),
    alternative: () => alternative.getAccountInfo().send() });
  assert.deepEqual(await route(), { value: 'primary' });
  assert.deepEqual(state.calls, ['primary']);
  assert.equal(state.active, 0);
});

test('hung first provider is aborted before the whole-read fallback', async () => {
  const localScope = createReadOnlyRpcScope();
  const { state, primary, alternative } = trackedRpc(localScope,
    { primary: 'hang', alternative: 'success' });
  let lateRpcBlocked = false;
  const route = createReadOnlyRpcRoute({ mode: 'primary-failover', scope: localScope,
    totalTimeoutMs: 160, firstAttemptTimeoutMs: 50,
    primary: async () => {
      try { return await primary.getAccountInfo().send(); }
      catch (error) {
        assert.throws(() => primary.getAccountInfo().send());
        lateRpcBlocked = true;
        throw error;
      }
    },
    alternative: () => alternative.getAccountInfo().send() });
  assert.deepEqual(await route(), { value: 'alternative' });
  assert.deepEqual(state.calls, ['primary', 'alternative']);
  assert.equal(state.active, 0);
  assert.equal(lateRpcBlocked, true);
});

test('total deadline aborts both hung providers and returns unavailable', async () => {
  const localScope = createReadOnlyRpcScope();
  const { state, primary, alternative } = trackedRpc(localScope,
    { primary: 'hang', alternative: 'hang' });
  const route = createReadOnlyRpcRoute({ mode: 'primary-failover', scope: localScope,
    totalTimeoutMs: 110, firstAttemptTimeoutMs: 35,
    primary: () => primary.getAccountInfo().send(),
    alternative: () => alternative.getAccountInfo().send() });
  const started = Date.now();
  assert.deepEqual(await route(), { status: 503,
    body: { message: 'Asset data temporarily unavailable.' } });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(state.calls, ['primary', 'alternative']);
  assert.equal(state.active, 0);
});

test('actual Solana Kit HTTP request receives cancellation on deadline', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let aborted = false;
  globalThis.fetch = (_url, options) => {
    active++;
    return new Promise((_, reject) => {
      const stop = () => {
        active--;
        aborted = true;
        reject(options.signal.reason);
      };
      if (options.signal.aborted) stop();
      else options.signal.addEventListener('abort', stop, { once: true });
    });
  };
  try {
    const localScope = createReadOnlyRpcScope();
    const rpc = createScopedReadRpc('https://example.invalid', localScope);
    const route = createReadOnlyRpcRoute({ mode: 'offload', scope: localScope,
      totalTimeoutMs: 80, firstAttemptTimeoutMs: 30,
      primary: async () => ({ status: 200 }),
      alternative: () => rpc.getGenesisHash().send() });
    await assert.rejects(route(), error => error.code === 'ETIMEDOUT');
    assert.equal(aborted, true);
    assert.equal(active, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('actual Solana Kit HTTP response succeeds through the bounded read scope', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.signal);
    requests++;
    const payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const localScope = createReadOnlyRpcScope();
    const rpc = createScopedReadRpc('https://example.invalid', localScope);
    const route = createReadOnlyRpcRoute({ mode: 'offload', scope: localScope,
      totalTimeoutMs: 120, firstAttemptTimeoutMs: 30,
      primary: async () => { throw new Error('Unexpected primary read'); },
      alternative: () => rpc.getGenesisHash().send() });
    assert.equal(await route(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
