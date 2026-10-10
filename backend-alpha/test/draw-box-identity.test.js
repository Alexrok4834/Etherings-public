import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawBoxIdentity } from '../src/draw-box-identity.js';
import { firstEntryIdentity } from '../src/silver-first-entry.js';

test('Draw result has one stable issuance independent of first-entry entitlement', () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const result = '22222222-2222-4222-8222-222222222222';
  const wallet = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
  const draw = drawBoxIdentity(account, wallet, result);
  assert.deepEqual(draw, drawBoxIdentity(account, wallet, result));
  assert.notEqual(draw.issuanceId, firstEntryIdentity(account, wallet, 'devnet').issuanceId);
  assert.equal(draw.issuanceId,
    drawBoxIdentity(account, 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX', result).issuanceId);
  assert.notEqual(draw.entitlementDigest,
    drawBoxIdentity(account, 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX', result)
      .entitlementDigest);
  assert.notEqual(draw.issuanceId, drawBoxIdentity(account, wallet,
    '33333333-3333-4333-8333-333333333333').issuanceId);
});
