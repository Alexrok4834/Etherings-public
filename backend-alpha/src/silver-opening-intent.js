import { timingSafeEqual } from 'node:crypto';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageEncoder, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const ORAO = address('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
const COMPUTE = address('ComputeBudget111111111111111111111111111111');
const SYSTEM = address('11111111111111111111111111111111');
const INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');
const utf8 = value => new TextEncoder().encode(value);
const meta = (key, role) => ({ address: address(key), role });
const R = AccountRole.READONLY;
const W = AccountRole.WRITABLE;
const WS = AccountRole.WRITABLE_SIGNER;

export async function buildSilverOpeningCandidateMessage({ cluster, programId, walletAddress,
  mintAddress, userTokenAddress, escrowAddress, nextOperation, designVersion,
  oraoTreasury, seed, blockhash, lastValidBlockHeight, marketProgramId = null }) {
  const program = address(programId);
  const wallet = address(walletAddress);
  const mint = address(mintAddress);
  const userToken = address(userTokenAddress);
  const treasury = address(oraoTreasury);
  if (!['local-validator', 'devnet'].includes(cluster) ||
      !(seed instanceof Uint8Array) || seed.length !== 32 || seed.every(byte => byte === 0) ||
      !Number.isSafeInteger(nextOperation) || nextOperation < 1 ||
      !Number.isSafeInteger(designVersion) || designVersion < 1 ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) {
    throw new Error('Invalid candidate Silver opening inputs');
  }
  const raw = key => getAddressEncoder().encode(key);
  const u64 = value => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes;
  };
  const pda = async (id, ...seeds) => (await getProgramDerivedAddress({
    programAddress: id, seeds,
  }))[0];
  const config = await pda(program, utf8('silver-config'));
  const collection = await pda(program, utf8('silver-collection'));
  const design = await pda(program, utf8('silver-design-set'), u64(designVersion));
  const state = await pda(program, utf8('silver-state'), raw(mint));
  const lifecycle = await pda(program, utf8('silver-lifecycle'), raw(mint));
  const operation = await pda(program, utf8('silver-open'), raw(mint), u64(nextOperation));
  const escrowAuthority = await pda(program, utf8('silver-escrow'), raw(mint));
  const [escrow] = await findAssociatedTokenPda({ mint, owner: escrowAuthority,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [extra] = await findExtraAccountMetaListPda({ mint }, { programAddress: program });
  const market = marketProgramId ? address(marketProgramId) : null;
  const listing = market ? await pda(market, utf8('silver-market-listing'), raw(mint)) : null;
  const network = await pda(ORAO, utf8('orao-vrf-network-configuration'));
  const request = await pda(ORAO, utf8('orao-vrf-randomness-request'), seed);
  if (address(escrowAddress) !== escrow || userToken === escrow) {
    throw new Error('Candidate Silver escrow binding mismatch');
  }

  const accounts = [meta(wallet, WS), meta(mint, R), meta(userToken, W),
    meta(escrow, W), meta(state, W), meta(lifecycle, W), meta(extra, R),
    meta(operation, W), meta(config, R), meta(design, R), meta(collection, R),
    meta(network, W), meta(treasury, W), meta(request, W), meta(ORAO, R),
    meta(TOKEN_2022_PROGRAM_ADDRESS, R), meta(INSTRUCTIONS, R), meta(SYSTEM, R)];
  if (market) accounts.push(meta(market, R), meta(listing, W));
  const prepare = { programAddress: program, data: Buffer.concat([Buffer.from([12]), seed]),
    accounts };
  const transferData = Buffer.alloc(10);
  transferData[0] = 12;
  transferData.writeBigUInt64LE(1n, 1);
  const transfer = { programAddress: TOKEN_2022_PROGRAM_ADDRESS, data: transferData,
    accounts: [meta(userToken, W), meta(mint, R), meta(escrow, W), meta(wallet, WS),
      meta(extra, R), meta(state, W), meta(lifecycle, W),
      ...(market ? [meta(market, R), meta(listing, W)] : []), meta(program, R)] };
  const commit = { programAddress: program,
    data: Buffer.concat([Buffer.from([13]), seed]), accounts };
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(1_300_000, 1);
  const budget = { programAddress: COMPUTE, data: limit, accounts: [] };
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(wallet, message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(blockhash), lastValidBlockHeight: BigInt(lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([budget, prepare, transfer, commit], message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 1 || compiled.staticAccounts[0] !== wallet) {
    throw new Error('Unexpected candidate Silver signer graph');
  }
  return { cluster, messageBase64: Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled))
    .toString('base64'), operation, request, escrow, programId, walletAddress,
    mintAddress, nextOperation, designVersion };
}

export async function verifySilverOpeningCandidateMessage(input, messageBase64) {
  if (typeof messageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(messageBase64)) {
    return false;
  }
  const bytes = Buffer.from(messageBase64, 'base64');
  if (bytes.toString('base64') !== messageBase64) return false;
  const expected = Buffer.from((await buildSilverOpeningCandidateMessage(input))
    .messageBase64, 'base64');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}
