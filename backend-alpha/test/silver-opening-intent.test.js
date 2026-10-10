import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { AccountRole, address, getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { buildSilverOpeningCandidateMessage,
  verifySilverOpeningCandidateMessage } from '../src/silver-opening-intent.js';

const key = () => bs58.encode(randomBytes(32));

test('candidate opening message matches exact four-instruction graph with wallet-only signer', async () => {
  const programId = key();
  const walletAddress = key();
  const mintAddress = key();
  const userTokenAddress = key();
  const oraoTreasury = key();
  const seed = randomBytes(32);
  const [escrowAuthority] = await getProgramDerivedAddress({ programAddress: address(programId),
    seeds: [new TextEncoder().encode('silver-escrow'), bs58.decode(mintAddress)] });
  const [escrowAddress] = await findAssociatedTokenPda({ mint: mintAddress,
    owner: escrowAuthority, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const input = { cluster: 'local-validator', programId, walletAddress, mintAddress,
    userTokenAddress, escrowAddress,
    nextOperation: 1, designVersion: 1, oraoTreasury, seed, blockhash: key(),
    lastValidBlockHeight: 500 };
  const intent = await buildSilverOpeningCandidateMessage(input);
  assert.equal(intent.cluster, 'local-validator');
  assert.equal((await buildSilverOpeningCandidateMessage({ ...input, cluster: 'devnet' }))
    .messageBase64, intent.messageBase64);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(intent.messageBase64, 'base64'));
  const instructions = getInstructionsFromCompiledTransactionMessage(compiled);
  assert.equal(compiled.header.numSignerAccounts, 1);
  assert.equal(compiled.staticAccounts[0], walletAddress);
  assert.deepEqual(instructions.map(ix => ix.programAddress), [
    'ComputeBudget111111111111111111111111111111', programId,
    TOKEN_2022_PROGRAM_ADDRESS, programId,
  ]);
  assert.equal(instructions[0].data[0], 2);
  assert.equal(Buffer.from(instructions[0].data).readUInt32LE(1), 1_300_000);
  assert.deepEqual(Buffer.from(instructions[1].data), Buffer.concat([Buffer.from([12]), seed]));
  assert.deepEqual(Buffer.from(instructions[3].data), Buffer.concat([Buffer.from([13]), seed]));
  assert.deepEqual(instructions[1].accounts, instructions[3].accounts);
  assert.equal(instructions[1].accounts.length, 18);
  assert.deepEqual(instructions[1].accounts.map(x => x.role), [
    AccountRole.WRITABLE_SIGNER, AccountRole.READONLY, AccountRole.WRITABLE,
    AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE,
    AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.READONLY,
    AccountRole.READONLY, AccountRole.READONLY, AccountRole.WRITABLE,
    AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.READONLY,
    AccountRole.READONLY, AccountRole.READONLY, AccountRole.READONLY,
  ]);
  const derive = async (id, ...seeds) => (await getProgramDerivedAddress({
    programAddress: address(id), seeds,
  }))[0];
  const version = Buffer.alloc(8); version.writeBigUInt64LE(1n);
  const [extra] = await findExtraAccountMetaListPda({ mint: mintAddress },
    { programAddress: programId });
  const network = await derive('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y',
    new TextEncoder().encode('orao-vrf-network-configuration'));
  assert.deepEqual(instructions[1].accounts.slice(4, 11).map(x => x.address), [
    await derive(programId, new TextEncoder().encode('silver-state'), bs58.decode(mintAddress)),
    await derive(programId, new TextEncoder().encode('silver-lifecycle'), bs58.decode(mintAddress)),
    extra,
    await derive(programId, new TextEncoder().encode('silver-open'), bs58.decode(mintAddress), version),
    await derive(programId, new TextEncoder().encode('silver-config')),
    await derive(programId, new TextEncoder().encode('silver-design-set'), version),
    await derive(programId, new TextEncoder().encode('silver-collection')),
  ]);
  assert.deepEqual(instructions[1].accounts.slice(0, 4).map(({ address, role }) => [address, role]), [
    [walletAddress, AccountRole.WRITABLE_SIGNER], [mintAddress, AccountRole.READONLY],
    [userTokenAddress, AccountRole.WRITABLE], [escrowAddress, AccountRole.WRITABLE],
  ]);
  assert.equal(instructions[1].accounts[11].address, network);
  assert.deepEqual(instructions[1].accounts.slice(12, 18).map(x => x.address), [
    oraoTreasury, intent.request, 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y',
    TOKEN_2022_PROGRAM_ADDRESS, 'Sysvar1nstructions1111111111111111111111111',
    '11111111111111111111111111111111',
  ]);
  assert.deepEqual(instructions[2].accounts.map(({ address, role }) => [address, role]), [
    [userTokenAddress, AccountRole.WRITABLE], [mintAddress, AccountRole.READONLY],
    [escrowAddress, AccountRole.WRITABLE], [walletAddress, AccountRole.WRITABLE_SIGNER],
    [instructions[1].accounts[6].address, AccountRole.READONLY],
    [instructions[1].accounts[4].address, AccountRole.WRITABLE],
    [instructions[1].accounts[5].address, AccountRole.WRITABLE],
    [programId, AccountRole.READONLY],
  ]);
  assert.deepEqual(Buffer.from(instructions[2].data), Buffer.from([12, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(intent.escrow, escrowAddress);
  assert.equal(await verifySilverOpeningCandidateMessage(input, intent.messageBase64), true);
  const marketProgramId = key();
  const migrated = await buildSilverOpeningCandidateMessage({ ...input, marketProgramId });
  const migratedCompiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(migrated.messageBase64, 'base64'));
  const migratedInstructions = getInstructionsFromCompiledTransactionMessage(migratedCompiled);
  assert.equal(migratedInstructions[1].accounts.length, 20);
  assert.equal(migratedInstructions[2].accounts.length, 10);
  assert.equal(migratedInstructions[1].accounts[18].address, marketProgramId);
  assert.equal(migratedInstructions[1].accounts[19].address,
    await derive(marketProgramId, new TextEncoder().encode('silver-market-listing'),
      bs58.decode(mintAddress)));
  assert.equal(await verifySilverOpeningCandidateMessage({ ...input, marketProgramId },
    migrated.messageBase64), true);
  assert.equal(await verifySilverOpeningCandidateMessage({ ...input, marketProgramId },
    intent.messageBase64), false);
  const changed = Buffer.from(intent.messageBase64, 'base64');
  changed[changed.length - 1] ^= 1;
  assert.equal(await verifySilverOpeningCandidateMessage(input, changed.toString('base64')), false);
  assert.equal(await verifySilverOpeningCandidateMessage({ ...input, userTokenAddress: key() },
    intent.messageBase64), false);
  assert.equal(await verifySilverOpeningCandidateMessage({ ...input, oraoTreasury: key() },
    intent.messageBase64), false);
  assert.equal(await verifySilverOpeningCandidateMessage({ ...input, blockhash: key() },
    intent.messageBase64), false);
  assert.notEqual((await buildSilverOpeningCandidateMessage({ ...input, seed: randomBytes(32) }))
    .messageBase64, intent.messageBase64);
  await assert.rejects(buildSilverOpeningCandidateMessage({ ...input, escrowAddress: key() }),
    /escrow binding mismatch/);
  await assert.rejects(buildSilverOpeningCandidateMessage({ ...input, seed: Buffer.alloc(32) }),
    /Invalid candidate/);
  await assert.rejects(buildSilverOpeningCandidateMessage({ ...input, nextOperation: 0 }),
    /Invalid candidate/);
  await assert.rejects(buildSilverOpeningCandidateMessage({ ...input, cluster: 'testnet' }),
    /Invalid candidate/);
});
