import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressDecoder,
  getAddressEncoder, getCompiledTransactionMessageEncoder, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { findExtraAccountMetaListPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { postJsonRpc } from './json-rpc.js';
import { firstEntryIdentity } from './silver-first-entry.js';
import { drawBoxIdentity } from './draw-box-identity.js';
import { adminBoxIdentity } from './admin-box-identity.js';
import { buildSilverProgressionMessage } from './silver-progression-intent.js';
import { readPreparedSilver } from './silver-progression-read.js';
import { silverRingIsListed } from './silver-listed-eligibility.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const VAULT = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
const GATEWAY = 'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
export const BOX_URI = 'ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png';
export const BOX_HASH = 'e86589ee25bcaa5c2a5dc8a708adecce7955955a2529310796d5a0fe3db67d37';
const utf8 = value => new TextEncoder().encode(value);
const encoder = getAddressEncoder();
const decoder = getAddressDecoder();
const rawAddress = key => Buffer.from(encoder.encode(address(key)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pda = async (programId, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(programId), seeds,
}))[0];
const accountMeta = (key, role) => ({ address: address(key), role });

function signerAddress(privateKey) {
  return decoder.decode(createPublicKey(privateKey).export({
    format: 'der', type: 'spki',
  }).subarray(-32));
}

export function createSilverIssuerChain({ rpcUrl, programId, issuerKeyPath,
  expectedProgramSha256, expectedProgramSize, progressionPool = null,
  progressionReader = null, marketReader = null }) {
  if (!rpcUrl?.startsWith('https://') || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(programId ?? '') ||
      !issuerKeyPath?.startsWith('/') || !/^[a-f0-9]{64}$/.test(expectedProgramSha256 ?? '') ||
      !Number.isSafeInteger(expectedProgramSize) || expectedProgramSize < 1)
    throw new Error('Silver issuer requires pinned Devnet program and external key');
  if (statSync(issuerKeyPath).mode & 0o077)
    throw new Error('Silver issuer key file must be private');
  const secret = Buffer.from(JSON.parse(readFileSync(issuerKeyPath, 'utf8')));
  if (secret.length !== 64) throw new Error('Silver issuer key length invalid');
  const issuerKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32),
  ]), format: 'der', type: 'pkcs8' });
  const issuerAddress = signerAddress(issuerKey);
  if (!secret.subarray(32).equals(rawAddress(issuerAddress)))
    throw new Error('Silver issuer keypair mismatch');
  secret.fill(0);
  let requestId = 0;
  async function rpc(method, params = []) {
    return postJsonRpc({ url: rpcUrl, method, params, id: ++requestId,
      label: 'Silver RPC' });
  }
  async function account(key) {
    const value = (await rpc('getAccountInfo', [key,
      { encoding: 'base64', commitment: 'finalized' }])).value;
    return value && { ...value, bytes: Buffer.from(value.data[0], 'base64') };
  }
  async function identities(row) {
    const { issuanceId } = row.issuance_source === 'admin-grant'
      ? adminBoxIdentity(row.account_id, row.wallet_address, row.admin_operation_id)
      : row.issuance_source === 'draw'
      ? drawBoxIdentity(row.account_id, row.wallet_address, row.draw_result_id)
      : firstEntryIdentity(row.account_id, row.wallet_address, 'devnet');
    if (row.issuance_id !== issuanceId) throw new Error('Silver issuance identity mismatch');
    const mint = await pda(programId, utf8('silver-mint'), Buffer.from(issuanceId, 'hex'));
    return { mint, state: await pda(programId, utf8('silver-state'), rawAddress(mint)),
      series: await pda(programId, utf8('silver-nft-series'), Buffer.from([1]), Buffer.from([1])),
      lifecycle: await pda(programId, utf8('silver-lifecycle'), rawAddress(mint)),
      config: await pda(programId, utf8('silver-config')),
      collection: await pda(programId, utf8('silver-collection')),
      authority: await pda(programId, utf8('silver-authority')),
      extraMetas: (await findExtraAccountMetaListPda({ mint: address(mint) },
        { programAddress: address(programId) }))[0],
      programdata: await pda(LOADER, rawAddress(programId)) };
  }
  async function pinnedProgram(ids) {
    if (await rpc('getGenesisHash') !== GENESIS) throw new Error('Silver issuer cluster mismatch');
    const [program, programdata, config, collection] = await Promise.all(
      [programId, ids.programdata, ids.config, ids.collection].map(account));
    if (!program?.executable || program.owner !== LOADER ||
        program.bytes.readUInt32LE(0) !== 2 ||
        decoder.decode(program.bytes.subarray(4, 36)) !== ids.programdata ||
        programdata?.owner !== LOADER || programdata.bytes.readUInt32LE(0) !== 3 ||
        programdata.bytes[12] !== 1 ||
        decoder.decode(programdata.bytes.subarray(13, 45)) !== VAULT ||
        programdata.bytes.length < 45 + expectedProgramSize ||
        sha(programdata.bytes.subarray(45, 45 + expectedProgramSize)) !== expectedProgramSha256 ||
        !programdata.bytes.subarray(45 + expectedProgramSize).every(byte => byte === 0) ||
        config?.owner !== programId || config.bytes.length !== 145 ||
        config.bytes[0] !== 2 || decoder.decode(config.bytes.subarray(1, 33)) !== VAULT ||
        decoder.decode(config.bytes.subarray(33, 65)) !== issuerAddress ||
        collection?.owner !== programId || collection.bytes.length !== 66 ||
        decoder.decode(collection.bytes.subarray(1, 33)) !== VAULT ||
        decoder.decode(collection.bytes.subarray(33, 65)) !== ids.config ||
        collection.bytes[65] !== 1)
      throw new Error('Silver issuer program/config pin mismatch');
  }

  async function ownedToken(walletAddress, mintAddress) {
    const holdings = (await rpc('getTokenAccountsByOwner', [walletAddress,
      { mint: mintAddress },
      { encoding: 'jsonParsed', commitment: 'finalized' }])).value.filter(({ account }) =>
      account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
      account.data.parsed?.info?.mint === mintAddress &&
      account.data.parsed.info.owner === walletAddress &&
      account.data.parsed.info.tokenAmount.amount === '1');
    if (holdings.length !== 1) throw new Error('Silver owner token unavailable');
    return holdings[0].pubkey;
  }

  return {
    issuerAddress,
    async identities(row) { return identities(row); },
    async verifyPinnedProgram() {
      await pinnedProgram({ config: await pda(programId, utf8('silver-config')),
        collection: await pda(programId, utf8('silver-collection')),
        programdata: await pda(LOADER, rawAddress(programId)) });
    },
    async readOwnedToken(walletAddress, mintAddress) {
      return ownedToken(walletAddress, mintAddress);
    },
    async latestBlockhash() {
      if (await rpc('getGenesisHash') !== GENESIS) throw new Error('Silver cluster mismatch');
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: latest.value.blockhash,
        lastValidBlockHeight: Number(latest.value.lastValidBlockHeight) };
    },
    async signGuardedProgression(accountId, operationId, approvedCandidate = null) {
      if (!progressionPool || typeof progressionReader?.readRingForIssuance !== 'function')
        throw new Error('Silver progression attestation unavailable');
      let preparation = await readPreparedSilver(progressionPool, accountId, operationId);
      const observed = await progressionReader.readRingForIssuance({ programId,
        cluster: 'devnet', issuanceId: preparation.issuance_id,
        walletAddress: preparation.wallet_address });
      if (!observed || observed.mintAddress !== preparation.mint_address ||
          observed.tokenOwner !== preparation.wallet_address ||
          observed.level !== preparation.expected_level ||
          BigInt(observed.cooldownUntilUnixSeconds) > BigInt(Math.floor(Date.now() / 1000)))
        throw new Error('Silver progression chain state changed');
      if (await silverRingIsListed(marketReader, preparation.mint_address))
        throw new Error('Silver Ring is listed');
      preparation = await readPreparedSilver(progressionPool, accountId, operationId);
      // Recheck the immutable program/config pin and exact owned token account
      // before returning an issuer signature for the user's separate approval.
      const config = await pda(programId, utf8('silver-config'));
      await pinnedProgram({ config, collection: await pda(programId, utf8('silver-collection')),
        programdata: await pda(LOADER, rawAddress(programId)) });
      const tokenAddress = await ownedToken(preparation.wallet_address,
        preparation.mint_address);
      const paid = [5, 20].includes(preparation.target_level);
      let payment = {};
      if (paid) {
        const gatewayConfig = await pda(GATEWAY, utf8('eru-config'));
        const liveConfig = await account(gatewayConfig);
        if (liveConfig?.owner !== GATEWAY || liveConfig.bytes.length !== 330 ||
            liveConfig.bytes[0] !== 1 || liveConfig.bytes[169] !== 0 ||
            liveConfig.bytes.readBigUInt64LE(322) < 1n)
          throw new Error('Silver Gateway config unavailable');
        const gatewayNonce = await pda(GATEWAY, utf8('nonce'),
          rawAddress(gatewayConfig), rawAddress(preparation.wallet_address));
        const liveNonce = await account(gatewayNonce);
        if (liveNonce && (liveNonce.owner !== GATEWAY || liveNonce.bytes.length !== 8))
          throw new Error('Silver Gateway nonce invalid');
        const minimumNonce = liveNonce ? liveNonce.bytes.readBigUInt64LE(0) + 1n : 1n;
        const slot = Number(await rpc('getSlot', [{ commitment: 'finalized' }]));
        if (!Number.isSafeInteger(slot) || slot < 1 ||
            minimumNonce > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error('Silver Gateway slot or nonce invalid');
        if (approvedCandidate) {
          if (approvedCandidate.gatewayProgramId !== GATEWAY ||
              approvedCandidate.gatewayConfigBase64 !== liveConfig.bytes.toString('base64') ||
              !Number.isSafeInteger(approvedCandidate.nonce) ||
              BigInt(approvedCandidate.nonce) !== minimumNonce ||
              !Number.isSafeInteger(approvedCandidate.expirySlot) ||
              approvedCandidate.expirySlot <= slot ||
              approvedCandidate.expirySlot > slot + 300)
            throw new Error('Silver paid intent expired or changed');
        }
        payment = { gatewayConfigData: liveConfig.bytes,
          nonce: approvedCandidate?.nonce ?? Number(minimumNonce),
          expirySlot: approvedCandidate?.expirySlot ?? slot + 300 };
      }
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const candidate = await buildSilverProgressionMessage({ preparation,
        programId, issuerAddress, tokenAddress, cluster: 'devnet',
        genesisHash: GENESIS, blockhash: latest.value.blockhash,
        lastValidBlockHeight: Number(latest.value.lastValidBlockHeight), ...payment });
      // Check the complete current transition before asking the wallet to sign.
      // Signature verification is disabled only for this read-only simulation.
      const unsigned = Buffer.concat([Buffer.from([2]), Buffer.alloc(128),
        Buffer.from(candidate.messageBase64, 'base64')]).toString('base64');
      const simulation = (await rpc('simulateTransaction', [unsigned, {
        encoding: 'base64', commitment: 'confirmed', minContextSlot: latest.context.slot,
        sigVerify: false, replaceRecentBlockhash: false,
      }])).value;
      if (simulation.err) {
        const insufficient = /InsufficientFundsFor(Fee|Rent)|insufficient lamports/i.test(
          `${JSON.stringify(simulation.err)} ${simulation.logs?.join(' ') ?? ''}`);
        const error = new Error(insufficient ? 'SILVER_SOL_INSUFFICIENT' :
          'Silver progression simulation rejected');
        if (insufficient) error.code = 'SILVER_SOL_INSUFFICIENT';
        throw error;
      }
      const issuerSignature = sign(null, Buffer.from(candidate.messageBase64, 'base64'), issuerKey);
      return { candidate, issuerSignatureBase64: issuerSignature.toString('base64') };
    },
    async build(row) {
      const draw = row.issuance_source === 'draw';
      const admin = row.issuance_source === 'admin-grant';
      const expected = admin
        ? adminBoxIdentity(row.account_id, row.wallet_address, row.admin_operation_id)
        : draw
        ? drawBoxIdentity(row.account_id, row.wallet_address, row.draw_result_id)
        : firstEntryIdentity(row.account_id, row.wallet_address, 'devnet');
      if (row.cluster !== 'devnet' || row.status !== 'pending' ||
          row.issuance_id !== expected.issuanceId ||
          row.entitlement_digest !== expected.entitlementDigest)
        throw new Error('Silver issuance row binding mismatch');
      const ids = await identities(row);
      await pinnedProgram(ids);
      if (await account(ids.state) || await account(ids.mint) ||
          await account(ids.lifecycle) || await account(ids.extraMetas))
        throw new Error('Silver issuance account exists; reconcile before retry');
      const tokenKey = generateKeyPairSync('ed25519');
      const tokenAddress = signerAddress(tokenKey.privateKey);
      const media = Buffer.from(BOX_URI, 'ascii');
      const uriOffset = draw || admin ? 131 : 115;
      const data = Buffer.alloc(uriOffset + media.length);
      data[0] = admin ? 21 : draw ? 19 : 0;
      Buffer.from(row.account_id.replaceAll('-', ''), 'hex').copy(data, 1);
      Buffer.from(row.issuance_id, 'hex').copy(data, 17);
      Buffer.from(row.entitlement_digest, 'hex').copy(data, 49);
      Buffer.from(BOX_HASH, 'hex').copy(data, 81);
      if (draw) Buffer.from(row.draw_result_id.replaceAll('-', ''), 'hex').copy(data, 113);
      if (admin) Buffer.from(row.admin_operation_id.replaceAll('-', ''), 'hex').copy(data, 113);
      data.writeUInt16LE(media.length, uriOffset - 2);
      media.copy(data, uriOffset);
      const accounts = [
        accountMeta(issuerAddress, AccountRole.WRITABLE_SIGNER),
        accountMeta(ids.config, AccountRole.READONLY),
        accountMeta(ids.mint, AccountRole.WRITABLE),
        accountMeta(ids.state, AccountRole.WRITABLE),
        accountMeta(tokenAddress, AccountRole.WRITABLE_SIGNER),
        accountMeta(row.wallet_address, AccountRole.READONLY),
        accountMeta(ids.authority, AccountRole.READONLY),
        accountMeta(TOKEN_2022_PROGRAM_ADDRESS, AccountRole.READONLY),
        accountMeta(SYSTEM, AccountRole.READONLY),
        accountMeta(ids.collection, AccountRole.READONLY),
        accountMeta(ids.extraMetas, AccountRole.WRITABLE),
        accountMeta(ids.lifecycle, AccountRole.WRITABLE),
        accountMeta(ids.series, AccountRole.WRITABLE),
      ];
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayer(address(issuerAddress), message);
      message = setTransactionMessageLifetimeUsingBlockhash({
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
      }, message);
      message = appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 600_000 }), {
        programAddress: address(programId), data, accounts,
      }], message);
      const compiled = compileTransactionMessage(message);
      const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
      const signers = new Map([[issuerAddress, issuerKey], [tokenAddress, tokenKey.privateKey]]);
      const signatures = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts)
        .map(key => {
          const selected = signers.get(key);
          if (!selected) throw new Error('Silver issuance unexpected signer');
          return sign(null, bytes, selected);
        });
      if (signatures.length !== 2) throw new Error('Silver issuance signer graph mismatch');
      const raw = Buffer.concat([Buffer.from([2]), ...signatures, bytes]).toString('base64');
      const simulation = (await rpc('simulateTransaction', [raw, {
        encoding: 'base64', commitment: 'confirmed', minContextSlot: latest.context.slot,
        sigVerify: true, innerInstructions: true,
      }])).value;
      if (simulation.err) throw new Error(`Silver issuance simulation rejected: ${JSON.stringify(simulation.err)} ${JSON.stringify(simulation.logs)}`);
      return { signature: bs58.encode(signatures[0]), rawTransactionBase64: raw,
        blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight,
        mintAddress: ids.mint, tokenAddress, issuerAddress, unitsConsumed: simulation.unitsConsumed };
    },
    async send(attempt) {
      return rpc('sendTransaction', [attempt.raw_transaction_base64, {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
        maxRetries: 0,
      }]);
    },
    async status(signature) {
      return (await rpc('getSignatureStatuses', [[signature],
        { searchTransactionHistory: true }])).value[0];
    },
    async blockHeight() {
      return rpc('getBlockHeight', [{ commitment: 'finalized' }]);
    },
    async isBlockhashValid(blockhash) {
      return (await rpc('isBlockhashValid', [blockhash,
        { commitment: 'confirmed' }])).value;
    },
  };
}
