import { timeDisplay } from './display-timing.js';
// Only display reads share work. Opening/preflight and transaction readers keep
// the original service, and no completed response is retained.
export function createInventoryDisplay({ auth, wallet, silver, marketplace, displaySilver = silver }) {
  const pending = new Map();
  const pendingListings = new Map();
  async function share(map, key, read) {
    if (map.has(key)) return structuredClone(await timeDisplay('shared_wait', () => map.get(key)));
    if (map.size >= 64) return read();
    const task = Promise.resolve().then(read);
    map.set(key, task);
    try { return structuredClone(await task); }
    finally { if (map.get(key) === task) map.delete(key); }
  }
  async function read(token, key, includeListings) {
    const inventoryTask = share(pending, key, () => timeDisplay('inventory', () => displaySilver.inventory(token)));
    if (!includeListings) return inventoryTask;
    const listingTask = marketplace ? share(pendingListings, key, () => timeDisplay('listings', () => marketplace.myListingMints(token)))
      .then(result => result.status === 200 ? result.body.listings : null)
      .catch(() => null) : Promise.resolve(null);
    const [inventory, listings] = await Promise.all([inventoryTask, listingTask]);
    if (inventory.status !== 200) return inventory;
    let listedMints = [];
    let listingStatusAvailable = Array.isArray(listings);
    if (listingStatusAvailable) {
      const seen = new Set();
      for (const listing of listings) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(listing?.mintAddress ?? '') ||
            !['SILVER_BOX', 'SILVER_RING'].includes(listing.kind) ||
            seen.has(listing.mintAddress)) {
          listingStatusAvailable = false;
          break;
        }
        seen.add(listing.mintAddress);
      }
      if (listingStatusAvailable) listedMints = [...seen];
    }
    return { ...inventory, body: { ...inventory.body,
      listedMints, listingStatusAvailable } };
  }
  return { ...silver, async inventory(token, includeListings = false) {
    // Every caller is authenticated even when it joins an existing read.
    const account = await timeDisplay('auth', () => auth.me(token));
    if (account.status !== 200) return account;
    const binding = await timeDisplay('binding', () => wallet.current(token));
    if (binding.status !== 200) return binding;
    if (!binding.body.walletAddress) return displaySilver.inventory(token);
    const key = JSON.stringify([account.body.id, binding.body.environment,
      binding.body.walletAddress]);
    return read(token, key, includeListings);
  } };
}
