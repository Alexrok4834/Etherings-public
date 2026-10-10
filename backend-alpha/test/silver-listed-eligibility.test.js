import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silverRingIsListed } from '../src/silver-listed-eligibility.js';
import { createSilverAllocation } from '../src/silver-allocation.js';

test('only canonical ACTIVE Ring listing excludes gameplay; provider errors fail closed', async () => {
  const mint = 'Ep5gX71AVRx7TEVt32AeZPx3VtxuGsqoULUrU5GdssKt';
  let listing = null;
  const reader = { readListing: async () => listing };
  assert.equal(await silverRingIsListed(reader, mint), false);
  listing = { mintAddress: mint, kind: 'SILVER_RING', state: 'ACTIVE' };
  assert.equal(await silverRingIsListed(reader, mint), true);
  for (const state of ['CANCELLED', 'SOLD']) {
    listing = { ...listing, state };
    assert.equal(await silverRingIsListed(reader, mint), false);
  }
  await assert.rejects(silverRingIsListed({ readListing: async () => {
    throw new Error('RPC unavailable');
  } }, mint), /RPC unavailable/);
  for (const mismatch of [{ ...listing, mintAddress: 'wrong' },
    { ...listing, kind: 'SILVER_BOX' }, { ...listing, state: 'UNKNOWN' }]) {
    listing = mismatch;
    await assert.rejects(silverRingIsListed(reader, mint), /unavailable/);
  }
});

test('listed Silver rejects Points review before any signer action', async () => {
  const mintAddress = 'Ep5gX71AVRx7TEVt32AeZPx3VtxuGsqoULUrU5GdssKt';
  const wallet = 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX';
  const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  let signingCalls = 0;
  const flow = createSilverAllocation({
    pool: { connect() {}, query: async () => ({ rows: [{ wallet_address: wallet }] }) },
    auth: { me: async () => ({ status: 200, body: { id: 'owner' } }) },
    reader: { listOwnedRings: async () => [{ mintAddress, tokenOwner: wallet,
      kind: 'SILVER_RING', cluster: 'devnet', programId, issuanceId: 'a'.repeat(64),
      boxMint: 'box', level: 5, unspentPoints: 6, cooldownUntilUnixSeconds: '0' }] },
    marketReader: { readListing: async () => ({ mintAddress,
      kind: 'SILVER_RING', state: 'ACTIVE' }) },
    signer: Object.fromEntries(['readOwnedToken', 'latestBlockhash',
      'verifyPinnedProgram', 'isBlockhashValid', 'send'].map(name =>
      [name, async () => { signingCalls++; }])),
    finalityChain: Object.fromEntries(['getGenesisHash', 'getSignatureStatus',
      'getTransaction'].map(name => [name, async () => null])),
    programId,
  });
  const result = await flow.review('session', { mintAddress,
    allocation: { comfort: 1, charm: 0, quality: 0, luck: 0 } });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SILVER_RING_LISTED');
  assert.equal(signingCalls, 0);
});
