import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder, getInstructionsFromCompiledTransactionMessage,
  getProgramDerivedAddress, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { cooperBreedingPrice } from './cooper-breeding-price.js';
import { breedingBoxIdentity } from './cooper-breeding.js';
import { canonicalErt } from './m2e-ert-decimal.js';

const SILVER = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const SYSTEM = '11111111111111111111111111111111';
const INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const R = AccountRole.READONLY;
const W = AccountRole.WRITABLE;
const RS = AccountRole.READONLY_SIGNER;
const WS = AccountRole.WRITABLE_SIGNER;
const utf8 = value => new TextEncoder().encode(value);
const meta = (key, role) => ({ address: address(key), role });
const uuid = value => {
  if (typeof value !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new Error('Invalid breeding UUID');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
};
const u64 = value => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

// Unsigned candidate. Caller must re-read the PostgreSQL hold and canonical
// chain config/replay/blockhash immediately before a guarded attestor signs.
export async function buildCooperBreedingCandidateMessage({ preparation, gatewayProgramId,
  configOwner, configData, genesisHash, blockhash, lastValidBlockHeight,
  nonce, expirySlot }) {
  if (!preparation || preparation.cluster !== 'devnet' ||
      genesisHash !== GENESIS || preparation.reservation_state !== 'held' ||
      !Number.isSafeInteger(nonce) || nonce < 1 ||
      !Number.isSafeInteger(expirySlot) || expirySlot < 1 ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Unverified breeding candidate boundary');
  const gateway = address(gatewayProgramId);
  const wallet = address(preparation.wallet_address);
  if (configOwner !== gateway || !(configData instanceof Uint8Array) ||
      configData.length !== 330 || configData[0] !== 1 || configData[169] !== 0)
    throw new Error('Unverified breeding Gateway config');
  const raw = key => getAddressEncoder().encode(address(key));
  const fromConfig = start => address(bs58.encode(configData.subarray(start, start + 32)));
  const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
    programAddress: address(program), seeds,
  }))[0];
  const config = await pda(gateway, utf8('eru-config'));
  const mint = fromConfig(33);
  const treasury = fromConfig(65);
  const hook = fromConfig(97);
  const attestor = fromConfig(290);
  const epoch = Buffer.from(configData.subarray(322, 330)).readBigUInt64LE();
  if (epoch < 1n || attestor === wallet ||
      [mint, treasury, hook, attestor].some(key => key === SYSTEM))
    throw new Error('Invalid breeding Gateway authority');
  const price = cooperBreedingPrice(preparation.first_uses, preparation.second_uses);
  if (!price || canonicalErt(preparation.ert_cost) !== price.ertExact ||
      canonicalErt(preparation.eru_principal) !== price.eruPrincipalExact ||
      canonicalErt(preparation.eru_fee) !== price.eruFeeExact)
    throw new Error('Breeding price differs from authoritative matrix');
  const operation = uuid(preparation.id);
  const reservation = uuid(preparation.reservation_id);
  const account = uuid(preparation.account_id);
  const first = uuid(preparation.first_ring_id);
  const second = uuid(preparation.second_ring_id);
  const identity = breedingBoxIdentity(preparation.account_id,
    preparation.wallet_address, preparation.id,
    preparation.first_ring_id, preparation.second_ring_id,
    preparation.first_uses, preparation.second_uses);
  if (identity.issuanceId !== preparation.issuance_id ||
      identity.entitlementDigest !== preparation.entitlement_digest)
    throw new Error('Breeding Box identity differs from preparation');
  const [source] = await findAssociatedTokenPda({ mint, owner: wallet,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [list] = await findExtraAccountMetaListPda({ mint }, { programAddress: hook });
  const replay = await pda(gateway, utf8('nonce'), raw(config), raw(wallet));
  const operationReplay = await pda(gateway, utf8('cooper-breeding'),
    raw(config), raw(wallet), operation);
  const breedIssuer = await pda(gateway, utf8('cooper-breeding-issuer'));
  const silverConfig = await pda(SILVER, utf8('silver-config'));
  const boxMint = await pda(SILVER, utf8('silver-mint'),
    Buffer.from(identity.issuanceId, 'hex'));
  const boxState = await pda(SILVER, utf8('silver-state'), raw(boxMint));
  const boxToken = await pda(SILVER, utf8('silver-breeding-box-token'),
    Buffer.from(identity.issuanceId, 'hex'));
  const boxAuthority = await pda(SILVER, utf8('silver-authority'));
  const collection = await pda(SILVER, utf8('silver-collection'));
  const boxExtra = await pda(SILVER, utf8('extra-account-metas'), raw(boxMint));
  const lifecycle = await pda(SILVER, utf8('silver-lifecycle'), raw(boxMint));
  const series = await pda(SILVER, utf8('silver-nft-series'),
    Buffer.from([1]), Buffer.from([1]));
  const data = Buffer.concat([Buffer.from([5]), u64(price.eruPrincipalUnits),
    u64(nonce), u64(expirySlot), operation, reservation, account, first, second,
    Buffer.from([price.firstUses, price.secondUses]), u64(price.ertExact),
    u64(epoch), Buffer.from([1])]);
  if (data.length !== 124) throw new Error('Invalid breeding instruction length');
  const accounts = [meta(source, W), meta(mint, W), meta(treasury, W), meta(treasury, W),
    meta(wallet, RS), meta(attestor, RS), meta(config, W), meta(list, R),
    meta(INSTRUCTIONS, R), meta(TOKEN_2022_PROGRAM_ADDRESS, R), meta(hook, R),
    meta(replay, W), meta(wallet, WS), meta(SYSTEM, R), meta(operationReplay, W),
    meta(breedIssuer, W), meta(SILVER, R), meta(silverConfig, R), meta(boxMint, W),
    meta(boxState, W), meta(boxToken, W), meta(boxAuthority, R),
    meta(collection, R), meta(boxExtra, W), meta(lifecycle, W), meta(series, W)];
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(1_400_000, 1);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(wallet, message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address(blockhash),
    lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions([
    { programAddress: address(COMPUTE), data: limit, accounts: [] },
    { programAddress: gateway, data, accounts },
  ], message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 2 ||
      compiled.staticAccounts[0] !== wallet || compiled.staticAccounts[1] !== attestor)
    throw new Error('Breeding signer graph changed');
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const sizeBytes = 1 + 2 * 64 + bytes.length;
  if (sizeBytes > 1232) throw new Error(`Breeding candidate exceeds packet size: ${sizeBytes}`);
  const compiledIx = getInstructionsFromCompiledTransactionMessage(compiled)[1];
  const intentDigest = createHash('sha256').update(compiledIx.data).update(Buffer.from(
    compiledIx.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
  return { messageBase64: bytes.toString('base64'), sizeBytes, intentDigest,
    operationId: preparation.id, reservationId: preparation.reservation_id,
    issuanceId: identity.issuanceId, walletAddress: wallet,
    attestorAddress: attestor, gatewayProgramId: gateway, silverProgramId: SILVER,
    cluster: 'devnet', genesisHash, nonce, configEpoch: epoch.toString(),
    expirySlot, lastValidBlockHeight };
}

export function verifyCooperBreedingCandidateEnvelope(candidate) {
  try {
    if (!candidate || candidate.cluster !== 'devnet' ||
        candidate.genesisHash !== GENESIS ||
        !Number.isSafeInteger(candidate.nonce) || candidate.nonce < 1 ||
        !Number.isSafeInteger(candidate.expirySlot) || candidate.expirySlot < 1 ||
        !/^[a-f0-9]{64}$/.test(candidate.intentDigest ?? '') ||
        !/^[a-f0-9]{64}$/.test(candidate.issuanceId ?? '')) return false;
    const bytes = Buffer.from(candidate.messageBase64, 'base64');
    if (bytes.toString('base64') !== candidate.messageBase64 ||
        candidate.sizeBytes !== bytes.length + 129 || candidate.sizeBytes > 1232)
      return false;
    const decoded = getCompiledTransactionMessageDecoder().decode(bytes);
    if (decoded.header.numSignerAccounts !== 2 ||
        decoded.staticAccounts[0] !== candidate.walletAddress ||
        decoded.staticAccounts[1] !== candidate.attestorAddress) return false;
    const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
    if (instructions.length !== 2 ||
        instructions[0].programAddress !== COMPUTE ||
        instructions[1].programAddress !== candidate.gatewayProgramId ||
        instructions[1].accounts.length !== 26) return false;
    const data = Buffer.from(instructions[1].data);
    if (data.length !== 124 || data[0] !== 5 ||
        data.readBigUInt64LE(9) !== BigInt(candidate.nonce) ||
        data.readBigUInt64LE(17) !== BigInt(candidate.expirySlot) ||
        data.subarray(25, 41).toString('hex') !== candidate.operationId.replaceAll('-', '') ||
        data.subarray(41, 57).toString('hex') !== candidate.reservationId.replaceAll('-', '') ||
        data.readBigUInt64LE(115).toString() !== candidate.configEpoch ||
        instructions[1].accounts[16].address !== candidate.silverProgramId)
      return false;
    const digest = createHash('sha256').update(data).update(Buffer.from(
      instructions[1].accounts.map(({ address: key, role }) => `${key}:${role}`).join('|')))
      .digest('hex');
    return digest === candidate.intentDigest;
  } catch { return false; }
}
