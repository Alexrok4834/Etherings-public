import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageEncoder, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const SYSTEM = address('11111111111111111111111111111111');
const COMPUTE = address('ComputeBudget111111111111111111111111111111');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const U64_MAX = (1n << 64n) - 1n;
const W = AccountRole.WRITABLE;
const R = AccountRole.READONLY;
const WS = AccountRole.WRITABLE_SIGNER;
const meta = (value, role) => ({ address: address(value), role });
const utf8 = text => new TextEncoder().encode(text);
const keyBytes = key => getAddressEncoder().encode(address(key));
const u64 = number => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(number);
  return bytes;
};
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: program, seeds,
}))[0];

function requireSaleIntent({ marketProgramId, silverProgramId, kind, nonce,
  lastValidBlockHeight }) {
  if (!['SILVER_RING', 'SILVER_BOX'].includes(kind) ||
      !Number.isSafeInteger(nonce) || nonce < 1 ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Invalid sale intent');
  const program = address(marketProgramId);
  const silver = address(silverProgramId);
  if (program === silver) throw new Error('Marketplace must be separate from Silver Hook');
  return { program, silver };
}

function compileOneSigner(program, signer, instructions, blockhash, lastValidBlockHeight) {
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(signer, message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(blockhash), lastValidBlockHeight: BigInt(lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 1 || compiled.staticAccounts[0] !== signer)
    throw new Error('Unexpected marketplace signer graph');
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const sizeBytes = 65 + bytes.length;
  if (sizeBytes > 1232) throw new Error('Marketplace transaction exceeds current legacy path');
  return { messageBase64: bytes.toString('base64'), sizeBytes };
}

export async function buildSilverMarketplaceListMessage({ marketProgramId, silverProgramId,
  mintAddress, kind, sellerAddress, sourceTokenAddress, priceLamports, nonce,
  blockhash, lastValidBlockHeight }) {
  const { program, silver } = requireSaleIntent({ marketProgramId, silverProgramId,
    kind, nonce, lastValidBlockHeight });
  const mint = address(mintAddress);
  const seller = address(sellerAddress);
  const source = address(sourceTokenAddress);
  const price = exactSilverSaleLegs(priceLamports).price;
  const config = await pda(program, utf8('silver-market-config'));
  const listing = await pda(program, utf8('silver-market-listing'), keyBytes(mint));
  const authority = await pda(program, utf8('silver-market-authority'));
  const state = await pda(silver, utf8(kind === 'SILVER_RING'
    ? 'silver-ring-state' : 'silver-state'), keyBytes(mint));
  const lifecycle = kind === 'SILVER_BOX'
    ? await pda(silver, utf8('silver-lifecycle'), keyBytes(mint)) : SYSTEM;
  const [extra] = await findExtraAccountMetaListPda({ mint }, { programAddress: silver });
  const silverProgramdata = await pda(UPGRADEABLE_LOADER, keyBytes(silver));
  const marketProgramdata = await pda(UPGRADEABLE_LOADER, keyBytes(program));
  const ix = { programAddress: program,
    data: Buffer.concat([Buffer.from([22]), u64(price), u64(BigInt(nonce))]),
    accounts: [meta(seller, WS), meta(config, R), meta(mint, R), meta(state, R),
      meta(lifecycle, R), meta(source, W), meta(listing, W), meta(authority, R),
      meta(extra, W), meta(TOKEN_2022_PROGRAM_ADDRESS, R), meta(SYSTEM, R),
      meta(silver, R), meta(silverProgramdata, R), meta(program, R),
      meta(marketProgramdata, R)] };
  return { ...compileOneSigner(program, seller, [ix], blockhash, lastValidBlockHeight),
    config, listing, authority, state, lifecycle, extra, silverProgramdata,
    marketProgramdata, priceLamports: price.toString() };
}

export async function buildSilverMarketplaceCancelMessage({ marketProgramId, mintAddress,
  sellerAddress, sourceTokenAddress, nonce, blockhash, lastValidBlockHeight }) {
  if (!Number.isSafeInteger(nonce) || nonce < 1 ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Invalid sale intent');
  const program = address(marketProgramId);
  const seller = address(sellerAddress);
  const source = address(sourceTokenAddress);
  const listing = await pda(program, utf8('silver-market-listing'), keyBytes(mintAddress));
  const ix = { programAddress: program,
    data: Buffer.concat([Buffer.from([23]), u64(BigInt(nonce))]),
    accounts: [meta(seller, WS), meta(listing, W), meta(source, W),
      meta(TOKEN_2022_PROGRAM_ADDRESS, R)] };
  return { ...compileOneSigner(program, seller, [ix], blockhash, lastValidBlockHeight),
    listing };
}

export function exactSilverSaleLegs(price) {
  const p = typeof price === 'bigint' ? price :
    typeof price === 'string' && /^[1-9][0-9]*$/.test(price) ? BigInt(price) : 0n;
  if (p < 1n || p > U64_MAX) throw new Error('Invalid lamport price');
  const royalty = (p * 400n + 9_999n) / 10_000n;
  const platform = (p * 200n + 9_999n) / 10_000n;
  const total = p + royalty + platform;
  if (total > U64_MAX) throw new Error('Buyer debit exceeds u64');
  return { price: p, royalty, platform, total };
}

// This pure compiler does not sign or broadcast. The caller must supply a
// finalized, identity-verified listing, pinned recipients and fresh blockhash.
// Backend and Android compare the complete refreshed message before signing.
export async function buildSilverMarketplaceBuyMessage({ marketProgramId, silverProgramId, mintAddress,
  kind, sellerAddress, sourceTokenAddress, buyerAddress, royaltyAddress,
  platformAddress, priceLamports, nonce, blockhash, lastValidBlockHeight,
  createBuyerAta = false }) {
  const { program, silver } = requireSaleIntent({ marketProgramId, silverProgramId,
    kind, nonce, lastValidBlockHeight });
  const mint = address(mintAddress);
  const buyer = address(buyerAddress);
  const seller = address(sellerAddress);
  const source = address(sourceTokenAddress);
  const royaltyRecipient = address(royaltyAddress);
  const platformRecipient = address(platformAddress);
  if (buyer === seller || [royaltyRecipient, platformRecipient].some(
    recipient => recipient === buyer || recipient === seller))
    throw new Error('Overlapping sale recipients');
  const legs = exactSilverSaleLegs(priceLamports);
  const listing = await pda(program, utf8('silver-market-listing'), keyBytes(mint));
  const authority = await pda(program, utf8('silver-market-authority'));
  const state = await pda(silver, utf8(kind === 'SILVER_RING'
    ? 'silver-ring-state' : 'silver-state'), keyBytes(mint));
  const lifecycle = kind === 'SILVER_BOX'
    ? await pda(silver, utf8('silver-lifecycle'), keyBytes(mint)) : SYSTEM;
  const [extra] = await findExtraAccountMetaListPda({ mint }, { programAddress: silver });
  const [destination] = await findAssociatedTokenPda({ mint, owner: buyer,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  if (source === destination) throw new Error('Buyer already owns source account');
  const accounts = [
    meta(buyer, WS), meta(seller, W), meta(royaltyRecipient, W),
    meta(platformRecipient, W), meta(source, W), meta(destination, W),
    meta(mint, R), meta(state, W), meta(lifecycle, kind === 'SILVER_BOX' ? W : R), meta(extra, R),
    meta(listing, W), meta(authority, R), meta(TOKEN_2022_PROGRAM_ADDRESS, R),
    meta(SYSTEM, R), meta(program, R), meta(silver, R),
  ];
  const buy = { programAddress: program,
    data: Buffer.concat([Buffer.from([24]), u64(BigInt(nonce)), u64(legs.price)]),
    accounts };
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(1_300_000, 1);
  const instructions = [{ programAddress: COMPUTE, data: limit, accounts: [] }];
  if (createBuyerAta) {
    instructions.push({ programAddress: ATA_PROGRAM, data: Buffer.from([1]),
      accounts: [meta(buyer, WS), meta(destination, W), meta(buyer, R),
        meta(mint, R), meta(SYSTEM, R), meta(TOKEN_2022_PROGRAM_ADDRESS, R)] });
  }
  instructions.push(buy);
  return { ...compileOneSigner(program, buyer, instructions, blockhash, lastValidBlockHeight),
    listing, authority, state, lifecycle, extra, destination,
    priceLamports: legs.price.toString(), royaltyLamports: legs.royalty.toString(),
    platformLamports: legs.platform.toString(), buyerDebitLamports: legs.total.toString() };
}
