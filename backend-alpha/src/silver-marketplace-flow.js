import { createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { buildSilverMarketplaceBuyMessage, buildSilverMarketplaceCancelMessage,
  buildSilverMarketplaceListMessage, exactSilverSaleLegs } from './silver-marketplace-intent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const unavailable = () => new Error('Silver marketplace unavailable');
const listingCooldown = until => Object.assign(new Error('Silver listing cooldown active'), {
  code: 'MARKETPLACE_LISTING_COOLDOWN', cooldownUntilUnixSeconds: until,
});
const same = (left, right) => isDeepStrictEqual(left, right);
const signatureBytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw unavailable();
  return bytes;
};

export function createSilverMarketplaceFlow({ pool, auth, marketReader, silverReader,
  equipment = null, marketProgramId, silverProgramId }) {
  if (typeof pool?.connect !== 'function' || typeof auth?.me !== 'function' ||
      ['verifyPinnedPrograms', 'readConfig', 'readListing', 'readOwnedSource', 'latestBlockhash',
        'isBlockhashValid', 'simulate', 'send', 'finalizedTransaction']
        .some(name => typeof marketReader?.[name] !== 'function') ||
      ['listOwnedBoxes', 'listOwnedRings'].some(name =>
        typeof silverReader?.[name] !== 'function')) throw unavailable();
  const owner = async token => {
    const session = await auth.me(token);
    if (session.status !== 200) return { failure: session };
    const wallet = (await pool.query(`SELECT wallet_address FROM alpha_wallet_bindings
      WHERE account_id = $1`, [session.body.id])).rows[0]?.wallet_address;
    if (!wallet) throw unavailable();
    return { accountId: session.body.id, wallet };
  };
  const checkRequest = request => {
    if (!request || !UUID.test(request.operationId ?? '') ||
        !MINT.test(request.mintAddress ?? '') ||
        !['LIST', 'CANCEL', 'BUY'].includes(request.action) ||
        !same(Object.keys(request).sort(), (request.action === 'LIST' ?
          ['action', 'mintAddress', 'operationId', 'priceLamports'] :
          ['action', 'mintAddress', 'operationId']).sort()) ||
        (request.action === 'LIST' ?
          !/^[1-9][0-9]*$/.test(request.priceLamports ?? '') :
          request.priceLamports !== undefined)) throw unavailable();
    if (request.action === 'LIST') exactSilverSaleLegs(request.priceLamports);
  };
  const reviewFor = async (bound, request, lifetime = null) => {
    checkRequest(request);
    await marketReader.verifyPinnedPrograms();
    const config = await marketReader.readConfig();
    const listing = await marketReader.readListing(request.mintAddress);
    const nextNonce = listing ? BigInt(listing.nonce) + 1n : 1n;
    const nonce = request.action === 'LIST' ? nextNonce : BigInt(listing?.nonce ?? '0');
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
    const block = lifetime ?? await marketReader.latestBlockhash();
    let terms, candidate;
    if (request.action === 'LIST') {
      if (listing?.state === 'ACTIVE') throw unavailable();
      const options = { programId: silverProgramId, cluster: 'devnet',
        walletAddress: bound.wallet };
      const [boxes, rings] = await Promise.all([
        silverReader.listOwnedBoxes(options), silverReader.listOwnedRings(options),
      ]);
      const assets = [...boxes, ...rings];
      const asset = assets.find(item => item.mintAddress === request.mintAddress &&
        item.tokenOwner === bound.wallet &&
        ['SILVER_BOX', 'SILVER_RING'].includes(item.kind));
      if (!asset) throw unavailable();
      const cooldownUntil = BigInt(asset.cooldownUntilUnixSeconds);
      if (cooldownUntil > BigInt(Math.floor(Date.now() / 1000)))
        throw listingCooldown(cooldownUntil.toString());
      const source = await marketReader.readOwnedSource(bound.wallet, request.mintAddress);
      if (!source) throw unavailable();
      const legs = exactSilverSaleLegs(request.priceLamports);
      candidate = await buildSilverMarketplaceListMessage({
        marketProgramId, silverProgramId, mintAddress: request.mintAddress,
        kind: asset.kind, sellerAddress: bound.wallet, sourceTokenAddress: source,
        priceLamports: request.priceLamports, nonce: Number(nonce), ...block });
      terms = { action: 'LIST', mintAddress: request.mintAddress, kind: asset.kind,
        sellerAddress: bound.wallet, sourceTokenAddress: source,
        listingAddress: candidate.listing, nonce: nonce.toString(),
        configVersion: config.version, royaltyAddress: config.royaltyAddress,
        platformAddress: config.platformAddress,
        priceLamports: legs.price.toString(), royaltyLamports: legs.royalty.toString(),
        platformLamports: legs.platform.toString(), buyerDebitLamports: legs.total.toString() };
    } else if (request.action === 'CANCEL') {
      if (listing?.state !== 'ACTIVE' || listing.sellerAddress !== bound.wallet)
        throw unavailable();
      candidate = await buildSilverMarketplaceCancelMessage({ marketProgramId,
        mintAddress: request.mintAddress, sellerAddress: bound.wallet,
        sourceTokenAddress: listing.sourceTokenAddress, nonce: Number(nonce), ...block });
      terms = { action: 'CANCEL', mintAddress: request.mintAddress,
        kind: listing.kind, sellerAddress: bound.wallet,
        sourceTokenAddress: listing.sourceTokenAddress,
        listingAddress: candidate.listing, nonce: nonce.toString(),
        configVersion: listing.configVersion, priceLamports: listing.priceLamports };
    } else {
      if (listing?.state !== 'ACTIVE' || !listing.sourceReady ||
          listing.sellerAddress === bound.wallet) throw unavailable();
      candidate = await buildSilverMarketplaceBuyMessage({ marketProgramId,
        silverProgramId, mintAddress: request.mintAddress, kind: listing.kind,
        sellerAddress: listing.sellerAddress,
        sourceTokenAddress: listing.sourceTokenAddress, buyerAddress: bound.wallet,
        royaltyAddress: listing.royaltyAddress,
        platformAddress: listing.platformAddress,
        priceLamports: listing.priceLamports, nonce: Number(nonce),
        createBuyerAta: true, ...block });
      terms = { action: 'BUY', mintAddress: request.mintAddress, kind: listing.kind,
        buyerAddress: bound.wallet, sellerAddress: listing.sellerAddress,
        sourceTokenAddress: listing.sourceTokenAddress,
        destinationTokenAddress: candidate.destination,
        listingAddress: candidate.listing, nonce: nonce.toString(),
        configVersion: listing.configVersion,
        royaltyAddress: listing.royaltyAddress,
        platformAddress: listing.platformAddress,
        priceLamports: listing.priceLamports,
        royaltyLamports: listing.royaltyLamports,
        platformLamports: listing.platformLamports,
        buyerDebitLamports: listing.buyerDebitLamports };
    }
    return { request, terms, candidate: { ...candidate, blockhash: block.blockhash,
      lastValidBlockHeight: block.lastValidBlockHeight,
      walletAddress: bound.wallet, action: request.action,
      mintAddress: request.mintAddress } };
  };
  const ensureNotSubmitted = async (accountId, operationId) => {
    const row = (await pool.query(`SELECT signature FROM alpha_silver_marketplace_submissions
      WHERE account_id = $1 AND operation_id = $2`, [accountId, operationId])).rows[0];
    if (row) throw unavailable();
  };
  return {
    async review(token, request) {
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      checkRequest(request);
      await ensureNotSubmitted(bound.accountId, request.operationId);
      return { status: 200, body: await reviewFor(bound, request) };
    },
    async refresh(token, body) {
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      const approved = body?.approved;
      checkRequest(approved?.request);
      await ensureNotSubmitted(bound.accountId, approved.request.operationId);
      const current = await reviewFor(bound, approved.request);
      if (!same(approved.terms, current.terms) ||
          !same({ ...approved.candidate, messageBase64: null, sizeBytes: null,
            blockhash: null, lastValidBlockHeight: null },
          { ...current.candidate, messageBase64: null, sizeBytes: null,
            blockhash: null, lastValidBlockHeight: null })) throw unavailable();
      return { status: 200, body: current };
    },
    async submit(token, body) {
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      const refreshed = body?.refreshed;
      checkRequest(refreshed?.request);
      const candidate = refreshed?.candidate;
      if (candidate?.walletAddress !== bound.wallet ||
          candidate.action !== refreshed.request.action ||
          candidate.mintAddress !== refreshed.request.mintAddress ||
          !Number.isSafeInteger(candidate.lastValidBlockHeight) ||
          candidate.lastValidBlockHeight < 1) throw unavailable();
      const current = await reviewFor(bound, refreshed.request, {
        blockhash: candidate.blockhash,
        lastValidBlockHeight: candidate.lastValidBlockHeight });
      if (!same(refreshed, current)) throw unavailable();
      const message = Buffer.from(candidate.messageBase64, 'base64');
      const sig = signatureBytes(body.userSignatureBase64);
      const publicKey = Buffer.from(bs58.decode(bound.wallet));
      if (publicKey.length !== 32 || !verify(null, message, createPublicKey({
        key: Buffer.concat([SPKI, publicKey]), format: 'der', type: 'spki',
      }), sig) || !await marketReader.isBlockhashValid(candidate.blockhash))
        throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (decoded.header.numSignerAccounts !== 1 ||
          decoded.staticAccounts[0] !== bound.wallet ||
          decoded.lifetimeToken !== candidate.blockhash) throw unavailable();
      const raw = Buffer.concat([Buffer.from([1]), sig, message]);
      if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
      const simulation = await marketReader.simulate(raw.toString('base64'));
      if (simulation?.err !== null) throw unavailable();
      const signature = bs58.encode(sig);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [bound.accountId])).rows[0];
        const wallet = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
          WHERE account_id = $1`, [bound.accountId])).rows[0]?.wallet_address;
        if (!account || wallet !== bound.wallet) throw unavailable();
        await client.query(`INSERT INTO alpha_silver_marketplace_submissions
          (signature,account_id,operation_id,wallet_address,action,mint_address,
           nonce,terms,message_base64) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
          ON CONFLICT DO NOTHING`, [signature, bound.accountId,
          refreshed.request.operationId, bound.wallet, refreshed.request.action,
          refreshed.request.mintAddress, refreshed.terms.nonce,
          JSON.stringify(refreshed.terms), candidate.messageBase64]);
        const stored = (await client.query(`SELECT * FROM alpha_silver_marketplace_submissions
          WHERE account_id = $1 AND operation_id = $2`,
        [bound.accountId, refreshed.request.operationId])).rows[0];
        if (stored?.signature !== signature || stored.wallet_address !== bound.wallet ||
            stored.action !== refreshed.request.action ||
            stored.mint_address !== refreshed.request.mintAddress ||
            stored.nonce?.toString() !== refreshed.terms.nonce ||
            !same(stored.terms, refreshed.terms) ||
            stored.message_base64 !== candidate.messageBase64) throw unavailable();
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
      try {
        if (await marketReader.send(raw.toString('base64')) !== signature)
          throw unavailable();
      } catch { /* Durable signature remains UNKNOWN until finalized readback. */ }
      return { status: 200, body: { status: 'unknown', signature } };
    },
    async status(token, operationId) {
      if (!UUID.test(operationId ?? '')) throw unavailable();
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      const stored = (await pool.query(`SELECT * FROM alpha_silver_marketplace_submissions
        WHERE account_id = $1 AND operation_id = $2`,
      [bound.accountId, operationId])).rows[0];
      if (!stored) return { status: 200, body: { status: 'not_submitted' } };
      if (stored.wallet_address !== bound.wallet) throw unavailable();
      const transaction = await marketReader.finalizedTransaction(stored.signature);
      if (!transaction) return { status: 200, body: { status: 'unknown',
        signature: stored.signature } };
      if (!transaction.meta || !Object.hasOwn(transaction.meta, 'err'))
        throw unavailable();
      const raw = Buffer.from(transaction.transaction?.[0] ?? '', 'base64');
      if (raw[0] !== 1 || raw.length > 1232 ||
          !raw.subarray(1, 65).equals(Buffer.from(bs58.decode(stored.signature))) ||
          raw.subarray(65).toString('base64') !== stored.message_base64)
        throw unavailable();
      if (transaction.meta.err === null && stored.action === 'LIST' &&
          stored.terms?.kind === 'SILVER_RING' && equipment)
        await equipment.current(token);
      return { status: 200, body: { status: transaction.meta?.err === null ?
        'confirmed' : 'failed', signature: stored.signature,
        action: stored.action, mintAddress: stored.mint_address,
        terms: stored.terms } };
    },
  };
}
