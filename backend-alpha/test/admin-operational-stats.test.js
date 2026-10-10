import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAdminOperationalStats } from '../src/admin-operational-stats.js';
import { createAlphaServer } from '../src/server.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const bytes = value => getAddressEncoder().encode(value);
const deployment = { gatewayProgramId: key(11), hookProgramId: key(12),
  mintAddress: key(13), reserveAddress: key(14), treasuryAddress: key(15),
  vaultAddress: key(16), attestorAddress: key(17), configEpoch: 1 };
const token = 'a'.repeat(64);

function tokenAccount(value, owner = deployment.vaultAddress) {
  const data = Buffer.alloc(165);
  data.set(bytes(deployment.mintAddress));
  data.set(bytes(owner), 32);
  data[108] = 1;
  data.writeBigUInt64LE(value, 64);
  return { owner: TOKEN_2022_PROGRAM_ADDRESS, data };
}

test('admin statistics enforce auth before reads, preserve exact amounts, and fail closed on bad token account', async () => {
  const [config] = await getProgramDerivedAddress({
    programAddress: deployment.gatewayProgramId,
    seeds: [new TextEncoder().encode('eru-config')] });
  const [meta] = await getProgramDerivedAddress({
    programAddress: deployment.hookProgramId,
    seeds: [new TextEncoder().encode('extra-account-metas'), bytes(deployment.mintAddress)] });
  const configData = Buffer.alloc(330);
  configData[0] = 1;
  configData.writeBigUInt64LE(1n, 322);
  for (const [offset, value] of [[1, deployment.vaultAddress],
    [33, deployment.mintAddress], [65, deployment.treasuryAddress],
    [97, deployment.hookProgramId], [129, deployment.reserveAddress],
    [290, deployment.attestorAddress]]) configData.set(bytes(value), offset);
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(9_007_199_254_740_993n, 36);
  mintData[44] = 9;
  mintData[45] = 1;
  let reserve = tokenAccount(9_007_199_254_740_992n);
  let reads = 0;
  const chain = {
    async getGenesisHash() { reads++; return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; },
    async getAccountInfo(value) {
      reads++;
      if ([deployment.gatewayProgramId, deployment.hookProgramId].includes(value))
        return { executable: true };
      if (value === config) return { owner: deployment.gatewayProgramId, data: configData };
      if (value === meta) return { owner: deployment.hookProgramId, data: Buffer.alloc(86) };
      if (value === deployment.mintAddress)
        return { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintData };
      if (value === deployment.reserveAddress) return reserve;
      if (value === deployment.treasuryAddress) return tokenAccount(123n);
      return null;
    },
  };
  const auth = { async me(value) { return value === token ?
    { status: 200, body: { id: 'actor' } } :
    { status: 401, body: { message: 'Authentication required.' } }; } };
  let admin = false;
  const pool = { async query(sql) {
    reads++;
    if (sql.includes('FROM alpha_accounts'))
      return { rows: [{ is_admin: admin, verified_at: new Date() }] };
    assert.match(sql, /alpha_eru_intents/);
    assert.match(sql, /alpha_hybrid_operations/);
    assert.match(sql, /alpha_draw_fulfillments/);
    return { rows: [
      { family: 'eru_send_canonical', state: 'confirmed', count: '1', oldest_unresolved_at: null },
      { family: 'eru_send_canonical', state: 'unknown', count: '2',
        oldest_unresolved_at: new Date('2026-10-01T00:00:00Z') },
    ] };
  } };
  const stats = createAdminOperationalStats({ pool, auth, chain, deployment });
  assert.equal((await stats.read(null)).status, 401);
  assert.equal(reads, 0);
  assert.equal((await stats.read(token)).status, 403);
  assert.equal(reads, 1);
  admin = true;
  const result = await stats.read(token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.operations.eru_send_canonical, {
    states: { confirmed: '1', unknown: '2' },
    oldestUnresolvedAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(result.body.canonicalEru.supplyBaseUnits, '9007199254740993');
  assert.equal(result.body.canonicalEru.reserveBaseUnits, '9007199254740992');
  assert.equal(result.body.canonicalEru.treasuryBaseUnits, '123');
  assert.equal(result.body.canonicalEru.gateway.healthy, true);
  reserve = tokenAccount(1n);
  reserve.data[0] ^= 1;
  await assert.rejects(() => stats.read(token), /token account unavailable/);
});

test('admin statistics route is read-only and gated', async () => {
  const auth = { async me() { return { status: 401, body: { code: 'AUTH_REQUIRED' } }; } };
  const server = createAlphaServer(auth, null, null, null, null, null, null, null,
    undefined, null, null, null, null, null, null, null, null, null, null,
    undefined, null, null, null, { read: token => auth.me(token) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/operational-stats`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: {
      'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
