import { createHash, timingSafeEqual } from 'node:crypto';
import bs58 from 'bs58';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const COMPUTE = address('ComputeBudget111111111111111111111111111111');
const SYSTEM = address('11111111111111111111111111111111');
const INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const meta = (key, role) => ({ address: address(key), role });
const R = AccountRole.READONLY;
const W = AccountRole.WRITABLE;
const RS = AccountRole.READONLY_SIGNER;
const WS = AccountRole.WRITABLE_SIGNER;

function uuidBytes(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid Cooper UUID');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function units(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value))
    throw new Error('Invalid exact ERU amount');
  const [whole, fraction = ''] = value.split('.');
  const base18 = BigInt(whole) * 1_000_000_000_000_000_000n +
    BigInt(fraction.padEnd(18, '0') || '0');
  if (base18 % 1_000_000_000n !== 0n)
    throw new Error('ERU amount exceeds mint precision');
  return base18 / 1_000_000_000n;
}

function exactErt(value) {
  if (typeof value !== 'string' || !/^(?:24|84)(?:\.0{1,18})?$/.test(value))
    throw new Error('Invalid exact Cooper ERT cost');
  return Number(value.split('.')[0]);
}

function u64(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

// Internal unsigned candidate only. The caller must still read/verify current
// PostgreSQL preparation, chain config, replay state and blockhash before any
// backend attestation or user signing. No HTTP route or signer uses this module.
export async function buildCooperEruCandidateMessage({ preparation, cluster, genesisHash,
  expectedGenesisHash, gatewayProgramId, configOwner, configData, blockhash,
  lastValidBlockHeight, nonce, expirySlot }) {
  if (!preparation || !['local-validator', 'devnet'].includes(cluster) ||
      preparation.cluster !== cluster ||
      (cluster === 'devnet' && expectedGenesisHash !== DEVNET_GENESIS) ||
      genesisHash !== expectedGenesisHash ||
      preparation.status !== 'prepared' || preparation.reservation_state !== 'held' ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 ||
      !Number.isSafeInteger(expirySlot) || expirySlot < 1 ||
      !Number.isSafeInteger(nonce) || nonce < 1 || nonce === Number.MAX_SAFE_INTEGER)
    throw new Error('Unverified Cooper candidate boundary');
  address(genesisHash);
  const operationId = uuidBytes(preparation.operation_id);
  const reservationId = uuidBytes(preparation.reservation_id);
  const ringId = uuidBytes(preparation.ring_id);
  const accountId = uuidBytes(preparation.account_id);
  const current = Number(preparation.expected_level);
  const target = Number(preparation.target_level);
  const ert = exactErt(preparation.ert_cost);
  const principal = units(preparation.eru_principal);
  const fee = units(preparation.eru_fee);
  if (!((current === 4 && target === 5 && ert === 24 && principal === 30_000_000_000n) ||
        (current === 19 && target === 20 && ert === 84 && principal === 60_000_000_000n)) ||
      fee !== (principal * 200n + 9_999n) / 10_000n ||
      reservationId.every(byte => byte === 0))
    throw new Error('Cooper candidate price or reservation mismatch');

  const gateway = address(gatewayProgramId);
  const wallet = address(preparation.wallet_address);
  if (wallet === gateway || configOwner !== gateway ||
      !(configData instanceof Uint8Array) || configData.length !== 330 ||
      configData[0] !== 1 || configData[169] !== 0)
    throw new Error('Unverified Cooper Gateway config');
  const raw = key => getAddressEncoder().encode(address(key));
  const fromConfig = start => address(bs58.encode(configData.subarray(start, start + 32)));
  const [config] = await getProgramDerivedAddress({
    programAddress: gateway, seeds: [new TextEncoder().encode('eru-config')],
  });
  const mint = fromConfig(33);
  const treasury = fromConfig(65);
  const hook = fromConfig(97);
  const attestor = fromConfig(290);
  const epoch = Buffer.from(configData.subarray(322, 330)).readBigUInt64LE();
  if (epoch < 1n || attestor === wallet ||
      [mint, treasury, hook, attestor].some(key => key === SYSTEM))
    throw new Error('Invalid Cooper Gateway authority');
  const [source] = await findAssociatedTokenPda({ mint, owner: wallet,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [list] = await findExtraAccountMetaListPda({ mint }, { programAddress: hook });
  const pda = async (...seeds) => (await getProgramDerivedAddress({
    programAddress: gateway, seeds,
  }))[0];
  const replay = await pda(new TextEncoder().encode('nonce'), raw(config), raw(wallet));
  const operationReplay = await pda(new TextEncoder().encode('cooper-level-up'),
    raw(config), raw(wallet), operationId);
  const data = Buffer.concat([Buffer.from([1]), u64(principal), u64(BigInt(nonce)),
    u64(BigInt(expirySlot)), operationId, reservationId, ringId, accountId,
    Buffer.from([current, target]), u64(BigInt(ert)), Buffer.from([1]), u64(epoch)]);
  if (data.length !== 108) throw new Error('Invalid Cooper instruction length');
  const accounts = [meta(source, W), meta(mint, W), meta(treasury, W), meta(treasury, W),
    meta(wallet, RS), meta(attestor, RS), meta(config, W), meta(list, R),
    meta(INSTRUCTIONS, R), meta(TOKEN_2022_PROGRAM_ADDRESS, R), meta(hook, R),
    meta(replay, W), meta(wallet, WS), meta(SYSTEM, R), meta(operationReplay, W)];
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(600_000, 1);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(wallet, message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(blockhash), lastValidBlockHeight: BigInt(lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([
    { programAddress: COMPUTE, data: limit, accounts: [] },
    { programAddress: gateway, data, accounts },
  ], message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 2 || compiled.staticAccounts[0] !== wallet ||
      compiled.staticAccounts[1] !== attestor)
    throw new Error('Unexpected Cooper signer graph');
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  if (1 + 2 * 64 + bytes.length > 1232) throw new Error('Cooper candidate exceeds packet size');
  // Compilation coalesces the user's signer/writable role across duplicate
  // account metas; hash the actual compiled instruction, not input meta roles.
  const compiledIx = getInstructionsFromCompiledTransactionMessage(compiled)[1];
  const intentDigest = createHash('sha256').update(compiledIx.data).update(Buffer.from(
    compiledIx.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
  return { messageBase64: bytes.toString('base64'), intentDigest, sizeBytes: 1 + 2 * 64 + bytes.length,
    operationId: preparation.operation_id, reservationId: preparation.reservation_id,
    walletAddress: wallet, attestorAddress: attestor, gatewayProgramId: gateway,
    cluster, genesisHash, nonce, configEpoch: epoch.toString(), expirySlot,
    lastValidBlockHeight };
}

export function sameCooperEruIntent(first, refreshed) {
  const a = Buffer.from(first.intentDigest ?? '', 'hex');
  const b = Buffer.from(refreshed.intentDigest ?? '', 'hex');
  if (!(a.length === 32 && b.length === 32 && timingSafeEqual(a, b) &&
    first.cluster === refreshed.cluster && first.genesisHash === refreshed.genesisHash &&
    first.walletAddress === refreshed.walletAddress &&
    first.attestorAddress === refreshed.attestorAddress &&
    first.gatewayProgramId === refreshed.gatewayProgramId &&
    first.operationId === refreshed.operationId && first.reservationId === refreshed.reservationId))
    return false;
  try {
    const decode = value => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
      const bytes = Buffer.from(value, 'base64');
      if (bytes.toString('base64') !== value) return null;
      return getCompiledTransactionMessageDecoder().decode(bytes);
    };
    const original = decode(first.messageBase64);
    const next = decode(refreshed.messageBase64);
    if (!original || !next || original.staticAccounts[0] !== first.walletAddress ||
        next.staticAccounts[0] !== first.walletAddress) return false;
    const invariant = message => JSON.stringify({ header: message.header,
      accounts: message.staticAccounts,
      instructions: getInstructionsFromCompiledTransactionMessage(message).map(ix => ({
        program: ix.programAddress, data: [...ix.data], accounts: ix.accounts,
      })) });
    return invariant(original) === invariant(next);
  } catch { return false; }
}

export function verifyCooperEruCandidateEnvelope(candidate) {
  try {
    const bytes = Buffer.from(candidate.messageBase64, 'base64');
    if (bytes.toString('base64') !== candidate.messageBase64 ||
        bytes.length + 129 !== candidate.sizeBytes || candidate.sizeBytes > 1232)
      return false;
    const message = getCompiledTransactionMessageDecoder().decode(bytes);
    const instructions = getInstructionsFromCompiledTransactionMessage(message);
    const ix = instructions[1];
    if (message.header.numSignerAccounts !== 2 ||
        message.staticAccounts[0] !== candidate.walletAddress ||
        message.staticAccounts[1] !== candidate.attestorAddress ||
        instructions.length !== 2 || ix.programAddress !== candidate.gatewayProgramId ||
        ix.data?.length !== 108 || ix.accounts?.length !== 15 ||
        ix.accounts[4].address !== candidate.walletAddress ||
        ix.accounts[5].address !== candidate.attestorAddress ||
        ix.accounts[12].address !== candidate.walletAddress) return false;
    const data = Buffer.from(ix.data);
    if (data[0] !== 1 || data.subarray(25, 41).toString('hex') !==
        candidate.operationId.replaceAll('-', '') ||
        data.subarray(41, 57).toString('hex') !==
        candidate.reservationId.replaceAll('-', '') ||
        data.readBigUInt64LE(9) !== BigInt(candidate.nonce) ||
        data.readBigUInt64LE(17) !== BigInt(candidate.expirySlot) ||
        data.readBigUInt64LE(100) !== BigInt(candidate.configEpoch)) return false;
    const digest = createHash('sha256').update(data).update(Buffer.from(
      ix.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
    return digest === candidate.intentDigest;
  } catch { return false; }
}
