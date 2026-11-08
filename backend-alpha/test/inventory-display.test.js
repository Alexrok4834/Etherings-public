import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInventoryDisplay } from '../src/inventory-display.js';

test('Home shares inventory with Rings without waiting for listing work', async () => {
  let inventoryReads = 0, listingReads = 0, releaseInventory, releaseListings;
  const inventoryGate = new Promise(resolve => { releaseInventory = resolve; });
  const listingsGate = new Promise(resolve => { releaseListings = resolve; });
  const service = createInventoryDisplay({
    auth: { async me() { return { status: 200, body: { id: 'a' } }; } },
    wallet: { async current() { return { status: 200, body: { walletAddress: 'w' } }; } },
    silver: { async inventory() { inventoryReads++; await inventoryGate;
      return { status: 200, body: { assets: [] } }; } },
    marketplace: { async myListingMints() { listingReads++; await listingsGate;
      return { status: 200, body: { listings: [] } }; } },
  });
  const home = service.inventory('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listingReads, 0);
  const rings = service.inventory('a', true), secondRings = service.inventory('a', true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inventoryReads, 1);
  assert.equal(listingReads, 1);
  releaseInventory();
  assert.deepEqual((await home).body, { assets: [] });
  releaseListings();
  assert.equal((await rings).body.listingStatusAvailable, true);
  assert.deepEqual(await secondRings, await rings);
});

test('concurrent display reads share work, authenticate each caller and retain no completed cache', async () => {
  let reads = 0, authentications = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const silver = { async inventory() { reads++; await pending;
    return { status: 200, body: { assets: [] } }; } };
  const service = createInventoryDisplay({ silver,
    auth: { async me(token) { authentications++;
      return token === 'denied' ? { status: 401 } : { status: 200, body: { id: token } }; } },
    wallet: { async current() { return { status: 200,
      body: { walletAddress: 'wallet', environment: 'test' } }; } },
    marketplace: { async myListingMints() { return { status: 200, body: { listings: [] } }; } },
  });
  const first = service.inventory('a'), second = service.inventory('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(authentications, 2);
  assert.equal((await service.inventory('denied')).status, 401);
  const other = service.inventory('b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  release();
  const [a, b] = await Promise.all([first, second, other]);
  assert.deepEqual(a, b);
  a.body.assets.push('changed');
  assert.deepEqual(b.body.assets, []);
  await service.inventory('a');
  assert.equal(reads, 3);
});

test('failed inventory is retried; unavailable listing status is explicit', async () => {
  let fail = true;
  const service = createInventoryDisplay({
    auth: { async me() { return { status: 200, body: { id: 'a' } }; } },
    wallet: { async current() { return { status: 200, body: { walletAddress: 'w' } }; } },
    silver: { async inventory() { if (fail) throw new Error('RPC unavailable');
      return { status: 200, body: { assets: [] } }; } },
    marketplace: { async myListingMints() { throw new Error('Listing unavailable'); } },
  });
  await assert.rejects(service.inventory('a'), /RPC unavailable/);
  fail = false;
  assert.deepEqual((await service.inventory('a', true)).body,
    { assets: [], listedMints: [], listingStatusAvailable: false });
});
