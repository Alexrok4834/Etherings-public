import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postJsonRpc } from '../src/json-rpc.js';

test('JSON RPC request has a deadline when the provider never responds', async () => {
  let requestSignal;
  const stalledFetch = (_url, options) => new Promise((_resolve, reject) => {
    requestSignal = options.signal;
    requestSignal.addEventListener('abort', () => reject(requestSignal.reason),
      { once: true });
  });
  await assert.rejects(postJsonRpc({ url: 'https://rpc.invalid',
    method: 'getSignatureStatuses', id: 1, label: 'Silver RPC',
    fetchImpl: stalledFetch, timeoutMs: 20 }), { name: 'TimeoutError' });
  assert.equal(requestSignal.aborted, true);
});

test('JSON RPC preserves request and rejects HTTP or provider errors', async () => {
  let request;
  const okFetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: { value: 7 } }) };
  };
  assert.deepEqual(await postJsonRpc({ url: 'https://rpc.invalid',
    method: 'getSlot', params: [{ commitment: 'finalized' }], id: 2,
    label: 'Draw ERU RPC', fetchImpl: okFetch }), { value: 7 });
  assert.deepEqual(request, { jsonrpc: '2.0', id: 2, method: 'getSlot',
    params: [{ commitment: 'finalized' }] });
  await assert.rejects(postJsonRpc({ url: 'https://rpc.invalid',
    method: 'getSlot', id: 3, label: 'Draw ERU RPC',
    fetchImpl: async () => ({ ok: false }) }), /Draw ERU RPC getSlot unavailable/);
  await assert.rejects(postJsonRpc({ url: 'https://rpc.invalid',
    method: 'getSlot', id: 4, label: 'Silver RPC',
    fetchImpl: async () => ({ ok: true,
      json: async () => ({ error: { code: -32005 } }) }) }),
  /Silver RPC getSlot rejected: -32005/);
});
