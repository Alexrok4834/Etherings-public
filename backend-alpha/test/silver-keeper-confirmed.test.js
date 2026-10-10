import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilverKeeper } from '../src/silver-keeper.js';

test('confirmed transferred Ring does not block a later opening', async () => {
  const confirmed = { cluster: 'devnet', genesis_hash: 'genesis', program_id: 'program',
    mint_address: 'old-box', account_id: 'old-account', wallet_address: 'old-wallet' };
  const opening = { ...confirmed, mint_address: 'new-box', account_id: 'new-account',
    wallet_address: 'new-wallet' };
  const pool = { query: async (sql, args) => {
    if (sql.includes('UNION ALL')) return { rows: [confirmed, opening] };
    if (sql.includes('FROM alpha_silver_opening_finalizations')) return { rows:
      args[3] === 'old-box' ? [{ status: 'confirmed', account_id: 'old-account',
        wallet_address: 'old-wallet', payer_address: 'payer' }] : [] };
    throw new Error('unexpected database mutation');
  } };
  const inspected = [];
  const chain = { payerAddress: 'payer', inspect: async row => {
    inspected.push(row.mint_address);
    if (row.mint_address === 'old-box') throw new Error('transferred Ring');
    return { phase: 'opening', fulfilled: false };
  } };
  const result = await createSilverKeeper({ pool, chain, programId: 'program' }).tick();
  assert.deepEqual(inspected, ['new-box']);
  assert.equal(result.confirmed, 1);
  assert.equal(result.pending, 1);
});
