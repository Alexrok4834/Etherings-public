import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { createSilverMarketplaceFlow } from '../src/silver-marketplace-flow.js';

const key = () => bs58.encode(randomBytes(32));
const operationId = '22222222-2222-4222-8222-222222222222';

test('LIST reports verified owner cooldown and does not build or send an intent', async () => {
  const wallet = key(), mintAddress = key(), until =
    (Math.floor(Date.now() / 1000) + 3600).toString();
  let tokenOwner = wallet;
  let sourceReads = 0, sends = 0;
  const flow = createSilverMarketplaceFlow({
    pool: { connect: async () => { throw Error('unexpected write'); },
      query: async sql => ({ rows: sql.includes('alpha_wallet_bindings') ?
        [{ wallet_address: wallet }] : [] }) },
    auth: { me: async () => ({ status: 200, body: {
      id: '11111111-1111-4111-8111-111111111111' } }) },
    marketReader: { verifyPinnedPrograms: async () => {},
      readConfig: async () => ({ version: '1' }), readListing: async () => null,
      readOwnedSource: async () => { sourceReads++; return key(); },
      latestBlockhash: async () => ({ blockhash: key(), lastValidBlockHeight: 10 }),
      isBlockhashValid: async () => true, simulate: async () => ({ err: null }),
      send: async () => { sends++; }, finalizedTransaction: async () => null },
    silverReader: { listOwnedBoxes: async () => [], listOwnedRings: async () =>
      [{ kind: 'SILVER_RING', mintAddress, tokenOwner,
        cooldownUntilUnixSeconds: until }] },
    marketProgramId: key(), silverProgramId: key(),
  });
  const request = { operationId, action: 'LIST', mintAddress, priceLamports: '100' };
  await assert.rejects(flow.review('token', request), error => {
    assert.equal(error.code, 'MARKETPLACE_LISTING_COOLDOWN');
    assert.equal(error.cooldownUntilUnixSeconds, until);
    return true;
  });
  assert.equal(sourceReads, 0);
  assert.equal(sends, 0);
  tokenOwner = key();
  await assert.rejects(flow.review('token', request), error => {
    assert.equal(error.code, undefined, 'wrong owner must not disclose cooldown');
    return true;
  });
});

test('LIST refresh keeps exact intent; signed submission is durable before broadcast', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const wallet = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const marketProgramId = key(), silverProgramId = key(), mintAddress = key(),
    sourceTokenAddress = key(), blockhash = key();
  const accountId = '11111111-1111-4111-8111-111111111111';
  const vault = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
  let stored = null, sent = null, simulated = 0, finalized = null;
  const pool = {
    async query(sql) {
      if (sql.includes('FROM alpha_wallet_bindings'))
        return { rows: [{ wallet_address: wallet }] };
      if (sql.includes('FROM alpha_silver_marketplace_submissions'))
        return { rows: stored ? [stored] : [] };
      throw new Error(sql);
    },
    async connect() {
      return { async query(sql, params) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM alpha_accounts')) return { rows: [{ id: accountId }] };
        if (sql.includes('FROM alpha_wallet_bindings'))
          return { rows: [{ wallet_address: wallet }] };
        if (sql.includes('INSERT INTO alpha_silver_marketplace_submissions')) {
          assert.equal(sent, null, 'broadcast must follow durable INSERT');
          stored = { signature: params[0], account_id: params[1],
            operation_id: params[2], wallet_address: params[3], action: params[4],
            mint_address: params[5], nonce: params[6],
            terms: JSON.parse(params[7]), message_base64: params[8] };
          return { rows: [] };
        }
        if (sql.includes('FROM alpha_silver_marketplace_submissions'))
          return { rows: stored ? [stored] : [] };
        throw new Error(sql);
      }, release() {} };
    },
  };
  const marketReader = {
    verifyPinnedPrograms: async () => {},
    readConfig: async () => ({ version: '1', royaltyAddress: vault,
      platformAddress: vault }),
    readListing: async () => null,
    readOwnedSource: async () => sourceTokenAddress,
    latestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    isBlockhashValid: async () => true,
    simulate: async () => { simulated++; return { err: null }; },
    send: async raw => { assert(stored); sent = raw; return stored.signature; },
    finalizedTransaction: async () => finalized,
  };
  const silverReader = { listOwnedBoxes: async () => [],
    listOwnedRings: async () => [{ kind: 'SILVER_RING',
      mintAddress, tokenOwner: wallet, cooldownUntilUnixSeconds: '0' }] };
  let reconciled = 0;
  const flow = createSilverMarketplaceFlow({ pool,
    auth: { me: async () => ({ status: 200, body: { id: accountId } }) },
    marketReader, silverReader, marketProgramId, silverProgramId,
    equipment: { current: async () => { reconciled++; return { status: 200 }; } } });
  const request = { operationId, action: 'LIST', mintAddress,
    priceLamports: '100000000000' };
  const reviewed = (await flow.review('token', request)).body;
  assert.equal((await flow.status('token', operationId)).body.status, 'not_submitted');
  assert.equal(reviewed.terms.buyerDebitLamports, '106000000000');
  await assert.rejects(flow.refresh('token', { approved: {
    ...reviewed, terms: { ...reviewed.terms, priceLamports: '1' },
  } }), /unavailable/);
  const refreshed = (await flow.refresh('token', { approved: reviewed })).body;
  const message = Buffer.from(refreshed.candidate.messageBase64, 'base64');
  const userSignatureBase64 = sign(null, message, privateKey).toString('base64');
  const submitted = await flow.submit('token', { refreshed, userSignatureBase64 });
  assert.equal(submitted.body.status, 'unknown');
  assert.equal(simulated, 1);
  assert(sent);
  await assert.rejects(flow.review('token', request), /unavailable/);
  assert.equal((await flow.status('token', operationId)).body.status, 'unknown');
  finalized = { transaction: [sent, 'base64'], meta: { err: null } };
  assert.equal((await flow.status('token', operationId)).body.status, 'confirmed');
  assert.equal(reconciled, 1);
});

test('BUY/CANCEL read exact active listing and refuse stale or changed price', async () => {
  const buyer = key(), seller = key(), mintAddress = key(), sourceTokenAddress = key();
  const marketProgramId = key(), silverProgramId = key();
  const vault = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
  const accountId = '11111111-1111-4111-8111-111111111111';
  const config = { version: '1', royaltyAddress: vault, platformAddress: vault };
  const listing = { state: 'ACTIVE', sourceReady: true, kind: 'SILVER_BOX',
    sellerAddress: seller, sourceTokenAddress, mintAddress, nonce: '3',
    configVersion: '1', royaltyAddress: vault, platformAddress: vault,
    priceLamports: '100', royaltyLamports: '4', platformLamports: '2',
    buyerDebitLamports: '106' };
  let currentWallet = buyer;
  const pool = { connect: async () => { throw new Error('unused'); },
    query: async sql => sql.includes('FROM alpha_wallet_bindings') ?
      { rows: [{ wallet_address: currentWallet }] } : { rows: [] } };
  const reader = { readConfig: async () => config,
    verifyPinnedPrograms: async () => {},
    readListing: async () => listing,
    readOwnedSource: async () => null,
    latestBlockhash: async () => ({ blockhash: key(), lastValidBlockHeight: 10 }),
    isBlockhashValid: async () => true, simulate: async () => ({ err: null }),
    send: async () => '', finalizedTransaction: async () => null };
  const flow = createSilverMarketplaceFlow({ pool,
    auth: { me: async () => ({ status: 200, body: { id: accountId } }) },
    marketReader: reader,
    silverReader: { listOwnedBoxes: async () => [], listOwnedRings: async () => [] },
    marketProgramId, silverProgramId });
  const buyRequest = { operationId, action: 'BUY', mintAddress };
  const buy = (await flow.review('token', buyRequest)).body;
  assert.equal(buy.terms.buyerDebitLamports, '106');
  assert.equal(buy.terms.destinationTokenAddress, buy.candidate.destination);
  listing.priceLamports = '101';
  listing.royaltyLamports = '5';
  listing.platformLamports = '3';
  listing.buyerDebitLamports = '109';
  await assert.rejects(flow.refresh('token', { approved: buy }), /unavailable/);
  listing.sourceReady = false;
  await assert.rejects(flow.review('token', buyRequest), /unavailable/);
  listing.sourceReady = true;
  currentWallet = seller;
  const cancel = (await flow.review('token', { ...buyRequest,
    action: 'CANCEL' })).body;
  assert.equal(cancel.terms.nonce, '3');
  listing.state = 'SOLD';
  await assert.rejects(flow.refresh('token', { approved: cancel }), /unavailable/);
});
