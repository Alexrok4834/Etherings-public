import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAlphaServer } from '../src/server.js';
import { createWalletAssets } from '../src/wallet-assets.js';

const walletAddress = '11111111111111111111111111111111';
const mint = '7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe';
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const token = 'a'.repeat(64);

function fixture({ binding = { status: 200, body: { walletAddress, environment: 'alpha-local' } },
  actualGenesis = genesis, tokenOwner = walletAddress } = {}) {
  const calls = [];
  const inventoryCalls = [];
  const rpc = {
    getGenesisHash: () => ({ send: async () => { calls.push('genesis'); return actualGenesis; } }),
    getBalance: (owner, options) => ({ send: async () => {
      calls.push(['sol', owner, options.commitment]);
      return { value: 500_000_000n };
    } }),
    getTokenAccountsByOwner: (owner, filter, options) => ({ send: async () => {
      calls.push(['eru', owner, filter.mint, options.commitment]);
      return { value: [
        { account: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: { parsed: { type: 'account',
          info: { owner: tokenOwner, mint, tokenAmount: { amount: '30600000000', decimals: 9 } } } } } },
        { account: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: { parsed: { type: 'account',
          info: { owner: tokenOwner, mint, tokenAmount: { amount: '400000000', decimals: 9 } } } } } },
      ] };
    } }),
  };
  const wallet = { current: async session => session === token
    ? binding : { status: 401, body: { message: 'Authentication required.' } } };
  const silver = { inventory: async () => { inventoryCalls.push('silver');
    return { status: 200, body: { assets: [
      { kind: 'SILVER_RING', mintAddress: mint, designId: 1 },
    ] } }; } };
  const assets = createWalletAssets({ wallet, silver, rpc, mint, environment: 'alpha-local' });
  return { assets, calls, inventoryCalls };
}

test('finalized Kit balances and verified Silver inventory are bound to one wallet', async () => {
  const { assets, calls } = fixture();
  const result = await assets.read(token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { cluster: 'devnet', walletAddress,
    solLamports: '500000000', eruBaseUnits: '31000000000', eruMint: mint,
    silver: [{ kind: 'SILVER_RING', mintAddress: mint, designId: 1 }] });
  assert.deepEqual(calls, ['genesis', ['sol', walletAddress, 'finalized'],
    ['eru', walletAddress, mint, 'finalized']]);
});

test('balance-only read keeps wallet, genesis and token checks without scanning Silver', async () => {
  const { assets, calls, inventoryCalls } = fixture();
  const result = await assets.readBalances(token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { cluster: 'devnet', walletAddress,
    solLamports: '500000000', eruBaseUnits: '31000000000', eruMint: mint });
  assert.deepEqual(calls, ['genesis', ['sol', walletAddress, 'finalized'],
    ['eru', walletAddress, mint, 'finalized']]);
  assert.deepEqual(inventoryCalls, []);
  for (const binding of [
    { status: 401, body: { message: 'Authentication required.' } },
    { status: 200, body: { walletAddress: null } },
  ]) {
    const denied = fixture({ binding });
    assert.equal((await denied.assets.readBalances(token)).status,
      binding.status === 401 ? 401 : 409);
    assert.deepEqual(denied.calls, []);
  }
  await assert.rejects(fixture({ actualGenesis: 'wrong' }).assets.readBalances(token),
    /cluster mismatch/);
  await assert.rejects(fixture({ tokenOwner: mint }).assets.readBalances(token),
    /Invalid ERU token account/);
});

test('SOL and ERU reads start together after Silver inventory succeeds', async () => {
  const calls = [];
  let releaseSol;
  let releaseEru;
  const solPending = new Promise(resolve => { releaseSol = resolve; });
  const eruPending = new Promise(resolve => { releaseEru = resolve; });
  const rpc = {
    getGenesisHash: () => ({ send: async () => genesis }),
    getBalance: () => ({ send: () => { calls.push('sol'); return solPending; } }),
    getTokenAccountsByOwner: () => ({ send: () => { calls.push('eru'); return eruPending; } }),
  };
  const wallet = { current: async () => ({ status: 200,
    body: { walletAddress, environment: 'alpha-local' } }) };
  const silver = { inventory: async () => { calls.push('silver');
    return { status: 200, body: { assets: [] } }; } };
  const assets = createWalletAssets({ wallet, silver, rpc, mint, environment: 'alpha-local' });
  const read = assets.read(token);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['silver', 'sol', 'eru']);
  } finally {
    releaseSol({ value: 1n });
    releaseEru({ value: [] });
  }
  assert.equal((await read).status, 200);
});

test('unbound or unauthenticated wallet cannot reach chain reader', async () => {
  for (const binding of [
    { status: 401, body: { message: 'Authentication required.' } },
    { status: 200, body: { walletAddress: null } },
    { status: 200, body: { walletAddress, environment: 'other' } },
  ]) {
    const { assets, calls } = fixture({ binding });
    assert.equal((await assets.read(token)).status, binding.status === 401 ? 401 : 409);
    assert.deepEqual(calls, []);
  }
});

test('wrong cluster or token owner fails closed', async () => {
  await assert.rejects(fixture({ actualGenesis: 'wrong' }).assets.read(token), /cluster mismatch/);
  await assert.rejects(fixture({ tokenOwner: mint }).assets.read(token), /Invalid ERU token account/);
});

test('GET /wallet/assets requires a valid session and returns no-store JSON', async () => {
  const { assets } = fixture();
  const server = createAlphaServer({}, {}, null, null, null, null, assets);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const missing = await fetch(`${base}/wallet/assets`);
    assert.equal(missing.status, 401);
    const missingBalances = await fetch(`${base}/wallet/balances`);
    assert.equal(missingBalances.status, 401);
    const response = await fetch(`${base}/wallet/assets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).eruBaseUnits, '31000000000');
    const balances = await fetch(`${base}/wallet/balances`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(balances.status, 200);
    assert.equal(balances.headers.get('cache-control'), 'no-store');
    const body = await balances.json();
    assert.equal(body.eruBaseUnits, '31000000000');
    assert.equal(Object.hasOwn(body, 'silver'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
