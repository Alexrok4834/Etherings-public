import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { buildCooperEruCandidateMessage,
  sameCooperEruIntent, verifyCooperEruCandidateEnvelope } from '../src/cooper-eru-intent.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const program = key(11);
const mint = key(12);
const treasury = key(13);
const hook = key(14);
const attestor = key(15);
const wallet = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
const configData = Buffer.alloc(330);
configData[0] = 1;
for (const [offset, value] of [[33, mint], [65, treasury], [97, hook], [290, attestor]])
  configData.set(getAddressEncoder().encode(value), offset);
configData.writeBigUInt64LE(1n, 322);
const preparation = { operation_id: randomUUID(), reservation_id: randomUUID(),
  ring_id: randomUUID(), account_id: randomUUID(), wallet_address: wallet,
  cluster: 'local-validator', expected_level: 4, target_level: 5,
  ert_cost: '24.000000000000000000', eru_principal: '30.000000000000000000',
  eru_fee: '0.600000000000000000', status: 'prepared', reservation_state: 'held' };
const base = { preparation, cluster: 'local-validator', genesisHash: key(17),
  expectedGenesisHash: key(17), gatewayProgramId: program, configOwner: program,
  configData, blockhash: key(18), lastValidBlockHeight: 100, nonce: 1,
  expirySlot: 500 };

test('Cooper candidate preserves exact preparation, signer graph and refresh intent', async () => {
  const first = await buildCooperEruCandidateMessage(base);
  assert(verifyCooperEruCandidateEnvelope(first));
  assert.equal(first.sizeBytes, 780); // user is also fee payer; proof used a separate payer
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(first.messageBase64, 'base64'));
  assert.equal(compiled.header.numSignerAccounts, 2);
  assert.deepEqual(compiled.staticAccounts.slice(0, 2), [wallet, attestor]);
  const instructions = getInstructionsFromCompiledTransactionMessage(compiled);
  assert.equal(instructions.length, 2);
  assert.equal(instructions[1].programAddress, program);
  const data = Buffer.from(instructions[1].data);
  assert.equal(data.length, 108);
  assert.equal(data.readBigUInt64LE(1), 30_000_000_000n);
  assert.equal(data.readBigUInt64LE(17), 500n);
  assert.equal(data.subarray(25, 41).toString('hex'), preparation.operation_id.replaceAll('-', ''));
  assert.equal(data.subarray(41, 57).toString('hex'), preparation.reservation_id.replaceAll('-', ''));
  assert.equal(data.subarray(57, 73).toString('hex'), preparation.ring_id.replaceAll('-', ''));
  assert.equal(data.subarray(73, 89).toString('hex'), preparation.account_id.replaceAll('-', ''));
  assert.deepEqual([...data.subarray(89, 91)], [4, 5]);
  assert.equal(data.readBigUInt64LE(91), 24n);
  assert.equal(data.readBigUInt64LE(100), 1n);
  assert.equal(instructions[1].accounts[5].address, attestor);
  assert.equal(instructions[1].accounts[14].role, 1);
  const refreshed = await buildCooperEruCandidateMessage({ ...base, blockhash: key(19),
    lastValidBlockHeight: 120 });
  assert.notEqual(first.messageBase64, refreshed.messageBase64);
  assert(sameCooperEruIntent(first, refreshed));
  assert(verifyCooperEruCandidateEnvelope(refreshed));
  assert(!verifyCooperEruCandidateEnvelope({ ...first, nonce: 2 }));
  assert(!verifyCooperEruCandidateEnvelope({ ...first, intentDigest: '0'.repeat(64) }));
  assert(!verifyCooperEruCandidateEnvelope({ ...first,
    messageBase64: Buffer.from('not a transaction').toString('base64') }));
  assert(!sameCooperEruIntent(first, await buildCooperEruCandidateMessage({
    ...base, nonce: 2 })));
  assert(!sameCooperEruIntent(first, { ...refreshed,
    messageBase64: Buffer.from('not a transaction').toString('base64') }));
});

test('Cooper candidate fails closed on changed authority, cost and preparation', async () => {
  for (const mutation of [
    { preparation: { ...preparation, status: 'unknown' } },
    { preparation: { ...preparation, reservation_state: 'released' } },
    { preparation: { ...preparation, eru_fee: '0.4' } },
    { preparation: { ...preparation, eru_fee: '0.6000000001' } },
    { preparation: { ...preparation, ert_cost: '25' } },
    { preparation: { ...preparation, target_level: 6 } },
    { preparation: { ...preparation, reservation_id: '00000000-0000-0000-0000-000000000000' } },
    { configOwner: key(21) },
    { configData: Buffer.alloc(330) },
    { genesisHash: key(22) },
    { cluster: 'devnet' },
  ]) await assert.rejects(() => buildCooperEruCandidateMessage({ ...base, ...mutation }));
  const second = { ...preparation, expected_level: 19, target_level: 20,
    ert_cost: '84', eru_principal: '60', eru_fee: '1.2' };
  const result = await buildCooperEruCandidateMessage({ ...base, preparation: second });
  assert.equal(result.sizeBytes, 780);
  const secondData = Buffer.from(getInstructionsFromCompiledTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(Buffer.from(result.messageBase64, 'base64'))
  )[1].data);
  assert.equal(secondData.readBigUInt64LE(1), 60_000_000_000n);
  assert.equal(secondData.readBigUInt64LE(91), 84n);
});
