import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getCompiledTransactionMessageDecoder, getInstructionsFromCompiledTransactionMessage,
  getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { buildSilverOpeningCandidateMessage } from '../src/silver-opening-intent.js';

const key = label => bs58.encode(createHash('sha256').update(`silver-opening-android:${label}`).digest());
const marketAware = process.argv.includes('--market');
const marketProgramId = 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j';
const programId = key('program');
const mintAddress = key('mint');
const [escrowAuthority] = await getProgramDerivedAddress({ programAddress: programId,
  seeds: [new TextEncoder().encode('silver-escrow'), bs58.decode(mintAddress)] });
const [escrowAddress] = await findAssociatedTokenPda({ mint: mintAddress,
  owner: escrowAuthority, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
const seed = createHash('sha256').update('silver-opening-android:seed').digest();
const intent = await buildSilverOpeningCandidateMessage({ cluster: 'local-validator',
  programId, walletAddress: key('wallet'), mintAddress, userTokenAddress: key('source'),
  escrowAddress, nextOperation: 1, designVersion: 1, oraoTreasury: key('treasury'),
  seed, blockhash: key('blockhash'), lastValidBlockHeight: 500,
  marketProgramId: marketAware ? marketProgramId : null });
const compiled = getCompiledTransactionMessageDecoder().decode(
  Buffer.from(intent.messageBase64, 'base64'));
const [compute, prepare, transfer] = getInstructionsFromCompiledTransactionMessage(compiled);
const names = ['authority', 'mint', 'source', 'escrow', 'state', 'lifecycle', 'extra',
  'operation', 'config', 'design', 'collection', 'network', 'treasury', 'request',
  'orao', 'token', 'instructions', 'system', ...(marketAware ? ['market', 'listing'] : [])];
const policy = Object.fromEntries(prepare.accounts.map((entry, index) => [names[index], entry.address]));
Object.assign(policy, { silver: programId, compute: compute.programAddress,
  cluster: 'local-validator', seedHex: seed.toString('hex') });
const vector = `${JSON.stringify({ policy, response: { testOnly: true,
  cluster: intent.cluster, walletAddress: intent.walletAddress,
  mintAddress: intent.mintAddress, operation: intent.operation,
  request: intent.request, seedHex: seed.toString('hex'),
  lastValidBlockHeight: 500, messageBase64: intent.messageBase64 } })}\n`;
if (process.argv.includes('--write')) {
  const directory = new URL('../../android-alpha/app/src/androidTest/assets/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL('silver-opening-kit-vector.json', directory), vector);
} else process.stdout.write(vector);
