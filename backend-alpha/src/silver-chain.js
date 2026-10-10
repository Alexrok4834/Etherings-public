import { createHash } from 'node:crypto';
import { address, createSolanaRpc, getAddressDecoder, getAddressEncoder, getBase64Decoder,
  getProgramDerivedAddress } from '@solana/kit';
import { getExtraAccountMetasDecoder, getMintDecoder, getTokenDecoder,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { retryableRpcFailure } from './read-only-rpc-route.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const ORAO_CLASSIC = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';
const MARKET = 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j';
const LIFECYCLE_MAGIC = Buffer.from('455253424c563100', 'hex');
const SERIES_MAGIC = Buffer.from('ERSERV1\0');
const SERIES_MARKER = 'ETHERINGS_NFT_V1';
const MAX_U64 = 0xffffffffffffffffn;
const validSilverProgressionState = ring => {
  const level = ring[290];
  if (level < 1 || level > 20 || ring[291] !== 100) return false;
  const earned = 6 * (level - 1);
  const unspent = ring.readUInt32LE(292);
  const attributes = [...ring.subarray(286, 290)];
  const initialTotal = ring[299];
  const currentTotal = attributes.reduce((sum, value) => sum + value, unspent);
  return unspent <= earned &&
    attributes.every(value => value >= 10 && value <= 30 + earned) &&
    (level === 1 ? initialTotal === 0 && currentTotal >= 40 && currentTotal <= 120 :
      initialTotal >= 40 && initialTotal <= 120 && currentTotal === initialTotal + earned);
};
const seriesSeed = kind => [text('silver-nft-series'), Buffer.from([kind]), Buffer.from([1])];
const serialFromFields = (fields, kind) => {
  const serial = fields?.get('serial');
  if (fields?.get('kind') !== kind || fields.get('rarity') !== 'SILVER' ||
      fields.get('series') !== SERIES_MARKER ||
      typeof serial !== 'string' || !/^[1-9][0-9]{0,19}$/.test(serial) ||
      BigInt(serial) > MAX_U64) return null;
  return serial;
};
export function verifiedSeriesCounter(raw, programId, kind, serial) {
  if (typeof raw?.data?.[0] !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(serial ?? '')) return false;
  const bytes = Buffer.from(raw.data[0], 'base64');
  return raw?.owner === programId && bytes.length === 24 &&
    bytes.subarray(0, 8).equals(SERIES_MAGIC) && bytes[8] === 1 &&
    bytes[9] === kind && bytes[10] === 1 &&
    bytes.subarray(11, 16).every(byte => byte === 0) &&
    BigInt(serial) <= bytes.readBigUInt64LE(16);
}
const decode = (bytes) => getAddressDecoder().decode(bytes);
const encode = (value) => getAddressEncoder().encode(address(value));
const text = (value) => new TextEncoder().encode(value);
// Keep independent finalized reads bounded and return results in token-account order.
async function mapOwnedAssets(owned, read) {
  const results = [];
  for (let offset = 0; offset < owned.length; offset += 3) {
    results.push(...await Promise.all(owned.slice(offset, offset + 3).map(read)));
  }
  return results.filter(Boolean);
}
const matchesPdaMeta = (meta, seed, kind = 'ProgramPda', accountIndex) =>
  meta?.config?.__kind === kind &&
  (accountIndex === undefined || meta.config.accountIndex === accountIndex) &&
  meta.isSigner === false && meta.isWritable === true && meta.config.seeds?.length === 2 &&
  meta.config.seeds[0]?.__kind === 'Literal' &&
  Buffer.from(meta.config.seeds[0].bytes).equals(text(seed)) &&
  meta.config.seeds[1]?.__kind === 'AccountKey' && meta.config.seeds[1].index === 1;
const canonicalMetaVersion = (bytes) => {
  try {
    const metas = getExtraAccountMetasDecoder().decode(bytes);
    if (!matchesPdaMeta(metas[0], 'silver-state') ||
        !matchesPdaMeta(metas[1], 'silver-lifecycle')) return 0;
    if (metas.length === 2) return { version: 2 };
    if (metas.length === 4 && metas[2]?.config?.__kind === 'Literal' &&
        metas[2].isSigner === false && metas[2].isWritable === false &&
        metas[2].config.address === MARKET &&
        matchesPdaMeta(metas[3], 'silver-market-listing', 'AccountPda', 7))
      return { version: 4, marketProgramId: metas[2].config.address };
    return 0;
  } catch { return 0; }
};
const canonicalRingMetaVersion = bytes => {
  try {
    const metas = getExtraAccountMetasDecoder().decode(bytes);
    if (!matchesPdaMeta(metas[0], 'silver-ring-state')) return 0;
    if (metas.length === 1) return 1;
    return metas.length === 3 && metas[1]?.config?.__kind === 'Literal' &&
      metas[1].config.address === MARKET && !metas[1].isSigner &&
      !metas[1].isWritable &&
      matchesPdaMeta(metas[2], 'silver-market-listing', 'AccountPda', 6) ? 3 : 0;
  } catch { return 0; }
};
export function verifiedSilverDirectTransferEam(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || !['SILVER_BOX', 'SILVER_RING'].includes(kind) ||
      bytes.length < 12 ||
      !bytes.subarray(0, 8).equals(Buffer.from('692565c54bfb661a', 'hex')) ||
      bytes.readUInt32LE(8) !== bytes.length - 12) return null;
  const version = kind === 'SILVER_BOX' ? canonicalMetaVersion(bytes) :
    canonicalRingMetaVersion(bytes);
  return version ? { version: typeof version === 'number' ? version : version.version,
    marketAware: kind === 'SILVER_BOX' ? version.version === 4 : version === 3 } : null;
}
const uuid = (bytes) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function verifiedBoxMedia(mint, mintAddress, issuanceId, collectionId,
  { allowSpent = false } = {}) {
  const extensions = mint?.extensions?.__option === 'Some' ? mint.extensions.value : [];
  const metadata = extensions.find(ext => ext.__kind === 'TokenMetadata');
  const pointer = extensions.find(ext => ext.__kind === 'MetadataPointer');
  const fields = metadata && new Map(metadata.additionalMetadata);
  const contentHash = fields?.get('content_hash');
  const serial = serialFromFields(fields, 'SILVER_BOX');
  if (!(mint?.supply === 1n || (allowSpent && mint?.supply === 0n)) ||
      mint.decimals !== 0 ||
      pointer?.metadataAddress?.value !== mintAddress ||
      pointer.authority.__option !== 'None' || metadata?.mint !== mintAddress ||
      fields.get('kind') !== 'SILVER_BOX' ||
      fields.get('issuance_id') !== issuanceId ||
      fields.get('collection') !== collectionId ||
      typeof metadata.uri !== 'string' || metadata.uri.length > 200 ||
      !/^[a-f0-9]{64}$/.test(contentHash ?? '') || !serial) return {};
  return { uri: metadata.uri, contentHash, serial };
}

export function verifiedBoxProvenance(mint) {
  const extensions = mint?.extensions?.__option === 'Some' ? mint.extensions.value : [];
  const metadata = extensions.find(ext => ext.__kind === 'TokenMetadata');
  const fields = new Map(metadata?.additionalMetadata ?? []);
  const source = fields.get('issuance_source');
  const resultId = fields.get('draw_result_id');
  const adminOperationId = fields.get('admin_operation_id');
  const breedingOperationId = fields.get('breeding_operation_id');
  const breedingFirstParent = fields.get('breeding_first_parent');
  const breedingSecondParent = fields.get('breeding_second_parent');
  const breedingFirstUses = fields.get('breeding_first_uses');
  const breedingSecondUses = fields.get('breeding_second_uses');
  const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value ?? '');
  const digest = fields.get('entitlement_digest');
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') ||
      !((source === 'first-entry' && resultId === undefined && adminOperationId === undefined) ||
        (source === 'draw' && validUuid(resultId) && adminOperationId === undefined) ||
        (source === 'admin-grant' && resultId === undefined &&
          validUuid(adminOperationId)) ||
        (source === 'cooper-breeding' && resultId === undefined &&
          adminOperationId === undefined &&
          validUuid(breedingOperationId) && validUuid(breedingFirstParent) &&
          validUuid(breedingSecondParent) &&
          breedingFirstParent !== breedingSecondParent &&
          /^[01]$/.test(breedingFirstUses ?? '') &&
          /^[01]$/.test(breedingSecondUses ?? ''))))
    return null;
  return { issuanceSource: source, entitlementDigest: digest,
    drawResultId: resultId ?? null,
    adminOperationId: adminOperationId ?? null,
    ...(source === 'cooper-breeding' ? { breedingOperationId,
      breedingFirstParent, breedingSecondParent,
      breedingFirstUses: Number(breedingFirstUses),
      breedingSecondUses: Number(breedingSecondUses) } : {}) };
}

export function createSilverChainReader(rpcUrl, {
  expectedCluster = 'devnet', expectedGenesisHash = DEVNET_GENESIS,
  propagateTransientReadErrors = false,
  rpc = null,
} = {}) {
  if (!rpcUrl) throw new Error('Silver chain reader requires Devnet RPC');
  if (!['devnet', 'local-validator'].includes(expectedCluster) || !expectedGenesisHash) {
    throw new Error('Silver chain reader requires exact cluster identity');
  }
  rpc ??= createSolanaRpc(rpcUrl);
  const inventorySnapshotMarker = Symbol('verified Silver inventory snapshot');
  return {
    async readIssuedBreedingBox({ programId, cluster, issuanceId, accountId,
      walletAddress, operationId, firstRingId, secondRingId, firstUses,
      secondUses, entitlementDigest, issuanceSlot }) {
      if (cluster !== expectedCluster ||
          !/^[a-f0-9]{64}$/.test(issuanceId ?? '') ||
          await rpc.getGenesisHash().send() !== expectedGenesisHash) return null;
      try {
        const [mint] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-mint'), Buffer.from(issuanceId, 'hex')] });
        const [state] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-state'), encode(mint)] });
        const [collection] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-collection')] });
        const [series] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: seriesSeed(1) });
        const [rawState, rawMint, rawSeries] = await Promise.all([state, mint, series].map(key =>
          rpc.getAccountInfo(address(key), {
            encoding: 'base64', commitment: 'finalized',
          }).send().then(result => result.value)));
        if (rawState?.owner !== programId ||
            rawMint?.owner !== TOKEN_2022_PROGRAM_ADDRESS) return null;
        const bytes = Buffer.from(rawState.data[0], 'base64');
        if (bytes.length !== 204 || !bytes.subarray(0, 4)
          .equals(Buffer.from([3, 1, 1, 1])) ||
            bytes.subarray(4, 36).toString('hex') !== issuanceId ||
            decode(bytes.subarray(36, 68)) !== mint ||
            decode(bytes.subarray(68, 100)) !== collection ||
            decode(bytes.subarray(100, 132)) !== walletAddress ||
            bytes.subarray(132, 164).toString('hex') !== entitlementDigest ||
            uuid(bytes.subarray(164, 180)) !== accountId ||
            bytes.readBigUInt64LE(180).toString() !== String(issuanceSlot)) return null;
        const mintData = getMintDecoder().decode(Buffer.from(rawMint.data[0], 'base64'));
        if (mintData.mintAuthority?.__option !== 'None' ||
            mintData.freezeAuthority?.__option !== 'None') return null;
        const media = verifiedBoxMedia(mintData, mint, issuanceId, collection,
          { allowSpent: true });
        const provenance = verifiedBoxProvenance(mintData);
        if (!media.serial ||
            !verifiedSeriesCounter(rawSeries, programId, 1, media.serial) ||
            provenance?.issuanceSource !== 'cooper-breeding' ||
            provenance.entitlementDigest !== entitlementDigest ||
            provenance.breedingOperationId !== operationId ||
            provenance.breedingFirstParent !== firstRingId ||
            provenance.breedingSecondParent !== secondRingId ||
            provenance.breedingFirstUses !== firstUses ||
            provenance.breedingSecondUses !== secondUses) return null;
        return { mintAddress: mint, issuanceSlot: String(issuanceSlot),
          originalRecipient: walletAddress, accountId, issuanceId,
          entitlementDigest, ...media, ...provenance };
      } catch { return null; }
    },
    async readBoxMedia({ programId, cluster, mintAddress, issuanceId, collectionId,
      includeProvenance = false, snapshot = null }) {
      if (cluster !== expectedCluster ||
          (snapshot?.marker !== inventorySnapshotMarker &&
            await rpc.getGenesisHash().send() !== expectedGenesisHash))
        return {};
      try {
        const raw = (await rpc.getAccountInfo(address(mintAddress), {
          encoding: 'base64', commitment: 'finalized',
        }).send()).value;
        if (raw?.owner !== TOKEN_2022_PROGRAM_ADDRESS) return {};
        const media = verifiedBoxMedia(getMintDecoder().decode(Buffer.from(raw.data[0], 'base64')),
          mintAddress, issuanceId, collectionId);
        if (!media.serial) return {};
        const [series] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: seriesSeed(1) });
        const counter = (await rpc.getAccountInfo(address(series), {
          encoding: 'base64', commitment: 'finalized',
        }).send()).value;
        if (!verifiedSeriesCounter(counter, programId, 1, media.serial)) return {};
        if (!includeProvenance) return media;
        const provenance = verifiedBoxProvenance(
          getMintDecoder().decode(Buffer.from(raw.data[0], 'base64')));
        return provenance ? { ...media, ...provenance } : {};
      } catch (error) {
        if (propagateTransientReadErrors && retryableRpcFailure(error)) throw error;
        return {};
      }
    },
    async isOpeningBlockhashValid(blockhash) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash) return false;
      return (await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send()).value;
    },
    async openingBlockHeight() {
      return Number(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    },
    async simulateOpeningTransaction(raw) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash)
        throw new Error('Silver opening cluster mismatch');
      const { value } = await rpc.simulateTransaction(getBase64Decoder().decode(raw), {
        encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false,
        commitment: 'confirmed', innerInstructions: true,
      }).send();
      return value;
    },
    async sendOpeningTransaction(raw) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash)
        throw new Error('Silver opening cluster mismatch');
      return rpc.sendTransaction(getBase64Decoder().decode(raw), {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
      }).send();
    },
    async openingSignatureStatus(signature) {
      const { value } = await rpc.getSignatureStatuses([signature],
        { searchTransactionHistory: true }).send();
      return value[0];
    },
    async openingTransaction(signature) {
      return rpc.getTransaction(signature, {
        encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0,
      }).send();
    },
    async readOpeningOperation({ programId, mintAddress, walletAddress, escrowAddress,
      requestAddress, seed, nextOperation, designVersion, designCommitment }) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash) return false;
      const number = Buffer.alloc(8);
      number.writeBigUInt64LE(BigInt(nextOperation));
      const [key] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-open'), encode(mintAddress), number] });
      const { value } = await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'finalized',
      }).send();
      if (value?.owner !== programId) return false;
      const bytes = Buffer.from(value.data[0], 'base64');
      return bytes.length === 320 && bytes.subarray(0, 8).equals(Buffer.from('ERSOPV1\0')) &&
        bytes[8] === 1 && [1, 2].includes(bytes[9]) &&
        bytes.readBigUInt64LE(16) === BigInt(nextOperation) &&
        decode(bytes.subarray(24, 56)) === mintAddress &&
        decode(bytes.subarray(56, 88)) === walletAddress &&
        decode(bytes.subarray(88, 120)) === escrowAddress &&
        decode(bytes.subarray(120, 152)) === requestAddress &&
        bytes.subarray(152, 184).equals(seed) &&
        (designVersion === undefined ||
          bytes.readBigUInt64LE(216) === BigInt(designVersion)) &&
        (designCommitment === undefined ||
          bytes.subarray(226, 258).toString('hex') === designCommitment);
    },
    async readOpeningInventory({ programId, mintAddress, walletAddress,
      sourceTokenAddress, escrowAddress, seed, nextOperation, designVersion,
      designCommitment, issuanceId }) {
      const [requestAddress] = await getProgramDerivedAddress({
        programAddress: address(ORAO_CLASSIC),
        seeds: [text('orao-vrf-randomness-request'), seed],
      });
      if (!await this.readOpeningOperation({ programId, mintAddress, walletAddress,
        escrowAddress, requestAddress, seed, nextOperation, designVersion,
        designCommitment })) return false;
      const [lifecycleAddress] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [text('silver-lifecycle'), encode(mintAddress)],
      });
      const [stateAddress] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [text('silver-state'), encode(mintAddress)],
      });
      const [escrowAuthority] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [text('silver-escrow'), encode(mintAddress)],
      });
      const read = async key => (await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      const [life, state, source, escrow, request] = await Promise.all([
        read(lifecycleAddress), read(stateAddress), read(sourceTokenAddress),
        read(escrowAddress), read(requestAddress),
      ]);
      if (life?.owner !== programId || state?.owner !== programId ||
          source?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
          escrow?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
          request?.owner !== ORAO_CLASSIC) return false;
      const l = Buffer.from(life.data[0], 'base64');
      const s = Buffer.from(state.data[0], 'base64');
      if (l.length !== 128 || !l.subarray(0, 8).equals(LIFECYCLE_MAGIC) ||
          l[8] !== 1 || l[9] !== 1 ||
          decode(l.subarray(16, 48)) !== mintAddress ||
          l.readBigUInt64LE(48) !== BigInt(nextOperation) + 1n ||
          s.length !== 204 || !s.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1])) ||
          s.subarray(4, 36).toString('hex') !== issuanceId ||
          decode(s.subarray(36, 68)) !== mintAddress) return false;
      const [operationAddress] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [text('silver-open'), encode(mintAddress),
          Buffer.from(Uint8Array.from({ length: 8 }, (_, i) =>
            Number((BigInt(nextOperation) >> BigInt(i * 8)) & 255n)))],
      });
      if (decode(l.subarray(56, 88)) !== operationAddress) return false;
      const src = getTokenDecoder().decode(Buffer.from(source.data[0], 'base64'));
      const dst = getTokenDecoder().decode(Buffer.from(escrow.data[0], 'base64'));
      return src.mint === mintAddress && src.owner === walletAddress && src.amount === 0n &&
        dst.mint === mintAddress && dst.owner === escrowAuthority && dst.amount === 1n;
    },
    async listOwnedAssets({ programId, cluster, walletAddress }) {
      if (cluster !== expectedCluster ||
          await rpc.getGenesisHash().send() !== expectedGenesisHash)
        throw new Error('Silver inventory reader cluster mismatch');
      const owned = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      const snapshot = { marker: inventorySnapshotMarker, walletAddress, owned };
      return Promise.all([
        this.listOwnedBoxes({ programId, cluster, walletAddress, snapshot }),
        this.listOwnedRings({ programId, cluster, walletAddress, snapshot }),
      ]);
    },
    async listOwnedRings({ programId, cluster, walletAddress, mintAddress: requestedMint = null,
      snapshot = null }) {
      const shared = snapshot?.marker === inventorySnapshotMarker &&
        snapshot.walletAddress === walletAddress;
      if (cluster !== expectedCluster ||
          (!shared && await rpc.getGenesisHash().send() !== expectedGenesisHash)) {
        throw new Error('Silver Ring reader cluster mismatch');
      }
      const owned = shared ? snapshot.owned : (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      return mapOwnedAssets(owned, async ({ account }) => {
        const token = account.data.parsed?.info;
        if (account.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
            token?.owner !== walletAddress || token.tokenAmount?.amount !== '1') return null;
        const mintAddress = token.mint;
        if (requestedMint !== null && mintAddress !== requestedMint) return null;
        const [ringState] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-ring-state'), encode(mintAddress)] });
        const rawRing = (await rpc.getAccountInfo(address(ringState),
          { encoding: 'base64', commitment: 'finalized' }).send()).value;
        if (rawRing?.owner !== programId) return null;
        const ring = Buffer.from(rawRing.data[0], 'base64');
        if (ring.length !== 576 || !ring.subarray(0, 8).equals(Buffer.from('ERSRGV1\0')) ||
            decode(ring.subarray(16, 48)) !== mintAddress) return null;
        const boxMint = decode(ring.subarray(48, 80));
        const [boxState] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-state'), encode(boxMint)] });
        const rawBox = (await rpc.getAccountInfo(address(boxState),
          { encoding: 'base64', commitment: 'finalized' }).send()).value;
        if (rawBox?.owner !== programId) return null;
        const box = Buffer.from(rawBox.data[0], 'base64');
        if (box.length !== 204 || !box.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1]))) return null;
        const issuanceId = box.subarray(4, 36).toString('hex');
        const verified = await this.readRingForIssuance({ programId, cluster, issuanceId,
          walletAddress, snapshot });
        return verified?.mintAddress === mintAddress ? verified : null;
      });
    },
    async listOwnedBoxes({ programId, cluster, walletAddress, snapshot = null }) {
      const shared = snapshot?.marker === inventorySnapshotMarker &&
        snapshot.walletAddress === walletAddress;
      if (cluster !== expectedCluster ||
          (!shared && await rpc.getGenesisHash().send() !== expectedGenesisHash))
        throw new Error('Silver Box reader cluster mismatch');
      const [collection] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-collection')] });
      const owned = shared ? snapshot.owned : (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      return mapOwnedAssets(owned, async ({ account }) => {
        const token = account.data.parsed?.info;
        if (account.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
            token?.owner !== walletAddress || token.tokenAmount?.amount !== '1') return null;
        const mintAddress = token.mint;
        const [state] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('silver-state'), encode(mintAddress)] });
        const raw = (await rpc.getAccountInfo(address(state), {
          encoding: 'base64', commitment: 'finalized' }).send()).value;
        if (raw?.owner !== programId) return null;
        const bytes = Buffer.from(raw.data[0], 'base64');
        if (bytes.length !== 204 || !bytes.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1])) ||
            decode(bytes.subarray(36, 68)) !== mintAddress ||
            decode(bytes.subarray(68, 100)) !== collection) return null;
        const issuanceId = bytes.subarray(4, 36).toString('hex');
        const media = await this.readBoxMedia({ programId, cluster, mintAddress,
          issuanceId, collectionId: collection, includeProvenance: true, snapshot });
        if (!media.serial || !media.issuanceSource) return null;
        const expectedBreeding = media.issuanceSource === 'cooper-breeding' ? {
          operationId: media.breedingOperationId,
          firstRingId: media.breedingFirstParent,
          secondRingId: media.breedingSecondParent,
          firstUses: media.breedingFirstUses,
          secondUses: media.breedingSecondUses,
        } : null;
        const verified = await this.readFinalized({ programId, cluster, issuanceId,
          walletAddress, expectedIssuanceSource: media.issuanceSource,
          expectedDrawResultId: media.drawResultId,
          expectedAdminOperationId: media.adminOperationId,
          expectedBreeding, snapshot });
        if (verified?.finalized && verified.kind === 'SILVER_BOX' &&
            verified.mintAddress === mintAddress && verified.tokenOwner === walletAddress &&
            verified.lifecycle === 'SEALED' && verified.serial === media.serial)
          return verified;
        return null;
      });
    },
    async readEquipmentEligibility({ programId, cluster, walletAddress, mintAddress }) {
      if (cluster !== expectedCluster ||
          await rpc.getGenesisHash().send() !== expectedGenesisHash)
        throw new Error('Silver equipment reader cluster mismatch');
      const [ringState] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-ring-state'), encode(mintAddress)] });
      const raw = (await rpc.getAccountInfo(address(ringState),
        { encoding: 'base64', commitment: 'finalized' }).send()).value;
      if (raw?.owner !== programId) return { state: 'UNKNOWN' };
      const ring = Buffer.from(raw.data[0], 'base64');
      if (ring.length !== 576 || !ring.subarray(0, 8).equals(Buffer.from('ERSRGV1\0')) ||
          decode(ring.subarray(16, 48)) !== mintAddress) return { state: 'UNKNOWN' };
      const slot = ring.readBigUInt64LE(320);
      const until = ring.readBigInt64LE(328);
      if (until < 0n || (slot === 0n) !== (until === 0n)) return { state: 'UNKNOWN' };
      const owned = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { mint: address(mintAddress) },
        { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      if (owned.some(({ account }) =>
        account.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
        account.data.parsed?.info?.mint !== mintAddress ||
        account.data.parsed.info.owner !== walletAddress ||
        !['0', '1'].includes(account.data.parsed.info.tokenAmount.amount)))
        return { state: 'UNKNOWN' };
      const exact = owned.filter(({ account }) =>
        account.data.parsed.info.tokenAmount.amount === '1');
      if (exact.length === 0) return { state: 'TRANSFERRED_AWAY' };
      if (exact.length !== 1) return { state: 'UNKNOWN' };
      const verified = (await this.listOwnedRings({ programId, cluster, walletAddress,
        mintAddress }))
        .find(candidate => candidate.mintAddress === mintAddress);
      if (!verified || verified.lastDirectTransferSlot !== slot.toString() ||
          verified.cooldownUntilUnixSeconds !== until.toString()) return { state: 'UNKNOWN' };
      if (until === 0n) return { state: 'ELIGIBLE', ring: verified };
      const finalizedSlot = await rpc.getSlot({ commitment: 'finalized' }).send();
      const blockTime = await rpc.getBlockTime(finalizedSlot).send();
      if (blockTime === null || blockTime === undefined ||
          !/^[0-9]+$/.test(String(blockTime))) return { state: 'UNKNOWN' };
      return BigInt(blockTime) < until ?
        { state: 'COOLDOWN', cooldownUntilUnixSeconds: until.toString() } :
        { state: 'ELIGIBLE', ring: verified };
    },
    async readCandidateOpeningSnapshot({ programId, mintAddress, walletAddress,
      escrowAddress }) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash) {
        throw new Error('Candidate Silver cluster mismatch');
      }
      const pda = async (id, ...seeds) => (await getProgramDerivedAddress({
        programAddress: address(id), seeds,
      }))[0];
      const config = await pda(programId, text('silver-config'));
      const collection = await pda(programId, text('silver-collection'));
      const state = await pda(programId, text('silver-state'), encode(mintAddress));
      const lifecycle = await pda(programId, text('silver-lifecycle'), encode(mintAddress));
      const extraMetas = await pda(programId, text('extra-account-metas'), encode(mintAddress));
      const escrowAuthority = await pda(programId, text('silver-escrow'), encode(mintAddress));
      const network = await pda(ORAO_CLASSIC, text('orao-vrf-network-configuration'));
      const raw = async key => (await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      const [programAccount, oraoAccount, configAccount, collectionAccount,
        stateAccount, lifecycleAccount, networkAccount, escrowAccount, extraAccount] = await Promise.all([
        raw(programId), raw(ORAO_CLASSIC), raw(config), raw(collection), raw(state), raw(lifecycle),
        raw(network), raw(escrowAddress), raw(extraMetas),
      ]);
      const metaVersion = extraAccount?.owner === programId
        ? canonicalMetaVersion(Buffer.from(extraAccount.data[0], 'base64')) : 0;
      if (!metaVersion) return null;
      if (!programAccount?.executable || !oraoAccount?.executable ||
          configAccount?.owner !== programId || collectionAccount?.owner !== programId ||
          stateAccount?.owner !== programId ||
          lifecycleAccount?.owner !== programId || networkAccount?.owner !== ORAO_CLASSIC ||
          escrowAccount?.owner !== TOKEN_2022_PROGRAM_ADDRESS) return null;
      const data = account => Buffer.from(account.data[0], 'base64');
      const configBytes = data(configAccount);
      const collectionBytes = data(collectionAccount);
      const stateBytes = data(stateAccount);
      const lifeBytes = data(lifecycleAccount);
      const networkBytes = data(networkAccount);
      if (configBytes.length !== 145 || configBytes[0] !== 2 ||
          collectionBytes.length !== 66 || collectionBytes[0] !== 1 ||
          !collectionBytes.subarray(1, 33).equals(configBytes.subarray(1, 33)) ||
          decode(collectionBytes.subarray(33, 65)) !== config || collectionBytes[65] !== 1 ||
          stateBytes.length !== 204 || !stateBytes.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1])) ||
          await pda(programId, text('silver-mint'), stateBytes.subarray(4, 36)) !== mintAddress ||
          decode(stateBytes.subarray(36, 68)) !== mintAddress ||
          decode(stateBytes.subarray(68, 100)) !== collection ||
          lifeBytes.length !== 128 || !lifeBytes.subarray(0, 8).equals(LIFECYCLE_MAGIC) ||
          lifeBytes[8] !== 1 || lifeBytes[9] !== 0 ||
          decode(lifeBytes.subarray(16, 48)) !== mintAddress ||
          !lifeBytes.subarray(56, 120).equals(Buffer.alloc(64)) ||
          lifeBytes.readBigUInt64LE(48) < 1n ||
          lifeBytes.readBigUInt64LE(48) === 0xffffffffffffffffn ||
          stateBytes.readBigInt64LE(196) > BigInt(Math.floor(Date.now() / 1000)) ||
          networkBytes.length < 72) return null;
      const nextOperation = lifeBytes.readBigUInt64LE(48);
      const activeVersion = configBytes.readBigUInt64LE(105);
      const activeDesign = await pda(programId, text('silver-design-set'),
        Buffer.from(configBytes.subarray(105, 113)));
      const designAccount = await raw(activeDesign);
      if (designAccount?.owner !== programId) return null;
      const designBytes = data(designAccount);
      if (designBytes.length < 104) return null;
      const capacity = designBytes.readUInt16LE(10);
      const count = designBytes.readUInt16LE(12);
      const used = designBytes.readUInt16LE(14);
      if (designBytes.length < 104 || capacity < 1 || capacity > 42 ||
          count < 1 || count > capacity || used > capacity * 238 ||
          designBytes.length !== 104 + capacity * 238 ||
          !designBytes.subarray(0, 8).equals(Buffer.from('ERSDSV1\0')) ||
          designBytes[8] !== 1 || designBytes[9] !== 1 ||
          designBytes.subarray(96, 104).every(byte => byte === 0) ||
          designBytes.readBigUInt64LE(16) !== activeVersion ||
          !designBytes.subarray(24, 56).equals(configBytes.subarray(1, 33)) ||
          !designBytes.subarray(56, 88).equals(configBytes.subarray(113, 145)) ||
          decode(configBytes.subarray(73, 105)) !== activeDesign ||
          nextOperation > BigInt(Number.MAX_SAFE_INTEGER) ||
          activeVersion > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const end = 104 + used;
      if (designBytes.subarray(end).some(byte => byte !== 0)) return null;
      const digest = createHash('sha256').update('ETHERINGS_SILVER_DESIGN_SET_V1')
        .update(encode(programId)).update(encode(activeDesign))
        .update(designBytes.subarray(16, 24)).update(designBytes.subarray(12, 14));
      let cursor = 104;
      let previousId = 0;
      for (let index = 0; index < count; index++) {
        if (cursor + 38 > end) return null;
        const id = designBytes.readUInt32LE(cursor);
        const uriLength = designBytes.readUInt16LE(cursor + 4);
        const next = cursor + 38 + uriLength;
        if (id <= previousId || uriLength < 1 || uriLength > 200 || next > end ||
            designBytes.subarray(cursor + 6, cursor + 6 + uriLength)
              .some(byte => byte < 0x21 || byte > 0x7e) ||
            designBytes.subarray(next - 32, next).every(byte => byte === 0)) return null;
        digest.update(designBytes.subarray(cursor, next));
        cursor = next;
        previousId = id;
      }
      if (cursor !== end ||
          !digest.digest().equals(designBytes.subarray(56, 88))) return null;
      const escrow = getTokenDecoder().decode(data(escrowAccount));
      if (escrow.mint !== mintAddress || escrow.owner !== escrowAuthority ||
          escrow.amount !== 0n) return null;
      const mintAccount = (await rpc.getAccountInfo(address(mintAddress), {
        encoding: 'jsonParsed', commitment: 'finalized',
      }).send()).value;
      const mintInfo = mintAccount?.data?.parsed?.info;
      if (mintAccount?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
          mintInfo?.supply !== '1' || mintInfo.decimals !== 0 ||
          mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) return null;
      const tokenAccounts = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { mint: address(mintAddress) }, { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      const owned = tokenAccounts.filter(({ account }) =>
        account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        account.data.parsed?.info?.mint === mintAddress &&
        account.data.parsed.info.owner === walletAddress &&
        account.data.parsed.info.tokenAmount.amount === '1');
      if (owned.length !== 1) return null;
      const source = await raw(owned[0].pubkey);
      if (source?.owner !== TOKEN_2022_PROGRAM_ADDRESS) return null;
      const sourceToken = getTokenDecoder().decode(data(source));
      if (sourceToken.mint !== mintAddress || sourceToken.owner !== walletAddress ||
          sourceToken.amount !== 1n) return null;
      const treasury = decode(networkBytes.subarray(40, 72));
      if (treasury === '11111111111111111111111111111111') return null;
      return { finalized: true, cluster: expectedCluster, genesisHash: expectedGenesisHash,
        programId, mintAddress, walletAddress, escrowAddress,
        sourceTokenAddress: owned[0].pubkey, boxAmount: '1', escrowAmount: '0',
        lifecycle: 'SEALED', nextOperation: Number(nextOperation),
        designFrozen: true, designVersion: Number(activeVersion),
        designCommitment: configBytes.subarray(113, 145).toString('hex'),
        oraoTreasury: treasury, marketProgramId: metaVersion.marketProgramId ?? null };
    },
    async isCandidateRequestAbsent({ programId, mintAddress, nextOperation, seed }) {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash) return false;
      const number = Buffer.alloc(8);
      number.writeBigUInt64LE(BigInt(nextOperation));
      const [operation] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-open'), encode(mintAddress), number] });
      const [request] = await getProgramDerivedAddress({ programAddress: address(ORAO_CLASSIC),
        seeds: [text('orao-vrf-randomness-request'), seed] });
      const [op, req] = await Promise.all([operation, request].map(key =>
        rpc.getAccountInfo(address(key), { encoding: 'base64', commitment: 'finalized' }).send()));
      return op.value === null && req.value === null;
    },
    async getCandidateBlockhash() {
      if (await rpc.getGenesisHash().send() !== expectedGenesisHash) {
        throw new Error('Candidate Silver cluster mismatch');
      }
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { genesisHash: expectedGenesisHash, blockhash: value.blockhash,
        lastValidBlockHeight: Number(value.lastValidBlockHeight) };
    },
    async readEscrow({ cluster, mintAddress, escrowAddress, escrowAuthority }) {
      if (cluster !== expectedCluster || await rpc.getGenesisHash().send() !== expectedGenesisHash) {
        throw new Error('Silver escrow cluster mismatch');
      }
      const raw = (await rpc.getAccountInfo(address(escrowAddress), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      if (!raw) return null;
      const token = getTokenDecoder().decode(Buffer.from(raw.data[0], 'base64'));
      return { finalized: true, cluster, address: escrowAddress, programOwner: raw.owner,
        mintAddress: token.mint, authority: token.owner, amount: token.amount.toString() };
    },
    async readFinalized({ programId, cluster, issuanceId, walletAddress,
      expectedFinalizedSignature, expectedIssuanceSource = 'first-entry',
      expectedDrawResultId = null, expectedAdminOperationId = null,
      expectedBreeding = null, snapshot = null }) {
      if (cluster !== expectedCluster || !/^[a-f0-9]{64}$/.test(issuanceId) ||
          !['first-entry', 'draw', 'cooper-breeding', 'admin-grant'].includes(expectedIssuanceSource) ||
          (expectedIssuanceSource === 'draw' &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedDrawResultId ?? '')) ||
          (expectedIssuanceSource === 'admin-grant' &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedAdminOperationId ?? '')) ||
          (expectedIssuanceSource === 'cooper-breeding' &&
            (!expectedBreeding || ![expectedBreeding.operationId,
              expectedBreeding.firstRingId, expectedBreeding.secondRingId].every(value =>
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value ?? '')) ||
              ![expectedBreeding.firstUses, expectedBreeding.secondUses].every(value =>
                Number.isInteger(value) && value >= 0 && value <= 1))) ||
          (!(snapshot?.marker === inventorySnapshotMarker &&
            snapshot.walletAddress === walletAddress) &&
            await rpc.getGenesisHash().send() !== expectedGenesisHash)) {
        throw new Error('Silver chain reader cluster/issuance mismatch');
      }
      const [mint] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-mint'), Buffer.from(issuanceId, 'hex')] });
      const [state] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-state'), encode(mint)] });
      const [collection] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-collection')] });
      const [lifecycle] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-lifecycle'), encode(mint)] });
      const rawState = (await rpc.getAccountInfo(address(state), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      if (!rawState) return null;
      const bytes = Buffer.from(rawState.data[0], 'base64');
      const schema = bytes[0];
      if (rawState.owner !== programId ||
          schema !== 3 || bytes.length !== 204 ||
          bytes[1] !== 1 || bytes[2] !== 1 || bytes[3] !== 1 ||
          bytes.subarray(4, 36).toString('hex') !== issuanceId ||
          decode(bytes.subarray(36, 68)) !== mint ||
          decode(bytes.subarray(68, 100)) !== collection) return null;
      const issuanceSlot = bytes.readBigUInt64LE(180);
      if (issuanceSlot === 0n) return null;
      const [extraMetas] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('extra-account-metas'), encode(mint)] });
      const [rawMetas, rawLifecycle] = await Promise.all([
        rpc.getAccountInfo(address(extraMetas), {
          encoding: 'base64', commitment: 'finalized',
        }).send().then(result => result.value),
        rpc.getAccountInfo(address(lifecycle), {
          encoding: 'base64', commitment: 'finalized',
        }).send().then(result => result.value),
      ]);
      const metaBytes = rawMetas && Buffer.from(rawMetas.data[0], 'base64');
      const lifecycleBytes = rawLifecycle && Buffer.from(rawLifecycle.data[0], 'base64');
      if (rawMetas?.owner !== programId ||
          !verifiedSilverDirectTransferEam(metaBytes, 'SILVER_BOX') ||
          rawLifecycle?.owner !== programId || lifecycleBytes?.length !== 128 ||
          !lifecycleBytes.subarray(0, 8).equals(LIFECYCLE_MAGIC) ||
          lifecycleBytes[8] !== 1 || lifecycleBytes[9] !== 0 ||
          !lifecycleBytes.subarray(10, 16).equals(Buffer.alloc(6)) ||
          decode(lifecycleBytes.subarray(16, 48)) !== mint ||
          lifecycleBytes.readBigUInt64LE(48) !== 1n ||
          !lifecycleBytes.subarray(56, 120).equals(Buffer.alloc(64)) ||
          lifecycleBytes.readBigUInt64LE(120) === 0n) return null;
      const slot = bytes.readBigUInt64LE(188);
      const until = bytes.readBigInt64LE(196);
      if ((slot === 0n) !== (until === 0n) || until < 0n) return null;
      const lastDirectTransferSlot = slot.toString();
      const cooldownUntilUnixSeconds = until.toString();

      const owner = decode(bytes.subarray(100, 132));
      const currentOwner = walletAddress ?? owner;
      const parsedMint = (await rpc.getAccountInfo(address(mint), {
        encoding: 'jsonParsed', commitment: 'finalized',
      }).send()).value;
      const tokenAccounts = (await rpc.getTokenAccountsByOwner(address(currentOwner),
        { mint: address(mint) }, { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      const token = tokenAccounts.find(({ account }) =>
        account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        account.data.parsed?.info?.mint === mint &&
        account.data.parsed.info.owner === currentOwner &&
        account.data.parsed.info.tokenAmount.amount === '1');
      const mintInfo = parsedMint?.data?.parsed?.info;
      if (parsedMint?.owner !== TOKEN_2022_PROGRAM_ADDRESS || !token ||
          mintInfo?.supply !== '1' || mintInfo.decimals !== 0 ||
          mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) return null;
      const media = await this.readBoxMedia({ programId, cluster, mintAddress: mint,
        issuanceId, collectionId: collection,
        includeProvenance: expectedIssuanceSource !== 'first-entry', snapshot });
      if (expectedIssuanceSource === 'draw' &&
          (!media.serial || media.issuanceSource !== 'draw' ||
            media.drawResultId !== expectedDrawResultId ||
            media.entitlementDigest !== bytes.subarray(132, 164).toString('hex')))
        return null;
      if (expectedIssuanceSource === 'admin-grant' &&
          (!media.serial || media.issuanceSource !== 'admin-grant' ||
            media.adminOperationId !== expectedAdminOperationId ||
            media.entitlementDigest !== bytes.subarray(132, 164).toString('hex')))
        return null;
      if (expectedIssuanceSource === 'cooper-breeding' &&
          (!media.serial || media.issuanceSource !== 'cooper-breeding' ||
            media.breedingOperationId !== expectedBreeding.operationId ||
            media.breedingFirstParent !== expectedBreeding.firstRingId ||
            media.breedingSecondParent !== expectedBreeding.secondRingId ||
            media.breedingFirstUses !== expectedBreeding.firstUses ||
            media.breedingSecondUses !== expectedBreeding.secondUses ||
            media.entitlementDigest !== bytes.subarray(132, 164).toString('hex')))
        return null;
      return { finalized: true, finalizedSignature: expectedFinalizedSignature ?? null,
        issuanceSlot: issuanceSlot.toString(),
        stateSchemaVersion: schema, programId, stateOwnerProgramId: rawState.owner,
        mintOwnerProgramId: parsedMint.owner,
        tokenAccountOwnerProgramId: token.account.owner,
        collectionId: collection, cluster, issuanceId,
        entitlementDigest: bytes.subarray(132, 164).toString('hex'),
        issuanceSource: expectedIssuanceSource,
        ...(expectedIssuanceSource === 'draw' ? { drawResultId: expectedDrawResultId } : {}),
        ...(expectedIssuanceSource === 'admin-grant' ?
          { adminOperationId: expectedAdminOperationId } : {}),
        ...(expectedIssuanceSource === 'cooper-breeding' ? {
          breedingOperationId: expectedBreeding.operationId,
          breedingFirstParent: expectedBreeding.firstRingId,
          breedingSecondParent: expectedBreeding.secondRingId,
          breedingFirstUses: expectedBreeding.firstUses,
          breedingSecondUses: expectedBreeding.secondUses,
        } : {}),
        accountId: uuid(bytes.subarray(164, 180)),
        kind: 'SILVER_BOX', lifecycle: 'SEALED', originalRecipient: owner,
        mintAddress: mint, stateAddress: state, stateMint: mint, tokenMint: mint,
        tokenOwner: currentOwner, supply: mintInfo.supply, decimals: mintInfo.decimals,
        tokenAmount: token.account.data.parsed.info.tokenAmount.amount,
        mintAuthority: mintInfo.mintAuthority, freezeAuthority: mintInfo.freezeAuthority,
        lifecycleAddress: lifecycle, lifecycleVersion: lifecycleBytes[8],
        lifecyclePhase: 'SEALED', lifecycleNextOperation: '1',
        lifecycleMigrationSlot: lifecycleBytes.readBigUInt64LE(120).toString(),
        lastDirectTransferSlot, cooldownUntilUnixSeconds, ...media };
    },
    async readRingForIssuance({ programId, cluster, issuanceId, walletAddress,
      snapshot = null }) {
      if (cluster !== expectedCluster || !/^[a-f0-9]{64}$/.test(issuanceId) ||
          (!(snapshot?.marker === inventorySnapshotMarker &&
            snapshot.walletAddress === walletAddress) &&
            await rpc.getGenesisHash().send() !== expectedGenesisHash)) {
        throw new Error('Silver Ring reader cluster/issuance mismatch');
      }
      const pda = async (...seeds) => (await getProgramDerivedAddress({
        programAddress: address(programId), seeds,
      }))[0];
      const read = async key => (await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      const readGroup = async keys => {
        const { value } = await rpc.getMultipleAccounts(keys.map(address), {
          encoding: 'base64', commitment: 'finalized',
        }).send();
        if (!Array.isArray(value) || value.length !== keys.length)
          throw new Error('Incomplete finalized Silver account snapshot');
        return value;
      };
      const bytesOf = account => Buffer.from(account.data[0], 'base64');
      const boxMint = await pda(text('silver-mint'), Buffer.from(issuanceId, 'hex'));
      const boxState = await pda(text('silver-state'), encode(boxMint));
      const lifecycle = await pda(text('silver-lifecycle'), encode(boxMint));
      const collection = await pda(text('silver-collection'));
      const [rawBox, rawLife, rawBoxMint] = await readGroup(
        [boxState, lifecycle, boxMint]);
      if (rawBox?.owner !== programId || rawLife?.owner !== programId ||
          rawBoxMint?.owner !== TOKEN_2022_PROGRAM_ADDRESS) return null;
      const box = bytesOf(rawBox);
      const life = bytesOf(rawLife);
      if (box.length !== 204 || !box.subarray(0, 4).equals(Buffer.from([3, 1, 1, 1])) ||
          box.subarray(4, 36).toString('hex') !== issuanceId ||
          decode(box.subarray(36, 68)) !== boxMint ||
          decode(box.subarray(68, 100)) !== collection ||
          box.readBigUInt64LE(180) === 0n ||
          life.length !== 128 || !life.subarray(0, 8).equals(LIFECYCLE_MAGIC) ||
          life[8] !== 1 || life[9] !== 2 ||
          !life.subarray(10, 16).equals(Buffer.alloc(6)) ||
          decode(life.subarray(16, 48)) !== boxMint ||
          life.readBigUInt64LE(48) < 2n ||
          life.subarray(56, 88).every(byte => byte === 0) ||
          life.readBigUInt64LE(120) === 0n) return null;
      const operationAddress = decode(life.subarray(56, 88));
      const operationNumber = life.readBigUInt64LE(48) - 1n;
      const number = Buffer.alloc(8);
      number.writeBigUInt64LE(operationNumber);
      if (operationAddress !== await pda(text('silver-open'), encode(boxMint), number)) return null;
      const ringMint = decode(life.subarray(88, 120));
      const expectedRing = await pda(text('silver-ring-mint'), encode(boxMint), encode(operationAddress));
      if (ringMint !== expectedRing) return null;
      const ringState = await pda(text('silver-ring-state'), encode(ringMint));
      const metas = await pda(text('extra-account-metas'), encode(ringMint));
      const [rawOperation, rawRing, rawMint, rawMetas] = await readGroup(
        [operationAddress, ringState, ringMint, metas]);
      if (rawOperation?.owner !== programId || rawRing?.owner !== programId ||
          rawMint?.owner !== TOKEN_2022_PROGRAM_ADDRESS || rawMetas?.owner !== programId) return null;
      const op = bytesOf(rawOperation);
      const ring = bytesOf(rawRing);
      const extra = bytesOf(rawMetas);
      const boxMintInfo = getMintDecoder().decode(bytesOf(rawBoxMint));
      if (op.length !== 320 || !op.subarray(0, 8).equals(Buffer.from('ERSOPV1\0')) ||
          op[8] !== 1 || op[9] !== 2 || op.readBigUInt64LE(16) !== operationNumber ||
          decode(op.subarray(24, 56)) !== boxMint ||
          op.subarray(56, 88).every(byte => byte === 0) ||
          op.subarray(120, 152).every(byte => byte === 0) ||
          decode(op.subarray(266, 298)) !== ringMint ||
          op.readBigUInt64LE(298) === 0n ||
          ring.length !== 576 || !ring.subarray(0, 8).equals(Buffer.from('ERSRGV1\0')) ||
          ring[8] !== 1 || ring[9] !== 2 ||
          decode(ring.subarray(16, 48)) !== ringMint ||
          decode(ring.subarray(48, 80)) !== boxMint ||
          decode(ring.subarray(80, 112)) !== operationAddress ||
          !ring.subarray(112, 144).equals(op.subarray(56, 88)) ||
          decode(ring.subarray(144, 176)) !== collection ||
          !ring.subarray(176, 208).equals(op.subarray(120, 152)) ||
          !ring.subarray(208, 240).equals(op.subarray(226, 258)) ||
          !ring.subarray(240, 248).equals(op.subarray(216, 224)) ||
          !validSilverProgressionState(ring) ||
          ring[296] !== 1 ||
          ring.readUInt16LE(248) >= op.readUInt16LE(224) ||
          ring.readUInt16LE(297) !== op.readUInt16LE(224) ||
          !ring.subarray(300, 304).equals(Buffer.alloc(4)) ||
          ring.readBigUInt64LE(304) === 0n ||
          ring.readBigUInt64LE(312) < ring.readBigUInt64LE(304) ||
          ring.subarray(538, 544).some(byte => byte !== 0) ||
          !extra.subarray(0, 8).equals(Buffer.from('692565c54bfb661a', 'hex')) ||
          boxMintInfo.supply !== 0n || !boxMintInfo.isInitialized ||
          boxMintInfo.decimals !== 0 ||
          boxMintInfo.mintAuthority.__option !== 'None' ||
          boxMintInfo.freezeAuthority.__option !== 'None' ||
          !op.subarray(184, 216).some(byte => byte !== 0) ||
          op.readUInt16LE(224) < 1 || op.readUInt16LE(224) > 42 ||
          !op.subarray(226, 258).equals(ring.subarray(208, 240))) return null;
      const transferSlot = ring.readBigUInt64LE(320);
      const cooldownUntil = ring.readBigInt64LE(328);
      if (cooldownUntil < 0n || (transferSlot === 0n) !== (cooldownUntil === 0n)) return null;
        if (!canonicalRingMetaVersion(extra)) return null;
      const designVersion = op.subarray(216, 224);
      const designAddress = await pda(text('silver-design-set'), designVersion);
      const rawDesign = await read(designAddress);
      if (decode(op.subarray(184, 216)) !== designAddress || rawDesign?.owner !== programId) return null;
      const design = bytesOf(rawDesign);
      const capacity = design.length >= 104 ? design.readUInt16LE(10) : 0;
      const count = design.length >= 104 ? design.readUInt16LE(12) : 0;
      const used = design.length >= 104 ? design.readUInt16LE(14) : 0;
      if (design.length !== 104 + capacity * 238 || capacity < 1 || capacity > 42 ||
          count !== op.readUInt16LE(224) || count < 1 || count > capacity ||
          used > capacity * 238 ||
          !design.subarray(0, 8).equals(Buffer.from('ERSDSV1\0')) ||
          design[8] !== 1 || design[9] !== 1 ||
          !design.subarray(16, 24).equals(designVersion) ||
          !design.subarray(56, 88).equals(op.subarray(226, 258)) ||
          design.subarray(104 + used).some(byte => byte !== 0)) return null;
      const digest = createHash('sha256').update('ETHERINGS_SILVER_DESIGN_SET_V1')
        .update(encode(programId)).update(encode(designAddress))
        .update(design.subarray(16, 24)).update(design.subarray(12, 14));
      let cursor = 104;
      let selected;
      let previousId = 0;
      const visualIndex = ring.readUInt16LE(248);
      for (let index = 0; index < count; index++) {
        if (cursor + 38 > 104 + used) return null;
        const designId = design.readUInt32LE(cursor);
        const length = design.readUInt16LE(cursor + 4);
        const next = cursor + 38 + length;
        if (designId <= previousId || length < 1 || length > 200 || next > 104 + used) return null;
        digest.update(design.subarray(cursor, next));
        if (index === visualIndex) selected = { id: designId,
          uri: design.subarray(cursor + 6, cursor + 6 + length).toString('utf8'),
          hash: design.subarray(next - 32, next) };
        previousId = designId;
        cursor = next;
      }
      if (cursor !== 104 + used || !digest.digest().equals(design.subarray(56, 88)) ||
          !selected || selected.id !== ring.readUInt32LE(250) ||
          !selected.hash.equals(ring.subarray(254, 286))) return null;
      const mint = getMintDecoder().decode(bytesOf(rawMint));
      const metadata = mint.extensions.__option === 'Some' &&
        mint.extensions.value.find(ext => ext.__kind === 'TokenMetadata');
      const hook = mint.extensions.__option === 'Some' &&
        mint.extensions.value.find(ext => ext.__kind === 'TransferHook');
      const pointer = mint.extensions.__option === 'Some' &&
        mint.extensions.value.find(ext => ext.__kind === 'MetadataPointer');
      const uriLength = ring.readUInt16LE(336);
      const uri = ring.subarray(338, 338 + uriLength).toString('utf8');
      const designId = ring.readUInt32LE(250);
      const contentHash = ring.subarray(254, 286).toString('hex');
      const fields = metadata && new Map(metadata.additionalMetadata);
      const serial = serialFromFields(fields, 'SILVER_RING');
      if (mint.supply !== 1n || mint.decimals !== 0 || !mint.isInitialized ||
          mint.mintAuthority.__option !== 'None' || mint.freezeAuthority.__option !== 'None' ||
          hook?.programId !== programId || pointer?.metadataAddress?.value !== ringMint ||
          pointer.authority.__option !== 'None' || metadata?.mint !== ringMint ||
          metadata.name !== 'EtheRings Silver Ring' || metadata.symbol !== 'ESRG' ||
          uriLength < 8 || uriLength > 200 || !uri.startsWith('ipfs://') ||
          ring.subarray(338, 338 + uriLength).some(byte => byte < 0x21 || byte > 0x7e) ||
          ring.subarray(338 + uriLength, 538).some(byte => byte !== 0) ||
          uri !== selected.uri ||
          metadata.uri !== uri || fields.get('kind') !== 'SILVER_RING' ||
          fields.get('collection') !== collection || fields.get('design_id') !== String(designId) ||
          fields.get('content_hash') !== contentHash) return null;
      const owned = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { mint: address(ringMint) }, { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      if (owned.filter(({ account }) => account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
          account.data.parsed?.info?.mint === ringMint &&
          account.data.parsed.info.owner === walletAddress &&
          account.data.parsed.info.tokenAmount.amount === '1').length !== 1) return null;
      let verifiedSerial = null;
      if (serial) {
        const series = await pda(...seriesSeed(2));
        verifiedSerial = verifiedSeriesCounter(await read(series), programId, 2, serial) ?
          serial : null;
      }
      return { finalized: true, kind: 'SILVER_RING', programId, cluster, issuanceId,
        accountId: uuid(box.subarray(164, 180)), entitlementDigest: box.subarray(132, 164).toString('hex'),
        originalRecipient: decode(box.subarray(100, 132)), boxMint, mintAddress: ringMint,
        operationAddress, tokenOwner: walletAddress, collectionId: collection,
        designId, uri, contentHash, level: ring[290], shine: ring[291],
        unspentPoints: ring.readUInt32LE(292), comfort: ring[286], charm: ring[287],
        quality: ring[288], luck: ring[289],
        lastDirectTransferSlot: transferSlot.toString(),
        cooldownUntilUnixSeconds: cooldownUntil.toString(),
        ...(verifiedSerial ? { serial: verifiedSerial } : {}) };
    }
  };
}
