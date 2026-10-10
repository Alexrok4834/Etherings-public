import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sha = text => createHash('sha256').update(text, 'ascii').digest('hex');

// Mirrors the additive Silver Draw issuance instruction. The result UUID, not
// the account's first-entry entitlement, determines the unique Box mint PDA.
export function drawBoxIdentity(accountId, walletAddress, resultId, cluster = 'devnet') {
  if (!UUID.test(accountId) || !UUID.test(resultId) || !WALLET.test(walletAddress) ||
      cluster !== 'devnet') throw new TypeError('Invalid Draw Box identity');
  const issuanceId = sha(`EtheRings:draw-box:issuance:v1\n${cluster}\n${resultId}\n`);
  const entitlementDigest = sha(`EtheRings:draw-box:binding:v1\n${cluster}\n` +
    `${accountId}\n${walletAddress}\n${resultId}\n${issuanceId}\n`);
  return { issuanceId, entitlementDigest };
}
