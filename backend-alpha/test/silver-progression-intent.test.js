import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { buildSilverProgressionMessage, sameSilverProgressionIntent,
  verifySilverProgressionCandidateMessage } from
  '../src/silver-progression-intent.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const input = {
  preparation: { operation_id: '11111111-1111-4111-8111-111111111111',
    reservation_id: '22222222-2222-4222-8222-222222222222',
    account_id: '33333333-3333-4333-8333-333333333333',
    wallet_address: key(4), mint_address: key(5), cluster: 'devnet',
    status: 'prepared', reservation_state: 'held',
    expected_level: 1, target_level: 2, ert_cost: '15.000000000000000000' },
  programId: '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX',
  issuerAddress: key(7), tokenAddress: key(8),
  cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  blockhash: key(9), lastValidBlockHeight: 12345,
};

test('Silver 1→2 binds exact ERT reservation, separate signer and stable refresh intent', async () => {
  const candidate = await buildSilverProgressionMessage(input);
  assert.equal(candidate.ertCost, '15');
  assert.equal(candidate.currentLevel, 1);
  assert.equal(candidate.targetLevel, 2);
  assert.ok(candidate.sizeBytes <= 1232);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  assert.equal(compiled.header.numSignerAccounts, 2);
  assert.equal(compiled.header.numReadonlySignerAccounts, 1);
  assert.equal(compiled.header.numReadonlyNonSignerAccounts, 6);
  assert.equal(compiled.staticAccounts.length, 10);
  assert.deepEqual(compiled.staticAccounts.slice(0, 2),
    [input.preparation.wallet_address, input.issuerAddress]);
  const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[1];
  const data = Buffer.from(instruction.data);
  assert.equal(data.length, 59);
  assert.deepEqual([...data.subarray(0, 3)], [16, 1, 2]);
  assert.equal(data.subarray(3, 19).toString('hex'),
    input.preparation.operation_id.replaceAll('-', ''));
  assert.equal(data.subarray(19, 35).toString('hex'),
    input.preparation.reservation_id.replaceAll('-', ''));
  assert.equal(data.subarray(35, 51).toString('hex'),
    input.preparation.account_id.replaceAll('-', ''));
  assert.equal(data.readBigUInt64LE(51), 15n);
  assert.equal(await verifySilverProgressionCandidateMessage(candidate,
    input.preparation, input.programId), true);
  assert.equal(await verifySilverProgressionCandidateMessage({ ...candidate,
    intentDigest: '0'.repeat(64) }, input.preparation, input.programId), false);
  assert.equal(await verifySilverProgressionCandidateMessage({ ...candidate,
    mintAddress: key(11) }, input.preparation, input.programId), false);
  const refreshed = await buildSilverProgressionMessage({ ...input, blockhash: key(10) });
  assert.equal(sameSilverProgressionIntent(candidate, refreshed), true);
  assert.equal(sameSilverProgressionIntent(candidate,
    await buildSilverProgressionMessage({ ...input, preparation: {
      ...input.preparation, mint_address: key(11),
    } })), false);
});

test('Silver candidate rejects unpaid or altered transition and missing reservation', async () => {
  for (const change of [
    { ert_cost: '14' }, { reservation_state: 'released' },
    { reservation_id: '00000000-0000-0000-0000-000000000000' },
    { expected_level: 4, target_level: 5, ert_cost: '30' },
  ]) await assert.rejects(buildSilverProgressionMessage({ ...input,
    preparation: { ...input.preparation, ...change },
  }));
});

test('Silver paid 4→5 and 19→20 bind canonical Gateway prices and fit the packet', async () => {
  const gatewayConfigData = Buffer.alloc(330);
  gatewayConfigData[0] = 1;
  Buffer.from(bs58.decode(key(12))).copy(gatewayConfigData, 33);
  Buffer.from(bs58.decode(key(13))).copy(gatewayConfigData, 65);
  Buffer.from(bs58.decode(key(14))).copy(gatewayConfigData, 97);
  gatewayConfigData.writeBigUInt64LE(1n, 322);
  for (const [expected, target, ert, principal, fee] of [
    [4, 5, 30, '38', '0.760000000'],
    [19, 20, 105, '75', '1.500000000'],
  ]) {
    const preparation = { ...input.preparation, expected_level: expected,
      target_level: target, ert_cost: String(ert), eru_principal: principal,
      eru_fee: fee };
    const candidate = await buildSilverProgressionMessage({ ...input, preparation,
      gatewayConfigData, nonce: 1, expirySlot: 50000 });
    assert.ok(candidate.sizeBytes <= 1232);
    assert.equal(candidate.eruPrincipal, principal);
    const compiled = getCompiledTransactionMessageDecoder().decode(
      Buffer.from(candidate.messageBase64, 'base64'));
    assert.equal(compiled.header.numSignerAccounts, 2);
    assert.equal(compiled.header.numReadonlySignerAccounts, 1);
    assert.equal(compiled.header.numReadonlyNonSignerAccounts, 12);
    assert.equal(compiled.staticAccounts.length, 22);
    const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[1];
    assert.equal(instruction.data[0], 18);
    assert.equal(instruction.data.length, 83);
    assert.equal(await verifySilverProgressionCandidateMessage(candidate,
      preparation, input.programId), true);
  }
});
