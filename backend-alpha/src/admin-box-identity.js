import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sha = text => createHash('sha256').update(text, 'ascii').digest('hex');

export function adminBoxIdentity(accountId, walletAddress, operationId) {
  if (![accountId, operationId].every(value => UUID.test(value ?? '')) ||
      !WALLET.test(walletAddress ?? ''))
    throw new TypeError('Invalid admin Box identity');
  const issuanceId = sha(`EtheRings:admin-box:issuance:v1\ndevnet\n${operationId}\n`);
  const entitlementDigest = sha(`EtheRings:admin-box:binding:v1\ndevnet\n` +
    `${accountId}\n${walletAddress}\n${operationId}\n${issuanceId}\n`);
  return { issuanceId, entitlementDigest };
}
