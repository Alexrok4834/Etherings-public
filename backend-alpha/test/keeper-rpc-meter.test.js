import assert from 'node:assert/strict';
import test from 'node:test';
import { createSolanaRpc } from '@solana/kit';
import { installKeeperRpcMeter } from '../src/keeper-rpc-meter.js';

test('keeper RPC meter counts physical calls by phase and method without changing fetch results', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const response = { status: 200 };
  const fetchImpl = async (...args) => {
    requests.push(args);
    if (args[1]?.body?.includes('getBalance')) throw new Error('offline');
    return response;
  };
  const rpcUrl = 'https://example.invalid/rpc';
  const meter = installKeeperRpcMeter({ rpcUrl, fetchImpl });
  try {
    const stateRequest = { body: JSON.stringify({ jsonrpc: '2.0', method: 'getAccountInfo',
      params: ['private-address'] }) };
    const actual = await meter.measure('escrow-provisioner', () =>
      globalThis.fetch(rpcUrl, stateRequest));
    assert.equal(actual, response);
    await globalThis.fetch('https://example.invalid/other', stateRequest);
    await assert.rejects(meter.measure('silver-keeper', () => globalThis.fetch(rpcUrl,
      { body: JSON.stringify({ jsonrpc: '2.0', method: 'getBalance', params: [] }) })),
    /offline/);
    assert.equal(requests.length, 3);
    assert.deepEqual(meter.snapshotAndReset(), {
      'escrow-provisioner|getAccountInfo|200': 1,
      'silver-keeper|getBalance|network-error': 1,
    });
    assert.deepEqual(meter.snapshotAndReset(), {});
  } finally {
    meter.uninstall();
    assert.equal(globalThis.fetch, originalFetch);
  }
});

test('keeper RPC meter sees the actual Solana Kit HTTP request', async () => {
  const rpcUrl = 'https://example.invalid/rpc';
  const meter = installKeeperRpcMeter({ rpcUrl, fetchImpl: async (_input, init) => {
    const payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: 'mock-genesis' }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  } });
  try {
    const rpc = createSolanaRpc(rpcUrl);
    assert.equal(await meter.measure('escrow-provisioner', () =>
      rpc.getGenesisHash().send()), 'mock-genesis');
    assert.deepEqual(meter.snapshotAndReset(), {
      'escrow-provisioner|getGenesisHash|200': 1,
    });
  } finally {
    meter.uninstall();
  }
});
