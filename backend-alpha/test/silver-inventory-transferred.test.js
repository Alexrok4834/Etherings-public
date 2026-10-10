import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSilverFirstEntry, firstEntryIdentity } from '../src/silver-first-entry.js';

const token = 'a'.repeat(64);
const wallet = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
const otherWallet = '9Xe9Eq77ovjKmGm9TGoTcHuYnGisaZq8K4DUi95zrrpF';
const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const collectionId = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
const gameplay = { level: 1, shine: 100, unspentPoints: 0,
  comfort: 15, charm: 20, quality: 25, luck: 30,
  lastDirectTransferSlot: '150', cooldownUntilUnixSeconds: '1790000000' };

test('transferred Ring inventory is authenticated, owner-scoped and restart-safe without an issuance row', async () => {
  let binding = { account_id: 'd108ef96-b90e-4a98-830e-237dc800d63a',
    wallet_address: wallet, environment: 'alpha-dev' };
  const pool = { async query(sql, params) {
    if (sql.includes('FROM alpha_sessions')) {
      assert.equal(params[0], createHash('sha256').update(token, 'ascii').digest('hex'));
      return { rows: binding ? [binding] : [] };
    }
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  let observed;
  const ring = { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
    collectionId, tokenOwner: wallet, mintAddress: otherWallet, boxMint: programId,
    designId: 26, uri: 'ipfs://test-ring', contentHash: 'a'.repeat(64),
    serial: '1', ...gameplay };
  let candidates = [ring, ring];
  const chain = { readFinalized: async () => null,
    listOwnedRings: async input => { observed = input; return candidates; } };
  const service = () => createSilverFirstEntry({ pool, chain, cluster: 'devnet',
    programId, collectionId, walletEnvironment: 'alpha-dev' });
  const expected = [{ kind: 'SILVER_RING', mintAddress: otherWallet,
    boxMint: programId, designId: 26, uri: 'ipfs://test-ring',
    contentHash: 'a'.repeat(64), serial: '1', ...gameplay }];
  assert.deepEqual((await service().inventory(token)).body.assets, expected);
  assert.deepEqual(observed, { programId, cluster: 'devnet', walletAddress: wallet });
  assert.deepEqual((await service().inventory(token)).body.assets, expected);
  candidates = [{ ...ring, tokenOwner: otherWallet }];
  assert.deepEqual((await service().inventory(token)).body.assets, []);
  candidates = [{ ...ring, cluster: 'local-validator' }];
  assert.deepEqual((await service().inventory(token)).body.assets, []);
  binding = null;
  assert.equal((await service().inventory(token)).status, 401);
  binding = { account_id: 'd108ef96-b90e-4a98-830e-237dc800d63a',
    wallet_address: null, environment: null };
  assert.equal((await service().inventory(token)).status, 409);
});

test('a purchased sealed Box appears through the existing inventory, not an issuance row', async () => {
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_sessions')) return { rows: [{
      account_id: 'd108ef96-b90e-4a98-830e-237dc800d63a',
      wallet_address: wallet, environment: 'alpha-dev',
    }] };
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const box = { finalized: true, kind: 'SILVER_BOX', programId,
    cluster: 'devnet', collectionId, tokenOwner: wallet,
    mintAddress: otherWallet, issuanceId: 'a'.repeat(64), serial: '3',
    lifecycle: 'SEALED', cooldownUntilUnixSeconds: '0',
    uri: 'ipfs://test-box', contentHash: 'b'.repeat(64) };
  let candidates = [box, box];
  const chain = { readFinalized: async () => null,
    listOwnedRings: async () => [], listOwnedBoxes: async () => candidates };
  const service = createSilverFirstEntry({ pool, chain, cluster: 'devnet',
    programId, collectionId, walletEnvironment: 'alpha-dev' });
  const expected = [{ kind: 'SILVER_BOX', mintAddress: otherWallet,
    issuanceId: 'a'.repeat(64), serial: '3', lifecycle: 'SEALED',
    cooldownUntilUnixSeconds: '0', uri: 'ipfs://test-box',
    contentHash: 'b'.repeat(64) }];
  assert.deepEqual((await service.inventory(token)).body.assets, expected);
  candidates = [{ ...box, tokenOwner: otherWallet }];
  assert.deepEqual((await service.inventory(token)).body.assets, []);
});

test('post-opening Ring inventory keeps exact chain gameplay and cooldown fields', async () => {
  const accountId = 'd108ef96-b90e-4a98-830e-237dc800d63a';
  const identity = firstEntryIdentity(accountId, wallet, 'devnet');
  const row = { wallet_address: wallet, cluster: 'devnet', issuance_source: 'first-entry',
    issuance_id: identity.issuanceId, entitlement_digest: identity.entitlementDigest,
    status: 'confirmed', mint_address: programId, finalized_signature: 'test-finalized' };
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_sessions')) return { rows: [{ account_id: accountId,
      wallet_address: wallet, environment: 'alpha-dev' }] };
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [row] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const ring = { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
    collectionId, tokenOwner: wallet, mintAddress: otherWallet, boxMint: programId,
    accountId, originalRecipient: wallet, issuanceId: identity.issuanceId,
    entitlementDigest: identity.entitlementDigest, designId: 26, uri: 'ipfs://test-ring',
    contentHash: 'a'.repeat(64), serial: '1', ...gameplay,
    lastDirectTransferSlot: '0', cooldownUntilUnixSeconds: '0' };
  const chain = { readFinalized: async () => null,
    readRingForIssuance: async () => ring, listOwnedRings: async () => [ring] };
  const service = createSilverFirstEntry({ pool, chain, cluster: 'devnet',
    programId, collectionId, walletEnvironment: 'alpha-dev' });
  assert.deepEqual((await service.inventory(token)).body.assets, [{
    kind: 'SILVER_RING', mintAddress: otherWallet, boxMint: programId,
    designId: 26, uri: 'ipfs://test-ring', contentHash: 'a'.repeat(64),
    serial: '1', ...gameplay, lastDirectTransferSlot: '0',
    cooldownUntilUnixSeconds: '0',
  }]);
});
