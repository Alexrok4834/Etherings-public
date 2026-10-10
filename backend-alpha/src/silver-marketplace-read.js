import { createHash } from 'node:crypto';
import { address, createSolanaRpc, getAddressDecoder, getAddressEncoder,
  getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { exactSilverSaleLegs } from './silver-marketplace-intent.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const VAULT = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
const MAGIC = Buffer.from('ERSMKV1\0');
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const DEPLOYED_IMAGES = new Map([
  ['BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j',
    { size: 227728, sha256: 'faf30eacdafba4bfb6c5b56c4be69f1d68c031e04d431a94fd4a39c3f84ebf60' }],
  ['3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX',
    { size: 517600, sha256: '5583751abc6282941462c8746408078ebef3c13993dddf203bce924462bc1e6f' }],
]);
const encode = value => getAddressEncoder().encode(address(value));
const decode = value => getAddressDecoder().decode(value);
const seed = value => new TextEncoder().encode(value);

// This is a finalized-chain projection, never a substitute for Marketplace's
// atomic validation at LIST/BUY. In particular, a stale delegated source is
// not offered as purchasable simply because its listing PDA is still ACTIVE.
export function createSilverMarketplaceReader({ rpcUrl, discoveryRpcUrl,
  marketProgramId, silverProgramId, expectedGenesisHash = DEVNET_GENESIS,
  rpc = createSolanaRpc(rpcUrl), discoveryRpc = discoveryRpcUrl &&
    createSolanaRpc(discoveryRpcUrl) }) {
  if (!rpcUrl || marketProgramId === silverProgramId) throw new Error('Invalid marketplace reader');
  const market = address(marketProgramId);
  const silver = address(silverProgramId);
  const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
    programAddress: program, seeds,
  }))[0];
  const read = async key => (await rpc.getAccountInfo(address(key), {
    encoding: 'base64', commitment: 'finalized',
  }).send()).value;
  const bytes = account => account && Buffer.from(account.data[0], 'base64');
  const chain = async () => {
    if (await rpc.getGenesisHash().send() !== expectedGenesisHash)
      throw new Error('Marketplace reader genesis mismatch');
  };

  return {
    async verifyPinnedPrograms() {
      await chain();
      for (const programId of [market, silver]) {
        const expected = DEPLOYED_IMAGES.get(programId);
        if (!expected) throw new Error('Unpinned Marketplace program');
        const dataKey = await pda(address(LOADER), encode(programId));
        const [program, data] = await Promise.all([read(programId), read(dataKey)]);
        const programBytes = bytes(program), dataBytes = bytes(data);
        if (program?.owner !== LOADER || !program.executable ||
            programBytes?.length !== 36 || programBytes.readUInt32LE(0) !== 2 ||
            decode(programBytes.subarray(4, 36)) !== dataKey ||
            data?.owner !== LOADER || dataBytes?.length < 45 + expected.size ||
            dataBytes.readUInt32LE(0) !== 3 || dataBytes[12] !== 1 ||
            decode(dataBytes.subarray(13, 45)) !== VAULT ||
            createHash('sha256').update(dataBytes.subarray(45, 45 + expected.size))
              .digest('hex') !== expected.sha256 ||
            dataBytes.subarray(45 + expected.size).some(value => value !== 0))
          throw new Error('Marketplace deployed image/authority mismatch');
      }
    },
    async listActive() {
      await chain();
      if (!discoveryRpc ||
          await discoveryRpc.getGenesisHash().send() !== expectedGenesisHash)
        throw new Error('Marketplace discovery RPC genesis mismatch');
      const entries = await discoveryRpc.getProgramAccounts(market, {
        encoding: 'base64', commitment: 'finalized',
        filters: [{ dataSize: 320 }],
      }).send();
      if (entries.length > 100) throw new Error('Marketplace listing page required');
      const listings = [];
      for (const entry of entries) {
        const raw = bytes(entry.account);
        if (entry.account.owner !== market || raw?.length !== 320 ||
            !raw.subarray(0, 8).equals(MAGIC) || raw[9] !== 1) continue;
        const listing = await this.readListing(decode(raw.subarray(16, 48)));
        if (listing?.address === entry.pubkey && listing.sourceReady)
          listings.push(listing);
      }
      return listings;
    },
    async readOwnedSource(walletAddress, mintAddress) {
      await chain();
      const owned = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { mint: address(mintAddress) },
        { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      const matches = owned.filter(({ account }) =>
        account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        account.data.parsed?.info?.owner === walletAddress &&
        account.data.parsed.info.mint === mintAddress &&
        account.data.parsed.info.tokenAmount?.amount === '1' &&
        !account.data.parsed.info.delegate);
      return matches.length === 1 ? matches[0].pubkey : null;
    },
    async latestBlockhash() {
      await chain();
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash,
        lastValidBlockHeight: Number(value.lastValidBlockHeight) };
    },
    async isBlockhashValid(blockhash) {
      await chain();
      return (await rpc.isBlockhashValid(address(blockhash),
        { commitment: 'confirmed' }).send()).value;
    },
    async simulate(rawBase64) {
      await chain();
      return (await rpc.simulateTransaction(rawBase64, {
        encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false,
        commitment: 'confirmed',
      }).send()).value;
    },
    async send(rawBase64) {
      await chain();
      return rpc.sendTransaction(rawBase64, {
        encoding: 'base64', skipPreflight: false,
        preflightCommitment: 'confirmed',
      }).send();
    },
    async finalizedTransaction(signature) {
      await chain();
      return rpc.getTransaction(signature, { encoding: 'base64',
        commitment: 'finalized', maxSupportedTransactionVersion: 0 }).send();
    },
    async readConfig() {
      await chain();
      const key = await pda(market, seed('silver-market-config'));
      const account = await read(key);
      const raw = bytes(account);
      if (account?.owner !== market || raw?.length !== 137 || raw[0] !== 1 ||
          decode(raw.subarray(1, 33)) !== VAULT || raw.readBigUInt64LE(33) === 0n ||
          decode(raw.subarray(105, 137)) !== silver ||
          raw.subarray(41, 73).equals(Buffer.alloc(32)) ||
          raw.subarray(73, 105).equals(Buffer.alloc(32)))
        throw new Error('Marketplace config mismatch');
      return { address: key, version: raw.readBigUInt64LE(33).toString(),
        royaltyAddress: decode(raw.subarray(41, 73)),
        platformAddress: decode(raw.subarray(73, 105)) };
    },
    async readListing(mintAddress) {
      await chain();
      await this.readConfig();
      const mint = address(mintAddress);
      const key = await pda(market, seed('silver-market-listing'), encode(mint));
      const account = await read(key);
      if (!account) return null;
      const raw = bytes(account);
      if (account.owner !== market || raw?.length !== 320 ||
          !raw.subarray(0, 8).equals(MAGIC) || raw[8] !== 1 ||
          ![1, 3, 4].includes(raw[9]) || ![1, 2].includes(raw[10]) ||
          !raw.subarray(11, 16).equals(Buffer.alloc(5)) ||
          decode(raw.subarray(16, 48)) !== mint ||
          raw.readBigUInt64LE(120) === 0n || raw.readBigUInt64LE(192) === 0n ||
          decode(raw.subarray(272, 304)) !== silver ||
          !raw.subarray(304).equals(Buffer.alloc(16)))
        throw new Error('Marketplace listing mismatch');
      const kind = raw[10] === 2 ? 'SILVER_RING' : 'SILVER_BOX';
      const seller = decode(raw.subarray(48, 80));
      const source = decode(raw.subarray(80, 112));
      const price = raw.readBigUInt64LE(112);
      const legs = exactSilverSaleLegs(price);
      const nonce = raw.readBigUInt64LE(192);
      const stateKey = await pda(silver, seed(kind === 'SILVER_RING'
        ? 'silver-ring-state' : 'silver-state'), encode(mint));
      const [state, token, lifecycle] = await Promise.all([
        read(stateKey),
        rpc.getAccountInfo(address(source), { encoding: 'jsonParsed',
          commitment: 'finalized' }).send().then(result => result.value),
        kind === 'SILVER_BOX'
          ? pda(silver, seed('silver-lifecycle'), encode(mint)).then(read) : null,
      ]);
      const stateBytes = bytes(state);
      const stateMatches = state?.owner === silver &&
        (kind === 'SILVER_RING' ? stateBytes?.length === 576 &&
          stateBytes.subarray(0, 8).equals(Buffer.from('ERSRGV1\0')) &&
          decode(stateBytes.subarray(16, 48)) === mint :
          stateBytes?.length === 204 &&
          stateBytes.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1])) &&
          decode(stateBytes.subarray(36, 68)) === mint);
      const lifecycleBytes = bytes(lifecycle);
      const sealed = kind === 'SILVER_RING' ||
        (lifecycle?.owner === silver && lifecycleBytes?.length === 128 &&
          lifecycleBytes.subarray(0, 8).equals(Buffer.from('ERSBLV1\0')) &&
          lifecycleBytes[8] === 1 && lifecycleBytes[9] === 0 &&
          decode(lifecycleBytes.subarray(16, 48)) === mint);
      const cooldown = stateMatches ? (kind === 'SILVER_RING'
        ? stateBytes.readBigInt64LE(328) : stateBytes.readBigInt64LE(196)) : 0n;
      const sourceInfo = token?.data?.parsed?.info;
      const sourceMatches = token?.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        sourceInfo?.mint === mint && sourceInfo.owner === seller &&
        sourceInfo.tokenAmount?.amount === '1' &&
        sourceInfo.delegate === await pda(market, seed('silver-market-authority')) &&
        sourceInfo.delegatedAmount?.amount === '1';
      return { address: key, mintAddress: mint, kind, sellerAddress: seller,
        sourceTokenAddress: source, state: raw[9] === 1 ? 'ACTIVE' :
          raw[9] === 3 ? 'SOLD' : 'CANCELLED',
        // This indicates an apparently live source, not signed BUY eligibility.
        // The refreshed exact BUY must still be simulated before approval.
        sourceReady: raw[9] === 1 && stateMatches && sealed && sourceMatches &&
          cooldown <= BigInt(Math.floor(Date.now() / 1000)),
        nonce: nonce.toString(), configVersion: raw.readBigUInt64LE(120).toString(),
        royaltyAddress: decode(raw.subarray(128, 160)),
        platformAddress: decode(raw.subarray(160, 192)),
        priceLamports: price.toString(), royaltyLamports: legs.royalty.toString(),
        platformLamports: legs.platform.toString(),
        buyerDebitLamports: legs.total.toString(),
        buyerAddress: raw[9] === 3 ? decode(raw.subarray(200, 232)) : null,
        destinationTokenAddress: raw[9] === 3 ? decode(raw.subarray(232, 264)) : null,
        finalizedSlot: raw.readBigUInt64LE(264).toString() };
    },
  };
}
