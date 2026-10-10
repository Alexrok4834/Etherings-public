import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSilverKeeper } from '../src/silver-keeper.js';
import { drawBoxIdentity } from '../src/draw-box-identity.js';
import { adminBoxIdentity } from '../src/admin-box-identity.js';

test('keeper includes one confirmed Draw Box and derives its issuance identity', async () => {
  const account = randomUUID();
  const result = randomUUID();
  const wallet = '3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr';
  const program = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  const row = { account_id: account, wallet_address: wallet,
    draw_result_id: result, issuance_id: null };
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_silver_opening_finalizations')) return { rows: [] };
    assert.match(sql, /JOIN alpha_draw_fulfillments/);
    assert.match(sql, /f.state = 'CONFIRMED'/);
    assert.match(sql, /s.status = 'confirmed'/);
    return { rows: [row] };
  } };
  const chain = { async inspect(candidate) {
    assert.equal(candidate.issuance_id,
      drawBoxIdentity(account, wallet, result).issuanceId);
    return { phase: 'consumed' };
  } };
  const keeper = createSilverKeeper({ pool, chain, programId: program });
  assert.equal((await keeper.tick()).consumed, 1);
});

test('keeper includes confirmed breeding Box without changing opening path', async () => {
  const issuanceId = 'a'.repeat(64);
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_silver_opening_finalizations')) return { rows: [] };
    assert.match(sql, /alpha_cooper_breeding_settlements/);
    return { rows: [{ issuance_id: issuanceId, draw_result_id: null }] };
  } };
  const chain = { async inspect(candidate) {
    assert.equal(candidate.issuance_id, issuanceId);
    return { phase: 'consumed' };
  } };
  const keeper = createSilverKeeper({ pool, chain,
    programId: '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX',
    breedingEnabled: true });
  assert.equal((await keeper.tick()).consumed, 1);
});

test('keeper finalizes only a confirmed admin Box with matching issuance binding', async () => {
  const account = randomUUID();
  const operation = randomUUID();
  const wallet = '3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr';
  const identity = adminBoxIdentity(account, wallet, operation);
  const row = { account_id: account, wallet_address: wallet,
    admin_operation_id: operation, issuance_id: identity.issuanceId,
    admin_entitlement_digest: identity.entitlementDigest };
  const pool = { async query(sql) {
    if (sql.includes('FROM alpha_silver_opening_finalizations')) return { rows: [] };
    assert.match(sql, /JOIN alpha_admin_box_grants g/);
    assert.match(sql, /g.state = 'CONFIRMED'/);
    assert.match(sql, /s.status = 'confirmed'/);
    return { rows: [row] };
  } };
  const chain = { async inspect(candidate) {
    assert.equal(candidate.issuance_id, identity.issuanceId);
    return { phase: 'consumed' };
  } };
  const keeper = createSilverKeeper({ pool, chain,
    programId: '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX' });
  assert.equal((await keeper.tick()).consumed, 1);
  row.admin_entitlement_digest = '0'.repeat(64);
  await assert.rejects(keeper.tick(), /admin Box binding mismatch/);
});
