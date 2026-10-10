import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { createCooperEruHttp } from '../src/cooper-eru-http.js';
import { verifyCooperEruDevnetConfig } from '../src/cooper-eru-candidate-reader.js';
import { createAlphaServer } from '../src/server.js';

const TOKEN = 'b'.repeat(64);
const OPERATION = randomUUID();
const RING = randomUUID();
const key = byte => bs58.encode(Buffer.alloc(32, byte));
const deployment = { gatewayProgramId: key(11), hookProgramId: key(12),
  mintAddress: key(13), reserveAddress: key(14), treasuryAddress: key(15),
  vaultAddress: key(16), attestorAddress: key(17), configEpoch: 1 };

test('canonical Cooper Devnet startup config rejects altered authority or attestor', async () => {
  const encoder = getAddressEncoder();
  const [config] = await getProgramDerivedAddress({
    programAddress: deployment.gatewayProgramId,
    seeds: [new TextEncoder().encode('eru-config')] });
  const [meta] = await getProgramDerivedAddress({
    programAddress: deployment.hookProgramId,
    seeds: [new TextEncoder().encode('extra-account-metas'),
      encoder.encode(deployment.mintAddress)] });
  const data = Buffer.alloc(330);
  data[0] = 1;
  data.writeBigUInt64LE(1n, 322);
  for (const [offset, value] of [[1, deployment.vaultAddress],
    [33, deployment.mintAddress], [65, deployment.treasuryAddress],
    [97, deployment.hookProgramId], [129, deployment.reserveAddress],
    [290, deployment.attestorAddress]]) data.set(encoder.encode(value), offset);
  const chain = { async getGenesisHash() {
    return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  }, async getAccountInfo(address) {
    if (address === deployment.gatewayProgramId ||
        address === deployment.hookProgramId) return { executable: true };
    if (address === config) return { owner: deployment.gatewayProgramId, data };
    if (address === meta) return { owner: deployment.hookProgramId, data: Buffer.alloc(86) };
    return null;
  } };
  assert.equal((await verifyCooperEruDevnetConfig({ chain, ...deployment })).config, config);
  await assert.rejects(() => verifyCooperEruDevnetConfig({ chain, ...deployment,
    attestorAddress: key(18) }), /unavailable/);
  data[1] ^= 1;
  await assert.rejects(() => verifyCooperEruDevnetConfig({ chain, ...deployment }),
    /unavailable/);
});

test('Cooper ERU HTTP routes are gated and account-scoped', async () => {
  const calls = [];
  const auth = { async me(token) { return token === TOKEN ?
    { status: 200, body: { id: 'account-from-session' } } :
    { status: 401, body: { code: 'AUTH_REQUIRED' } }; } };
  const levelUp = { async prepareEru(token, ringId, body) {
    calls.push(['prepare', token, ringId, body]);
    return { status: 200, body: { operationId: OPERATION } };
  } };
  const flow = Object.fromEntries(['review', 'refresh', 'submit', 'status'].map(name =>
    [name, async (...args) => { calls.push([name, ...args]);
      return { status: 'unknown', operationId: OPERATION }; }]));
  const api = createCooperEruHttp({ auth, levelUp, flow });
  const serve = async (enabled, check) => {
    const server = createAlphaServer(auth, null, null, null, null, null, null, null,
      undefined, null, null, null, null, null, null, enabled ? api : null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await check(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
  };
  const path = '/me/cooper/eru/review';
  const post = (url, body, token = TOKEN) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  await serve(false, async url => {
    assert.equal((await post(url + path, { operationId: OPERATION })).status, 404);
    assert.equal((await post(url + `/me/rings/${RING}/level-up/eru/prepare`, {})).status, 404);
  });
  await serve(true, async url => {
    assert.equal((await fetch(url + path)).status, 404);
    assert.equal((await post(url + path, { operationId: OPERATION }, 'c'.repeat(64))).status, 401);
    assert.equal((await post(url + path, { operationId: OPERATION,
      accountId: 'forged' })).status, 400);
    assert.equal((await post(url + path, { operationId: OPERATION })).status, 200);
    assert.equal((await post(url + `/me/rings/${RING}/level-up/eru/prepare`,
      { expectedCurrentLevel: 4, targetLevel: 5, idempotencyKey: OPERATION })).status, 200);
    assert.equal((await post(url + '/me/cooper/eru/refresh',
      { operationId: OPERATION, approved: { candidate: {} } })).status, 200);
    assert.equal((await post(url + '/me/cooper/eru/submit', { operationId: OPERATION,
      refreshed: {}, userSignatureBase64: 'test' })).status, 200);
    assert.equal((await post(url + '/me/cooper/eru/status',
      { operationId: OPERATION })).status, 200);
  });
  assert.deepEqual(calls.map(call => call[0]),
    ['review', 'prepare', 'refresh', 'submit', 'status']);
  assert.deepEqual(calls.filter(call => call[0] !== 'prepare').map(call => call[1]),
    Array(4).fill('account-from-session'));
});
