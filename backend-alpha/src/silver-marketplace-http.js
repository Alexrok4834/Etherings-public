const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Read-only, account-session-scoped projection. Listing status is finalized
// chain state; this route does not issue signable intents or settle a sale.
export function createSilverMarketplaceHttp({ auth, reader, silverReader = null,
  silverProgramId = null, flow = null }) {
  if (typeof auth?.me !== 'function' ||
      typeof reader?.readListing !== 'function')
    throw new Error('Marketplace HTTP unavailable');
  const presented = async listings => {
    if (!silverReader || !silverProgramId) return listings;
    const bySeller = new Map();
    const result = [];
    for (const listing of listings) {
      if (listing.state !== 'ACTIVE' || !listing.sourceReady) continue;
      if (!bySeller.has(listing.sellerAddress)) {
        const options = { programId: silverProgramId, cluster: 'devnet',
          walletAddress: listing.sellerAddress };
        bySeller.set(listing.sellerAddress, [
          ...await silverReader.listOwnedBoxes(options),
          ...await silverReader.listOwnedRings(options),
        ]);
      }
      const asset = bySeller.get(listing.sellerAddress).find(item =>
        item.mintAddress === listing.mintAddress && item.kind === listing.kind &&
        item.tokenOwner === listing.sellerAddress && item.finalized === true &&
        item.serial && item.uri && item.contentHash);
      if (asset) result.push({ ...listing, asset: listing.kind === 'SILVER_BOX' ? {
        kind: asset.kind, mintAddress: asset.mintAddress, issuanceId: asset.issuanceId,
        serial: asset.serial, lifecycle: asset.lifecycle,
        cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
        uri: asset.uri, contentHash: asset.contentHash,
      } : {
        kind: asset.kind, mintAddress: asset.mintAddress, boxMint: asset.boxMint,
        designId: asset.designId, serial: asset.serial, uri: asset.uri,
        contentHash: asset.contentHash, level: asset.level, shine: asset.shine,
        unspentPoints: asset.unspentPoints, comfort: asset.comfort,
        charm: asset.charm, quality: asset.quality, luck: asset.luck,
        lastDirectTransferSlot: asset.lastDirectTransferSlot,
        cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
      } });
    }
    return result;
  };
  return {
    async listings(token) {
      const session = await auth.me(token);
      if (session.status !== 200) return session;
      return { status: 200, body: { listings: await presented(await reader.listActive()) } };
    },
    async listing(token, mint) {
      if (!MINT.test(mint ?? ''))
        return { status: 400, body: { code: 'MARKETPLACE_MINT_INVALID' } };
      const session = await auth.me(token);
      if (session.status !== 200) return session;
      const listing = await reader.readListing(mint);
      return listing ? { status: 200, body: { listing: listing.state === 'ACTIVE' &&
        listing.sourceReady ? (await presented([listing]))[0] ?? listing : listing } } :
        { status: 404, body: { code: 'MARKETPLACE_LISTING_NOT_FOUND' } };
    },
    review: (token, body) => flow?.review(token, body) ??
      { status: 404, body: { code: 'MARKETPLACE_DISABLED' } },
    refresh: (token, body) => flow?.refresh(token, body) ??
      { status: 404, body: { code: 'MARKETPLACE_DISABLED' } },
    submit: (token, body) => flow?.submit(token, body) ??
      { status: 404, body: { code: 'MARKETPLACE_DISABLED' } },
    status: (token, body) => flow?.status(token, body?.operationId) ??
      { status: 404, body: { code: 'MARKETPLACE_DISABLED' } },
  };
}
