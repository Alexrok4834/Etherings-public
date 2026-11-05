import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilverMarketplaceHttp } from '../src/silver-marketplace-http.js';

test('inventory listing badges are scoped to the authenticated bound wallet', async () => {
  const walletAddress = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  let authenticated = false;
  let reads = 0;
  const http = createSilverMarketplaceHttp({
    auth: { async me() { return authenticated ? { status: 200, body: { id: 'owner' } } :
      { status: 401, body: {} }; } },
    wallet: { async current() { return { status: 200,
      body: { walletAddress } }; } },
    reader: { async readListing() { return null; },
      async listActiveForSeller(seller) {
        assert.equal(seller, walletAddress);
        reads++;
        return [{ mintAddress: walletAddress, kind: 'SILVER_BOX' }];
      } },
  });
  assert.equal((await http.myListingMints('token')).status, 401);
  assert.equal(reads, 0);
  authenticated = true;
  assert.deepEqual((await http.myListingMints('token')).body.listings,
    [{ mintAddress: walletAddress, kind: 'SILVER_BOX' }]);
  assert.equal(reads, 1);
});

test('marketplace listing read stays authenticated and chain-authoritative', async () => {
  const mint = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  let reads = 0;
  const reader = { listActive: async () => [{ state: 'ACTIVE' }],
    async readListing(value) { reads++; assert.equal(value, mint); return { state: 'ACTIVE',
      sourceReady: false, priceLamports: '100' }; } };
  let authenticated = false;
  const auth = { async me() { return authenticated ? { status: 200,
    body: { id: 'account' } } : { status: 401, body: {} }; } };
  const http = createSilverMarketplaceHttp({ auth, reader });
  assert.equal((await http.listing('session', mint)).status, 401);
  assert.equal(reads, 0);
  authenticated = true;
  assert.equal((await http.listing('session', 'invalid')).status, 400);
  assert.equal(reads, 0);
  assert.deepEqual(await http.listing('session', mint), { status: 200,
    body: { listing: { state: 'ACTIVE', sourceReady: false,
      priceLamports: '100' } } });
  assert.equal(reads, 1);
  assert.deepEqual((await http.listings('session')).body,
    { listings: [{ state: 'ACTIVE' }] });
});

test('marketplace presents only verified seller-owned Silver artwork and state', async () => {
  const seller = 'seller', mint = 'ring', programId = 'silver';
  const listing = { state: 'ACTIVE', sourceReady: true, kind: 'SILVER_RING',
    sellerAddress: seller, mintAddress: mint, priceLamports: '100' };
  let owned = true;
  const silverReader = {
    listOwnedBoxes: async () => [],
    listOwnedRings: async () => [{ finalized: true, kind: 'SILVER_RING',
      mintAddress: mint, tokenOwner: owned ? seller : 'other', serial: '4',
      boxMint: 'box', designId: 2, uri: 'ipfs://cid', contentHash: 'hash',
      level: 5, shine: 100, unspentPoints: 0, comfort: 32, charm: 20,
      quality: 18, luck: 14, lastDirectTransferSlot: '0',
      cooldownUntilUnixSeconds: '0' }],
  };
  const http = createSilverMarketplaceHttp({ auth: {
    me: async () => ({ status: 200, body: { id: 'buyer' } }),
  }, reader: { listActive: async () => [listing], readListing: async () => listing },
  silverReader, silverProgramId: programId });
  const result = (await http.listings('session')).body.listings;
  assert.equal(result.length, 1);
  assert.equal(result[0].asset.serial, '4');
  assert.equal(result[0].asset.level, 5);
  assert.equal(result[0].asset.uri, 'ipfs://cid');
  owned = false;
  assert.deepEqual((await http.listings('session')).body.listings, []);
});

test('marketplace shares one verified owner snapshot per seller', async () => {
  const seller = 'seller';
  let reads = 0;
  const listings = ['ring-a', 'ring-b'].map(mintAddress => ({ state: 'ACTIVE',
    sourceReady: true, kind: 'SILVER_RING', sellerAddress: seller, mintAddress }));
  const silverReader = { async listOwnedAssets(options) {
    assert.equal(options.walletAddress, seller);
    reads++;
    return [[], listings.map(({ mintAddress }) => ({ finalized: true,
      kind: 'SILVER_RING', mintAddress, tokenOwner: seller, serial: '1',
      uri: 'ipfs://cid', contentHash: 'hash' }))];
  } };
  const http = createSilverMarketplaceHttp({ auth: {
    me: async () => ({ status: 200 }),
  }, reader: { listActive: async () => listings, readListing: async () => null },
  silverReader, silverProgramId: 'silver' });
  const result = await http.listings('session');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.listings.map(item => item.mintAddress), ['ring-a', 'ring-b']);
  assert.equal(reads, 1);
});
