import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilverFirstEntry } from '../src/silver-first-entry.js';
import { drawBoxIdentity } from '../src/draw-box-identity.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const resultId = '22222222-2222-4222-8222-222222222222';
const walletAddress = '11111111111111111111111111111111';
const programId = walletAddress;
const collectionId = walletAddress;
const mintAddress = '7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe';

test('current ownership starts while draw provenance is checked and stays deduplicated', async () => {
  const calls = [];
  let releaseDraw;
  const drawPending = new Promise(resolve => { releaseDraw = resolve; });
  const identity = drawBoxIdentity(accountId, walletAddress, resultId);
  const sourceBox = { finalized: true, kind: 'SILVER_BOX', lifecycle: 'SEALED',
    accountId, originalRecipient: walletAddress, tokenOwner: walletAddress,
    entitlementDigest: identity.entitlementDigest, mintAddress, serial: '1',
    cooldownUntilUnixSeconds: '0' };
  const pool = { query: async sql => {
    if (sql.includes('FROM alpha_sessions')) return { rows: [{ account_id: accountId,
      wallet_address: walletAddress, environment: 'alpha-local' }] };
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [] };
    if (sql.includes('FROM alpha_draw_results')) return { rows: [{ result_id: resultId,
      chain_signature: 'test-signature', chain_asset_address: mintAddress }] };
    throw new Error('Unexpected database query');
  } };
  const chain = {
    readFinalized: async () => { calls.push('draw-start'); await drawPending; return sourceBox; },
    listOwnedRings: async () => [],
    listOwnedAssets: async () => { calls.push('owned-start'); return [[{
      ...sourceBox, programId, cluster: 'devnet', collectionId, issuanceId: identity.issuanceId,
    }], []]; },
  };
  const service = createSilverFirstEntry({ pool, chain, cluster: 'devnet',
    programId, collectionId, walletEnvironment: 'alpha-local', drawInventoryEnabled: true });
  const pending = service.inventory('a'.repeat(64));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['owned-start', 'draw-start']);
  releaseDraw();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.assets.map(asset => asset.mintAddress), [mintAddress]);
});

test('a failed provenance read waits for the already started ownership read to settle', async () => {
  let releaseOwned;
  const ownedPending = new Promise(resolve => { releaseOwned = resolve; });
  const pool = { query: async sql => {
    if (sql.includes('FROM alpha_sessions')) return { rows: [{ account_id: accountId,
      wallet_address: walletAddress, environment: 'alpha-local' }] };
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [] };
    if (sql.includes('FROM alpha_draw_results')) return { rows: [{ result_id: resultId,
      chain_signature: 'test-signature', chain_asset_address: mintAddress }] };
    throw new Error('Unexpected database query');
  } };
  const chain = {
    readFinalized: async () => { throw new Error('Provenance RPC failed'); },
    listOwnedRings: async () => [],
    listOwnedAssets: () => ownedPending,
  };
  const service = createSilverFirstEntry({ pool, chain, cluster: 'devnet',
    programId, collectionId, walletEnvironment: 'alpha-local', drawInventoryEnabled: true });
  let settled = false;
  const pending = service.inventory('a'.repeat(64)).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseOwned([[], []]);
  await assert.rejects(pending, /Provenance RPC failed/);
});
