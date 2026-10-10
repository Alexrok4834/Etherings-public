import { createHash, timingSafeEqual } from 'node:crypto';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage,
  getProgramDerivedAddress, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import bs58 from 'bs58';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const SYSTEM = address('11111111111111111111111111111111');
const COMPUTE = address('ComputeBudget111111111111111111111111111111');
const INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');
const GATEWAY = address('Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const meta = (key, role) => ({ address: address(key), role });
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new Error('Invalid Silver progression identity');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
};
const decimalUnits = value => {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(text))
    throw new Error('Invalid Silver exact ERU price');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
};

// The caller must have revalidated the bound wallet, held PostgreSQL ERT
// reservation, finalized Ring owner/state and pinned Silver config before
// asking the existing issuer to sign. This compiler never signs or broadcasts.
export async function buildSilverProgressionMessage({ preparation, programId, issuerAddress,
  tokenAddress, cluster, genesisHash, blockhash, lastValidBlockHeight,
  gatewayConfigData, nonce, expirySlot }) {
  if (!preparation || cluster !== 'devnet' || preparation.cluster !== cluster ||
      genesisHash !== DEVNET_GENESIS || preparation.status !== 'prepared' ||
      preparation.reservation_state !== 'held' ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Unverified Silver progression preparation');
  const operation = uuid(preparation.operation_id);
  const reservation = uuid(preparation.reservation_id);
  const account = uuid(preparation.account_id);
  const current = Number(preparation.expected_level);
  const target = Number(preparation.target_level);
  const cost = Number(preparation.ert_cost);
  if (!(current >= 1 && current < 20 && target === current + 1) ||
      cost !== 5 * (target + 1) ||
      !Number.isSafeInteger(cost) ||
      [operation, reservation, account].some(value => value.every(byte => byte === 0)))
    throw new Error('Invalid Silver transition or ERT price');

  const program = address(programId);
  const wallet = address(preparation.wallet_address);
  const issuer = address(issuerAddress);
  const mint = address(preparation.mint_address);
  const token = address(tokenAddress);
  if (wallet === issuer || wallet === program || issuer === program)
    throw new Error('Silver signer graph overlaps');
  const raw = value => getAddressEncoder().encode(value);
  const derive = async (...seeds) => (await getProgramDerivedAddress({
    programAddress: program, seeds,
  }))[0];
  const config = await derive(new TextEncoder().encode('silver-config'));
  const ring = await derive(new TextEncoder().encode('silver-ring-state'), raw(mint));
  const replay = await derive(new TextEncoder().encode('silver-progress'), raw(mint), operation);
  const costBytes = Buffer.alloc(8);
  costBytes.writeBigUInt64LE(BigInt(cost));
  const paid = target === 5 || target === 20;
  const extra = paid ? await paidAccounts() : null;
  const data = Buffer.concat([Buffer.from([paid ? 18 : 16, current, target]), operation,
    reservation, account, costBytes, ...(paid ? [u64(BigInt(nonce)),
      u64(BigInt(expirySlot)), u64(extra.epoch)] : [])]);
  if (data.length !== (paid ? 83 : 59)) throw new Error('Invalid Silver instruction length');
  const accounts = [meta(wallet, AccountRole.WRITABLE_SIGNER),
    meta(issuer, AccountRole.READONLY_SIGNER), meta(config, AccountRole.READONLY),
    meta(mint, AccountRole.READONLY), meta(ring, AccountRole.WRITABLE),
    meta(token, AccountRole.READONLY), meta(replay, AccountRole.WRITABLE),
    meta(SYSTEM, AccountRole.READONLY), ...(paid ? extra.accounts : [])];
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(paid ? 800_000 : 300_000, 1);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(wallet, message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(blockhash), lastValidBlockHeight: BigInt(lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([
    { programAddress: COMPUTE, data: limit, accounts: [] },
    { programAddress: program, data, accounts },
  ], message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 2 || compiled.staticAccounts[0] !== wallet ||
      compiled.staticAccounts[1] !== issuer)
    throw new Error('Unexpected Silver signer graph');
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const sizeBytes = 1 + 2 * 64 + bytes.length;
  if (sizeBytes > 1232) throw new Error('Silver progression transaction exceeds packet size');
  const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[1];
  const intentDigest = createHash('sha256').update(instruction.data).update(Buffer.from(
    instruction.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
  return { messageBase64: bytes.toString('base64'), sizeBytes, intentDigest,
    operationId: preparation.operation_id, reservationId: preparation.reservation_id,
    accountId: preparation.account_id, walletAddress: wallet, issuerAddress: issuer,
    mintAddress: mint, tokenAddress: token, ringAddress: ring,
    currentLevel: current, targetLevel: target, ertCost: String(cost),
    programId: program, cluster, genesisHash, lastValidBlockHeight,
    ...(paid ? { gatewayProgramId: GATEWAY,
      gatewayConfigBase64: Buffer.from(gatewayConfigData).toString('base64'),
      nonce, expirySlot, configEpoch: extra.epoch.toString(),
      eruPrincipal: target === 5 ? '38' : '75',
      eruFee: target === 5 ? '0.76' : '1.50' } : {}) };

  async function paidAccounts() {
    if (!(gatewayConfigData instanceof Uint8Array) || gatewayConfigData.length !== 330 ||
        gatewayConfigData[0] !== 1 || gatewayConfigData[169] !== 0 ||
        !Number.isSafeInteger(nonce) || nonce < 1 ||
        !Number.isSafeInteger(expirySlot) || expirySlot < 1)
      throw new Error('Invalid Silver Gateway state');
    const fromConfig = start => address(bs58.encode(gatewayConfigData.subarray(start, start + 32)));
    const eruMint = fromConfig(33);
    const treasury = fromConfig(65);
    const hook = fromConfig(97);
    const epoch = Buffer.from(gatewayConfigData.subarray(322, 330)).readBigUInt64LE();
    if (epoch < 1n || issuer === wallet ||
        decimalUnits(preparation.eru_principal) !==
          (target === 5 ? 38_000_000_000n : 75_000_000_000n) ||
        decimalUnits(preparation.eru_fee) !==
          (target === 5 ? 760_000_000n : 1_500_000_000n))
      throw new Error('Invalid Silver Gateway price or signer');
    const gatewayPda = async (...seeds) => (await getProgramDerivedAddress({
      programAddress: GATEWAY, seeds,
    }))[0];
    const gatewayConfig = await gatewayPda(new TextEncoder().encode('eru-config'));
    const gatewayNonce = await gatewayPda(new TextEncoder().encode('nonce'),
      raw(gatewayConfig), raw(wallet));
    const gatewayOperation = await gatewayPda(new TextEncoder().encode('silver-level-up'),
      raw(gatewayConfig), raw(wallet), operation);
    const authority = await derive(new TextEncoder().encode('silver-paid-gateway'));
    const [source] = await findAssociatedTokenPda({ mint: eruMint, owner: wallet,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [list] = await findExtraAccountMetaListPda({ mint: eruMint },
      { programAddress: hook });
    return { epoch, accounts: [meta(GATEWAY, AccountRole.READONLY),
      meta(gatewayConfig, AccountRole.WRITABLE), meta(source, AccountRole.WRITABLE),
      meta(eruMint, AccountRole.WRITABLE), meta(treasury, AccountRole.WRITABLE),
      meta(list, AccountRole.READONLY), meta(INSTRUCTIONS, AccountRole.READONLY),
      meta(TOKEN_2022_PROGRAM_ADDRESS, AccountRole.READONLY),
      meta(hook, AccountRole.READONLY), meta(gatewayNonce, AccountRole.WRITABLE),
      meta(gatewayOperation, AccountRole.WRITABLE),
      meta(authority, AccountRole.READONLY)] };
  }
}

const u64 = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};

export function sameSilverProgressionIntent(approved, refreshed) {
  const first = Buffer.from(approved?.intentDigest ?? '', 'hex');
  const second = Buffer.from(refreshed?.intentDigest ?? '', 'hex');
  return first.length === 32 && second.length === 32 && timingSafeEqual(first, second) &&
    ['operationId', 'reservationId', 'accountId', 'walletAddress', 'issuerAddress',
      'mintAddress', 'tokenAddress', 'ringAddress', 'currentLevel', 'targetLevel',
      'ertCost', 'programId', 'cluster', 'genesisHash', 'gatewayProgramId',
      'gatewayConfigBase64', 'nonce', 'expirySlot', 'configEpoch',
      'eruPrincipal', 'eruFee'].every(
      key => approved[key] === refreshed[key]);
}

export async function verifySilverProgressionCandidateMessage(candidate, preparation, programId) {
  try {
    if (!candidate || candidate.programId !== programId ||
        candidate.operationId !== preparation.operation_id ||
        candidate.reservationId !== preparation.reservation_id ||
        candidate.accountId !== preparation.account_id ||
        candidate.walletAddress !== preparation.wallet_address ||
        candidate.mintAddress !== preparation.mint_address) return false;
    const bytes = Buffer.from(candidate.messageBase64, 'base64');
    if (bytes.toString('base64') !== candidate.messageBase64) return false;
    const message = getCompiledTransactionMessageDecoder().decode(bytes);
    const expected = await buildSilverProgressionMessage({ preparation, programId,
      issuerAddress: candidate.issuerAddress, tokenAddress: candidate.tokenAddress,
      cluster: candidate.cluster, genesisHash: candidate.genesisHash,
      blockhash: message.lifetimeToken,
      lastValidBlockHeight: candidate.lastValidBlockHeight,
      ...(candidate.targetLevel === 5 || candidate.targetLevel === 20 ? {
        gatewayConfigData: Buffer.from(candidate.gatewayConfigBase64, 'base64'),
        nonce: candidate.nonce, expirySlot: candidate.expirySlot } : {}) });
    return bytes.equals(Buffer.from(expected.messageBase64, 'base64')) &&
      sameSilverProgressionIntent(candidate, expected) &&
      candidate.sizeBytes === expected.sizeBytes;
  } catch { return false; }
}
