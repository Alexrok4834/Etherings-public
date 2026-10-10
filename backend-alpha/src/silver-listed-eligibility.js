// Marketplace's canonical reader validates M/config/listing PDA against the
// authoritative Devnet RPC. A stale ACTIVE listing is still a gameplay lock;
// only finalized CANCEL/SOLD removes it.
export async function silverRingIsListed(marketReader, mintAddress) {
  if (!marketReader) return false;
  const listing = await marketReader.readListing(mintAddress);
  if (!listing) return false;
  if (listing.mintAddress !== mintAddress || listing.kind !== 'SILVER_RING' ||
      !['ACTIVE', 'CANCELLED', 'SOLD'].includes(listing.state))
    throw new Error('Silver Marketplace listing state unavailable');
  return listing.state === 'ACTIVE';
}
