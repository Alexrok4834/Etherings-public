import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder } from '@solana/kit';
import { breedingBoxIdentity } from '../src/cooper-breeding.js';
import { buildCooperBreedingCandidateMessage } from '../src/cooper-breeding-intent.js';
import { createCooperBreedingUserFlow } from '../src/cooper-breeding-user-flow.js';

const GATEWAY = 'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF';
const MINT = '2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj';
const TREASURY = 'CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn';
const HOOK = '5GtUDz7kSuyxgaZNxTG8UHbLhwEshbSfQJgmQypMLkEz';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, address: bs58.encode(publicKey.export({
    format: 'der', type: 'spki',
  }).subarray(-32)) };
};

test('breeding user approval is distinct and durable submission precedes broadcast', async () => {
  const user = pair();
  const attestor = pair();
  const accountId = randomUUID();
  const operationId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const identity = breedingBoxIdentity(accountId, user.address, operationId,
    first, second, 0, 1);
  const preparation = { id: operationId, account_id: accountId,
    reservation_id: randomUUID(), wallet_address: user.address, cluster: 'devnet',
    reservation_state: 'held', first_ring_id: first, second_ring_id: second,
    first_uses: 0, second_uses: 1,
    ert_cost: '200', eru_principal: '40', eru_fee: '0.8',
    issuance_id: identity.issuanceId,
    entitlement_digest: identity.entitlementDigest };
  const config = Buffer.alloc(330);
  config[0] = 1;
  const encode = getAddressEncoder();
  for (const [offset, key] of [[33, MINT], [65, TREASURY], [97, HOOK],
    [290, attestor.address]]) Buffer.from(encode.encode(key)).copy(config, offset);
  config.writeBigUInt64LE(1n, 322);
  const candidate = await buildCooperBreedingCandidateMessage({ preparation,
    gatewayProgramId: GATEWAY, configOwner: GATEWAY, configData: config,
    genesisHash: GENESIS, blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 1000, nonce: 1, expirySlot: 1000 });
  const message = Buffer.from(candidate.messageBase64, 'base64');
  const attestorSignatureBase64 = sign(null, message, attestor.privateKey).toString('base64');
  let recorded = false;
  const flow = createCooperBreedingUserFlow({
    attestation: { async attest() { return { candidate, attestorSignatureBase64 }; } },
    reconciliation: {
      async recordSubmission(_account, _operation, signature) {
        assert.equal(signature, bs58.encode(sign(null, message, user.privateKey)));
        recorded = true;
        return { replay: false };
      },
      async reconcile() { return { status: 'unknown' }; },
    },
    chain: {
      async getSlot() { return 1; },
      async getBlockHeight() { return 1; },
      async isBlockhashValid() { return true; },
      async sendRawTransaction() {
        assert.equal(recorded, true);
        return bs58.encode(sign(null, message, user.privateKey));
      },
    },
  });
  const approved = await flow.review(accountId, operationId);
  const refreshed = await flow.refresh(accountId, operationId, approved);
  await assert.rejects(() => flow.submit(accountId, operationId, refreshed,
    sign(null, message, attestor.privateKey).toString('base64')),
  /intent unavailable/);
  assert.equal(recorded, false);
  const submitted = await flow.submit(accountId, operationId, refreshed,
    sign(null, message, user.privateKey).toString('base64'));
  assert.deepEqual(submitted, { status: 'unknown',
    signature: bs58.encode(sign(null, message, user.privateKey)) });
  assert.equal(recorded, true);
});
