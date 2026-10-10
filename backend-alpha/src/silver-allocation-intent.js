import { createHash, timingSafeEqual } from 'node:crypto';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressEncoder,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const names = ['comfort', 'charm', 'quality', 'luck'];
export function silverAllocationValues(allocation, unspent) {
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation) ||
      Object.keys(allocation).sort().join(',') !== [...names].sort().join(','))
    throw new Error('Invalid Silver Points allocation');
  const values = names.map(name => allocation[name]);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 114) ||
      total < 1 || total > unspent || total > 114)
    throw new Error('Invalid Silver Points allocation');
  return values;
}

export async function buildSilverAllocationMessage({ ring, walletAddress, tokenAddress,
  programId, allocation, blockhash, lastValidBlockHeight }) {
  if (!ring || ring.kind !== 'SILVER_RING' ||
      ring.tokenOwner !== walletAddress || ring.programId !== programId ||
      ring.cluster !== 'devnet' || !Number.isInteger(ring.level) ||
      ring.level < 2 || ring.level > 20 ||
      !Number.isInteger(ring.unspentPoints) || ring.unspentPoints < 1 ||
      ring.unspentPoints > 114 ||
      !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1)
    throw new Error('Unverified Silver Points allocation');
  const values = silverAllocationValues(allocation, ring.unspentPoints);
  const attributes = ['comfort', 'charm', 'quality', 'luck'].map(name => ring[name]);
  if (attributes.some(value => !Number.isInteger(value) || value < 10 || value > 144))
    throw new Error('Invalid Silver attribute state');
  const mint = address(ring.mintAddress);
  const wallet = address(walletAddress);
  const program = address(programId);
  const token = address(tokenAddress);
  const [state] = await getProgramDerivedAddress({ programAddress: program,
    seeds: [new TextEncoder().encode('silver-ring-state'),
      getAddressEncoder().encode(mint)] });
  const data = Buffer.alloc(14);
  data[0] = 17;
  data[1] = ring.level;
  data.writeUInt32LE(ring.unspentPoints, 2);
  Buffer.from(attributes).copy(data, 6);
  Buffer.from(values).copy(data, 10);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(wallet, message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(blockhash), lastValidBlockHeight: BigInt(lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([{ programAddress: program, data,
    accounts: [{ address: wallet, role: AccountRole.WRITABLE_SIGNER },
      { address: mint, role: AccountRole.READONLY },
      { address: state, role: AccountRole.WRITABLE },
      { address: token, role: AccountRole.READONLY }] }], message);
  const compiled = compileTransactionMessage(message);
  if (compiled.header.numSignerAccounts !== 1 || compiled.staticAccounts[0] !== wallet)
    throw new Error('Unexpected Silver allocation signer graph');
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const sizeBytes = 1 + 64 + bytes.length;
  if (sizeBytes > 1232) throw new Error('Silver allocation transaction exceeds packet size');
  const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[0];
  const digest = createHash('sha256').update(instruction.data).update(Buffer.from(
    instruction.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
  return { messageBase64: bytes.toString('base64'), sizeBytes, intentDigest: digest,
    walletAddress: wallet, mintAddress: mint, tokenAddress: token,
    ringAddress: state, programId: program, cluster: 'devnet', genesisHash: GENESIS,
    level: ring.level, unspentPoints: ring.unspentPoints, attributes,
    allocation: Object.fromEntries(names.map((name, index) => [name, values[index]])),
    lastValidBlockHeight };
}

export function sameSilverAllocationIntent(approved, refreshed) {
  const first = Buffer.from(approved?.intentDigest ?? '', 'hex');
  const second = Buffer.from(refreshed?.intentDigest ?? '', 'hex');
  return first.length === 32 && second.length === 32 && timingSafeEqual(first, second) &&
    ['walletAddress', 'mintAddress', 'tokenAddress', 'ringAddress', 'programId',
      'cluster', 'genesisHash', 'level', 'unspentPoints'].every(
      key => approved[key] === refreshed[key]) &&
    names.every(name => approved.allocation?.[name] === refreshed.allocation?.[name]) &&
    JSON.stringify(approved.attributes) === JSON.stringify(refreshed.attributes);
}

export async function verifySilverAllocationMessage(candidate, ring) {
  try {
    if (!candidate || candidate.walletAddress !== ring.tokenOwner ||
        candidate.mintAddress !== ring.mintAddress || candidate.programId !== ring.programId)
      return false;
    const bytes = Buffer.from(candidate.messageBase64, 'base64');
    if (bytes.toString('base64') !== candidate.messageBase64) return false;
    const decoded = getCompiledTransactionMessageDecoder().decode(bytes);
    const expected = await buildSilverAllocationMessage({ ring,
      walletAddress: candidate.walletAddress, tokenAddress: candidate.tokenAddress,
      programId: candidate.programId, allocation: candidate.allocation,
      blockhash: decoded.lifetimeToken,
      lastValidBlockHeight: candidate.lastValidBlockHeight });
    return bytes.equals(Buffer.from(expected.messageBase64, 'base64')) &&
      candidate.sizeBytes === expected.sizeBytes &&
      sameSilverAllocationIntent(candidate, expected);
  } catch { return false; }
}
