import { createHash } from 'node:crypto';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageEncoder, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  getMintDecoder, getTokenDecoder, getTransferCheckedInstruction,
  resolveExtraAccountMetasForExecute, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { verifiedSilverDirectTransferEam } from './silver-chain.js';

const SILVER = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const MARKET = 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j';
const SYSTEM = address('11111111111111111111111111111111');
const ATA = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const bytes = raw => raw && Buffer.from(raw.data[0], 'base64');
const meta = (value, role) => ({ address: address(value), role });

// The pinned 0.18.0 resolver returns [configured metas, Hook, EAM], whereas
// Token-2022 Execute and canonical Silver Hook require [EAM, metas, Hook].
// Resolve from the current list, verify its canonical shape, then order it for
// this mint's existing Execute ABI. Never use a historical fixed account graph.
export async function buildSilverDirectTransferMessage({ rpc, readAccount, kind,
  mintAddress, sourceTokenAddress, senderAddress, recipientAddress, blockhash,
  lastValidBlockHeight }) {
  if (!['SILVER_BOX', 'SILVER_RING'].includes(kind) ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Invalid Silver direct-transfer intent');
  const mint = address(mintAddress);
  const sender = address(senderAddress);
  const recipient = address(recipientAddress);
  const source = address(sourceTokenAddress);
  const [destination] = await findAssociatedTokenPda({ mint, owner: recipient,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [eam] = await findExtraAccountMetaListPda({ mint },
    { programAddress: address(SILVER) });
  const [mintAccount, sourceAccount, destinationAccount, eamAccount] = await Promise.all([
    readAccount(mint), readAccount(source), readAccount(destination), readAccount(eam),
  ]);
  if (mintAccount?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
      sourceAccount?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
      eamAccount?.owner !== SILVER) throw new Error('Silver transfer account owner mismatch');
  const mintState = getMintDecoder().decode(bytes(mintAccount));
  const sourceState = getTokenDecoder().decode(bytes(sourceAccount));
  const hook = mintState.extensions.__option === 'Some' &&
    mintState.extensions.value.find(ext => ext.__kind === 'TransferHook');
  if (mintState.decimals !== 0 || mintState.supply !== 1n ||
      hook?.programId !== SILVER || sourceState.mint !== mint ||
      sourceState.owner !== sender || sourceState.amount !== 1n)
    throw new Error('Silver transfer mint/source mismatch');
  if (destinationAccount) {
    if (destinationAccount.owner !== TOKEN_2022_PROGRAM_ADDRESS)
      throw new Error('Silver destination program mismatch');
    const existing = getTokenDecoder().decode(bytes(destinationAccount));
    if (existing.mint !== mint || existing.owner !== recipient)
      throw new Error('Silver destination token mismatch');
  }
  const eamBytes = bytes(eamAccount);
  const version = verifiedSilverDirectTransferEam(eamBytes, kind);
  if (!version) throw new Error('Unknown Silver transfer EAM');
  const derive = async (program, label, key) => (await getProgramDerivedAddress({
    programAddress: address(program), seeds: [new TextEncoder().encode(label),
      getAddressEncoder().encode(key)],
  }))[0];
  const state = await derive(SILVER, kind === 'SILVER_RING' ?
    'silver-ring-state' : 'silver-state', mint);
  const lifecycle = kind === 'SILVER_BOX' ?
    await derive(SILVER, 'silver-lifecycle', mint) : null;
  const listing = version.marketAware ?
    await derive(MARKET, 'silver-market-listing', mint) : null;
  const resolved = await resolveExtraAccountMetasForExecute({ rpc,
    transferHookProgramAddress: address(SILVER), source, mint,
    destination, owner: sender, amount: 1n, validateStatePubkey: eam });
  const expectedCount = kind === 'SILVER_BOX' ? (version.marketAware ? 6 : 4) :
    (version.marketAware ? 5 : 3);
  const expected = [state, ...(lifecycle ? [lifecycle] : []),
    ...(version.marketAware ? [MARKET, listing] : []), SILVER, eam];
  if (resolved.length !== expectedCount ||
      resolved.some((item, index) => item.address !== expected[index]))
    throw new Error('Resolved Silver EAM graph mismatch');
  const check = await readAccount(eam);
  if (check?.owner !== SILVER || !bytes(check).equals(eamBytes))
    throw new Error('Silver EAM changed during resolution');
  const transfer = getTransferCheckedInstruction({ source, mint, destination,
    authority: sender, amount: 1n, decimals: 0 });
  const instruction = { ...transfer,
    accounts: [...transfer.accounts, meta(eam, AccountRole.READONLY),
      ...resolved.slice(0, -2), meta(address(SILVER), AccountRole.READONLY)] };
  const instructions = [];
  if (!destinationAccount) instructions.push({ programAddress: ATA,
    data: Buffer.from([1]), accounts: [meta(sender, AccountRole.WRITABLE_SIGNER),
      meta(destination, AccountRole.WRITABLE), meta(recipient, AccountRole.READONLY),
      meta(mint, AccountRole.READONLY), meta(SYSTEM, AccountRole.READONLY),
      meta(TOKEN_2022_PROGRAM_ADDRESS, AccountRole.READONLY)] });
  instructions.push(instruction);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(sender, message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address(blockhash),
    lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 1 || compiled.staticAccounts[0] !== sender)
    throw new Error('Unexpected Silver direct-transfer signer graph');
  const wire = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const sizeBytes = 65 + wire.length;
  if (sizeBytes > 1232) throw new Error('Silver direct-transfer packet too large');
  return { messageBase64: wire.toString('base64'), sizeBytes,
    sourceTokenAddress: source, destinationTokenAddress: destination,
    recipientAddress: recipient, eamAddress: eam,
    eamSha256: createHash('sha256').update(eamBytes).digest('hex'),
    eamVersion: version.version, marketAware: version.marketAware,
    createsRecipientAta: !destinationAccount };
}
