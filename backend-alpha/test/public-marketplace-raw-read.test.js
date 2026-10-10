import test from 'node:test';
import assert from 'node:assert/strict';
import { rawActiveAddresses, requireCanonicalMarketplaceProgram } from '../deploy/read-raw-active-marketplace.mjs';

const program = 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j';
function entry(status, pubkey = 'listing') {
  const raw = Buffer.alloc(320);
  Buffer.from('ERSMKV1\0').copy(raw);
  raw[8] = 1;
  raw[9] = status;
  return { pubkey, account: { owner: program, data: [raw.toString('base64'), 'base64'] } };
}

test('raw ACTIVE listing is reported even when browse would filter its source', () => {
  assert.equal(requireCanonicalMarketplaceProgram(program), program);
  assert.throws(() => requireCanonicalMarketplaceProgram('11111111111111111111111111111111'),
    /Canonical Marketplace program ID required/);
  assert.deepEqual(rawActiveAddresses([entry(1), entry(3, 'sold')], program), ['listing']);
  assert.deepEqual(rawActiveAddresses([], program), []);
  assert.throws(() => rawActiveAddresses([{
    ...entry(1), account: { ...entry(1).account, owner: 'wrong' },
  }], program), /Unexpected Marketplace listing account/);
});
