import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilverFirstEntry } from '../src/silver-first-entry.js';

test('inventory starts independent finalized Box and Ring reads together', async () => {
  const walletAddress = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
  const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  const started = [];
  let finishBoxes;
  let finishRings;
  const chain = {
    async readFinalized() { throw new Error('No first-entry asset'); },
    listOwnedBoxes() {
      started.push('boxes');
      return new Promise(resolve => { finishBoxes = resolve; });
    },
    listOwnedRings() {
      started.push('rings');
      return new Promise(resolve => { finishRings = resolve; });
    },
  };
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_sessions')) return { rows: [{
      account_id: '00000000-0000-4000-8000-000000000001', wallet_address: walletAddress,
      environment: 'alpha-dev',
    }] };
    if (sql.includes('FROM alpha_silver_first_entry')) return { rows: [] };
    throw new Error('Unexpected query');
  } };
  const service = createSilverFirstEntry({ pool, chain, cluster: 'devnet', programId,
    collectionId: walletAddress, walletEnvironment: 'alpha-dev' });
  const result = service.inventory('a'.repeat(64));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['boxes', 'rings']);
  finishRings([]);
  finishBoxes([]);
  assert.deepEqual(await result, { status: 200, body: { assets: [] } });
});
