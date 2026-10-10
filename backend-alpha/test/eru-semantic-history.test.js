import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readEruHistory } from '../src/eru-history.js';

const at = new Date('2026-10-02T18:00:00Z');
const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const user = { id: id(1), wallet_address: 'wallet-A' };

function fixture(rows) {
  return { async query(sql, params) {
    assert.equal(params[0], user.id);
    if (!sql.includes('FROM alpha_eru_intents')) assert.equal(params[1], user.wallet_address);
    const name = sql.includes('FROM alpha_eru_intents') ? 'intents' :
      sql.includes('FROM alpha_cooper_level_eru_preparations') ? 'cooper' :
      sql.includes('FROM alpha_silver_progression_operations') ? 'silver' :
      sql.includes('FROM alpha_cooper_breeding_operations') ? 'breeding' : 'draw';
    return { rows: rows[name] ?? [] };
  } };
}

test('history uses settled game evidence and preserves exact principal and fee', async () => {
  const rows = {
    cooper: [{ id: id(2), status: 'confirmed', amount: '30.000000000000000000',
      fee: '0.600000000000000000', nonce: '3', signature: '2'.repeat(88), created_at: at }],
    silver: [{ id: id(3), status: 'prepared', amount: '38.000000000',
      fee: '0.760000000', signature: null, submitted_signature: '3'.repeat(88), created_at: at }],
    breeding: [{ id: id(4), amount: '40.000000000000000000',
      fee: '0.800000000000000000', nonce: '5', signature: null,
      submitted_signature: '4'.repeat(88), created_at: at }],
    draw: [{ id: id(5), amount: '5.000000000000000000',
      state: 'CONFIRMED', signature: '5'.repeat(88), created_at: at }],
  };
  const result = await readEruHistory(fixture(rows), user, 'gateway');
  assert.equal(result.status, 200);
  const byType = Object.fromEntries(result.body.operations.map(row => [row.type, row]));
  assert.deepEqual([byType.cooper_level_up.direction, byType.cooper_level_up.amount,
    byType.cooper_level_up.fee, byType.cooper_level_up.status],
  ['out', '30', '0.6', 'confirmed']);
  assert.deepEqual([byType.silver_level_up.amount, byType.silver_level_up.fee,
    byType.silver_level_up.status], ['38', '0.76', 'unknown']);
  assert.deepEqual([byType.breeding.amount, byType.breeding.fee,
    byType.breeding.status], ['40', '0.8', 'unknown']);
  assert.deepEqual([byType.draw_reward.direction, byType.draw_reward.amount,
    byType.draw_reward.fee, byType.draw_reward.status], ['in', '5', null, 'confirmed']);
});

test('history rejects a confirmed paid transition without final settlement', async () => {
  await assert.rejects(readEruHistory(fixture({ cooper: [{ id: id(2),
    status: 'confirmed', amount: '30', fee: '0.6', signature: null, created_at: at }] }),
  user, 'gateway'), /settlement missing/);
});
