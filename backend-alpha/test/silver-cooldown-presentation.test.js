import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRingEquipment } from '../src/ring-equipment.js';
import { createSilverProgression } from '../src/silver-progression.js';

const mint = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const wallet = 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX';

test('owned Silver cooldown preview returns exact chain expiry without reserving ERT', async () => {
  let connected = false;
  const until = String(Math.floor(Date.now() / 1000) + 3600);
  const pool = {
    connect: async () => { connected = true; throw new Error('unexpected DB mutation'); },
    query: async sql => {
      if (sql.includes('FROM alpha_wallet_bindings')) return { rows: [{ wallet_address: wallet }] };
      if (sql.includes('FROM alpha_silver_progression_operations')) return { rows: [] };
      if (sql.includes('FROM alpha_silver_opening_finalizations')) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const chain = { listOwnedRings: async () => [{ mintAddress: mint, tokenOwner: wallet,
    kind: 'SILVER_RING', cluster: 'devnet', programId: mint, issuanceId: 'a'.repeat(64),
    boxMint: wallet, cooldownUntilUnixSeconds: until, level: 1 }] };
  const progression = createSilverProgression({ pool, chain, programId: mint,
    auth: { me: async () => ({ status: 200, body: { id: randomUUID() } }) } });
  const result = await progression.prepare('token', mint, { expectedCurrentLevel: 1,
    targetLevel: 2, idempotencyKey: randomUUID() });
  assert.deepEqual(result, { status: 409, body: { code: 'SILVER_RING_COOLDOWN',
    cooldownUntilUnixSeconds: until } });
  assert.equal(connected, false);
});

test('Silver Equip cooldown returns chain expiry without changing selection', async () => {
  const starter = randomUUID();
  const until = String(Math.floor(Date.now() / 1000) + 3600);
  let rolledBack = false;
  const client = { release() {}, async query(sql) {
    if (sql === 'BEGIN') return { rows: [] };
    if (sql === 'ROLLBACK') { rolledBack = true; return { rows: [] }; }
    if (sql.includes('FROM alpha_sessions')) return { rows: [{ id: randomUUID(),
      wallet_address: wallet, environment: 'alpha-dev' }] };
    if (sql.includes('FROM alpha_ring_equipment_operations')) return { rows: [] };
    if (sql.includes('FROM alpha_ring_selection')) return { rows: [{
      ring_kind: 'COOPER', ring_id: starter, version: '1' }] };
    throw new Error(`unexpected mutation: ${sql}`);
  } };
  const equipment = createRingEquipment({ pool: { connect: async () => client },
    chain: { readEquipmentEligibility: async () => ({ state: 'COOLDOWN',
      cooldownUntilUnixSeconds: until }) }, programId: mint, cluster: 'devnet',
    walletEnvironment: 'alpha-dev' });
  const result = await equipment.equip('a'.repeat(64), {
    contractVersion: 'alpha-ring-equipment-v1',
    expectedCurrent: { kind: 'COOPER', id: starter }, expectedVersion: '1',
    target: { kind: 'SILVER_RING', id: mint }, idempotencyKey: randomUUID(),
  });
  assert.deepEqual(result, { status: 409, body: { code: 'SILVER_RING_COOLDOWN',
    cooldownUntilUnixSeconds: until } });
  assert.equal(rolledBack, true);
});
