import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { buildSilverAllocationMessage, sameSilverAllocationIntent,
  verifySilverAllocationMessage } from '../src/silver-allocation-intent.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const walletAddress = key(4);
const ring = { kind: 'SILVER_RING', tokenOwner: walletAddress,
  programId, cluster: 'devnet', mintAddress: key(5), level: 2,
  unspentPoints: 6, comfort: 26, charm: 20, quality: 25, luck: 29 };
const input = { ring, walletAddress, tokenAddress: key(6), programId,
  allocation: { comfort: 1, charm: 0, quality: 0, luck: 0 },
  blockhash: key(7), lastValidBlockHeight: 12345 };

test('Silver multi-Point allocation is user-signed, chain-bound and replay-stale', async () => {
  const candidate = await buildSilverAllocationMessage(input);
  assert.equal(await verifySilverAllocationMessage(candidate, ring), true);
  const decoded = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  assert.equal(decoded.header.numSignerAccounts, 1);
  assert.equal(decoded.header.numReadonlySignerAccounts, 0);
  assert.equal(decoded.header.numReadonlyNonSignerAccounts, 3);
  assert.equal(decoded.staticAccounts.length, 5);
  assert.equal(decoded.staticAccounts[0], walletAddress);
  const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
  assert.equal(instructions.length, 1);
  assert.deepEqual([...Buffer.from(instructions[0].data)],
    [17, 2, 6, 0, 0, 0, 26, 20, 25, 29, 1, 0, 0, 0]);
  const refreshed = await buildSilverAllocationMessage({ ...input, blockhash: key(8) });
  assert.equal(sameSilverAllocationIntent(candidate, refreshed), true);
  assert.equal(await verifySilverAllocationMessage(candidate,
    { ...ring, unspentPoints: 5, comfort: 27 }), false);
  const all = await buildSilverAllocationMessage({ ...input,
    allocation: { comfort: 2, charm: 1, quality: 0, luck: 3 } });
  assert.deepEqual([...Buffer.from(getInstructionsFromCompiledTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(
      Buffer.from(all.messageBase64, 'base64')))[0].data).subarray(10)], [2, 1, 0, 3]);
  assert.equal(await verifySilverAllocationMessage(all, ring), true);
  await assert.rejects(buildSilverAllocationMessage({ ...input,
    allocation: { comfort: 7, charm: 0, quality: 0, luck: 0 } }));
  await assert.rejects(buildSilverAllocationMessage({ ...input,
    allocation: { comfort: 0, charm: 0, quality: 0, luck: 0 } }));
});
