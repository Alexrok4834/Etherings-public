import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createCooperPointAllocation } from '../src/cooper-point-allocation.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must be disposable PostgreSQL');

test('MVP bulk Points semantics port to Alpha owner/Ring with durable replay and audit', async () => {
  const schema = 'alpha_points_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '013_alpha_starter_cooper.sql',
      '015_alpha_ring_equipment.sql', '019_alpha_cooper_current_state.sql',
      '020_alpha_cooper_point_allocation.sql', '016_alpha_m2e_daily_accounting.sql',
      '034_alpha_m2e_comfort_epochs.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const up = await readFile(new URL('../schema/020_alpha_cooper_point_allocation.sql',
      import.meta.url), 'utf8');
    const down = await readFile(new URL(
      '../schema/rollback/020_alpha_cooper_point_allocation.sql', import.meta.url), 'utf8');
    await pool.query(down);
    await pool.query(up);
    const accountId = randomUUID();
    const otherId = randomUUID();
    const ringId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'points@example.invalid','synthetic',now()),
             ($2,'other-points@example.invalid','synthetic',now())`, [accountId, otherId]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',20,10,8,6)`, [accountId, ringId, randomUUID()]);
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 4, unspent_attribute_points = 12 WHERE account_id = $1`, [accountId]);
    const auth = { async me(token) {
      if (token === 'owner') return { status: 200, body: { id: accountId } };
      if (token === 'other') return { status: 200, body: { id: otherId } };
      return { status: 401, body: { code: 'AUTH_REQUIRED' } };
    } };
    const service = createCooperPointAllocation({ pool, auth });
    const request = { expectedUnspentPoints: 12,
      allocation: { comfort: 5, charm: 3, quality: 4, luck: 0 },
      idempotencyKey: randomUUID() };
    assert.equal((await service.allocate('bad', ringId, request)).status, 401);
    assert.equal((await service.allocate('other', ringId, request)).body.code, 'RING_NOT_FOUND');
    assert.equal((await service.allocate('owner', ringId,
      { ...request, allocation: { ...request.allocation, comfort: 77 } })).status, 400);
    const first = await service.allocate('owner', ringId, request);
    assert.equal(first.status, 200);
    assert.equal(first.body.rulesVersion, 'copper-attribute-allocation-v2');
    assert.deepEqual(first.body.attributes.current,
      { comfort: 25, charm: 13, quality: 12, luck: 6 });
    assert.deepEqual(first.body.unspentAttributePoints,
      { previous: 12, spent: 12, current: 0 });
    assert.deepEqual((await service.allocate('owner', ringId, request)).body, first.body);
    assert.equal((await service.allocate('owner', ringId,
      { ...request, allocation: { comfort: 4, charm: 4, quality: 4, luck: 0 } }))
      .body.code, 'RING_ATTRIBUTE_ALLOCATION_IDEMPOTENCY_CONFLICT');
    assert.equal((await service.allocate('owner', ringId,
      { ...request, idempotencyKey: randomUUID() })).body.code,
    'RING_ATTRIBUTE_POINTS_STALE');
    assert.deepEqual((await pool.query(`SELECT comfort, charm, quality, luck,
      unspent_attribute_points FROM alpha_cooper_current_state WHERE account_id = $1`,
    [accountId])).rows[0], { comfort: 25, charm: 13, quality: 12, luck: 6,
      unspent_attribute_points: 0 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_point_events'))
      .rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_point_allocations'))
      .rows[0].n, 1);
    assert.deepEqual((await pool.query('SELECT snapshot FROM alpha_cooper_point_events'))
      .rows[0].snapshot, first.body);
    assert.deepEqual((await pool.query('SELECT response_snapshot FROM alpha_cooper_point_allocations'))
      .rows[0].response_snapshot, first.body);
    assert.equal((await pool.query(`SELECT comfort FROM alpha_starter_cooper
      WHERE account_id = $1`, [accountId])).rows[0].comfort, 20);
    await assert.rejects(() => pool.query('DELETE FROM alpha_cooper_point_events'), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_point_allocations
      SET response_snapshot = '{}'::jsonb`), /immutable/);
    await assert.rejects(() => pool.query(down),
    /rollback would discard it/);

    await pool.query(`UPDATE alpha_cooper_current_state
      SET unspent_attribute_points = 4 WHERE account_id = $1`, [accountId]);
    const race = await Promise.all([service.allocate('owner', ringId, {
      expectedUnspentPoints: 4, allocation: { comfort: 4, charm: 0, quality: 0, luck: 0 },
      idempotencyKey: randomUUID(),
    }), service.allocate('owner', ringId, {
      expectedUnspentPoints: 4, allocation: { comfort: 0, charm: 4, quality: 0, luck: 0 },
      idempotencyKey: randomUUID(),
    })]);
    assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
    assert.equal((await pool.query(`SELECT unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId]))
      .rows[0].unspent_attribute_points, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_point_events'))
      .rows[0].n, 2);

    await pool.query(`UPDATE alpha_cooper_current_state
      SET unspent_attribute_points = 4 WHERE account_id = $1`, [accountId]);
    await pool.query(`CREATE FUNCTION reject_point_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_point_event BEFORE INSERT ON alpha_cooper_point_events
      FOR EACH ROW EXECUTE FUNCTION reject_point_event()`);
    const recoverable = { expectedUnspentPoints: 4,
      allocation: { comfort: 0, charm: 0, quality: 0, luck: 4 },
      idempotencyKey: randomUUID() };
    await assert.rejects(() => service.allocate('owner', ringId, recoverable),
      /injected audit failure/);
    assert.equal((await pool.query(`SELECT unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId]))
      .rows[0].unspent_attribute_points, 4);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_cooper_point_allocations
      WHERE idempotency_key = $1`, [recoverable.idempotencyKey])).rows[0].n, 0);
    await pool.query('DROP TRIGGER reject_point_event ON alpha_cooper_point_events');
    await pool.query('DROP FUNCTION reject_point_event()');
    assert.equal((await service.allocate('owner', ringId, recoverable)).status, 200);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
