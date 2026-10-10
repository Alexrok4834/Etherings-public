import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { breedingBoxIdentity } from '../src/cooper-breeding.js';
import { buildCooperBreedingCandidateMessage,
  verifyCooperBreedingCandidateEnvelope } from '../src/cooper-breeding-intent.js';

const GATEWAY = 'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF';
const MINT = '2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj';
const TREASURY = 'CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn';
const HOOK = '5GtUDz7kSuyxgaZNxTG8UHbLhwEshbSfQJgmQypMLkEz';
const ATTESTOR = '65g5pwTFDqXKKHaTfFQ2etKX8iPSTVFbUkZRoPJfXQfy';
const WALLET = 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

test('one signed atomic breeding candidate has bounded exact account graph', async t => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const firstRingId = '33333333-3333-4333-8333-333333333333';
  const secondRingId = '44444444-4444-4444-8444-444444444444';
  const identity = breedingBoxIdentity(accountId, WALLET, operationId,
    firstRingId, secondRingId, 0, 0);
  const preparation = { id: operationId, account_id: accountId,
    reservation_id: '55555555-5555-4555-8555-555555555555', wallet_address: WALLET, cluster: 'devnet',
    reservation_state: 'held', first_ring_id: firstRingId,
    second_ring_id: secondRingId, first_uses: 0, second_uses: 0,
    ert_cost: '150.000000000000000000', eru_principal: '30.000000000000000000',
    eru_fee: '0.600000000000000000', issuance_id: identity.issuanceId,
    entitlement_digest: identity.entitlementDigest };
  const config = Buffer.alloc(330);
  const encode = getAddressEncoder();
  config[0] = 1;
  for (const [offset, key] of [[33, MINT], [65, TREASURY], [97, HOOK],
    [290, ATTESTOR]]) Buffer.from(encode.encode(key)).copy(config, offset);
  config.writeBigUInt64LE(1n, 322);
  const candidate = await buildCooperBreedingCandidateMessage({ preparation,
    gatewayProgramId: GATEWAY, configOwner: GATEWAY, configData: config,
    genesisHash: GENESIS, blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 1000, nonce: 1, expirySlot: 1000 });
  t.diagnostic(`legacy transaction: ${candidate.sizeBytes} bytes`);
  assert.deepEqual([...Buffer.from(candidate.messageBase64, 'base64').subarray(0, 3)],
    [2, 1, 11]);
  assert(candidate.sizeBytes <= 1232);
  const message = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  const instructions = getInstructionsFromCompiledTransactionMessage(message);
  assert.equal(message.header.numSignerAccounts, 2);
  assert.equal(instructions.length, 2);
  assert.equal(instructions[1].data.length, 124);
  assert.equal(instructions[1].accounts.length, 26);
  assert.equal(instructions[1].data[0], 5);
  assert.equal(verifyCooperBreedingCandidateEnvelope(candidate), true);
  assert.equal(verifyCooperBreedingCandidateEnvelope({ ...candidate,
    intentDigest: '0'.repeat(64) }), false);
});
