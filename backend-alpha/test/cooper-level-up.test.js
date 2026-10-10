import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createCooperLevelUp } from '../src/cooper-level-up.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must be disposable PostgreSQL');

test('MVP Cooper 1..20 preview and Alpha ERT Level-Up stay exact and fail closed for ERU', async () => {
  const schema = 'alpha_level_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '006_alpha_hybrid_ert_foundation.sql',
      '013_alpha_starter_cooper.sql', '015_alpha_ring_equipment.sql',
      '019_alpha_cooper_current_state.sql', '020_alpha_cooper_point_allocation.sql',
      '021_alpha_cooper_level_up.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const up = await readFile(new URL('../schema/021_alpha_cooper_level_up.sql',
      import.meta.url), 'utf8');
    const down = await readFile(new URL('../schema/rollback/021_alpha_cooper_level_up.sql',
      import.meta.url), 'utf8');
    await pool.query(down);
    await pool.query(up);
    const accountId = randomUUID();
    const otherId = randomUUID();
    const ringId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'level@example.invalid','synthetic',now()),
             ($2,'foreign-level@example.invalid','synthetic',now())`, [accountId, otherId]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',20,10,8,6)`, [accountId, ringId, randomUUID()]);
    await pool.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)`, [accountId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'test-credit',100)`, [randomUUID(), accountId]);
    const auth = { async me(token) {
      if (token === 'owner') return { status: 200, body: { id: accountId } };
      if (token === 'other') return { status: 200, body: { id: otherId } };
      return { status: 401, body: { code: 'AUTH_REQUIRED' } };
    } };
    const service = createCooperLevelUp({ pool, auth });
    const mutation = (level, key = randomUUID()) => ({ expectedCurrentLevel: level,
      targetLevel: level + 1, idempotencyKey: key });
    assert.equal((await service.preview('bad', ringId,
      { expectedCurrentLevel: 1, targetLevel: 2 })).status, 401);
    assert.equal((await service.preview('other', ringId,
      { expectedCurrentLevel: 1, targetLevel: 2 })).body.code, 'RING_NOT_FOUND');
    assert.equal((await service.levelUp('other', ringId, mutation(1))).body.code, 'RING_NOT_FOUND');

    // Compare every adapted price against the existing MVP transition source.
    const mvpSource = await readFile(new URL('../../backend/src/ring/copper-level-up.rules.ts',
      import.meta.url), 'utf8');
    const prices = [...mvpSource.matchAll(/transition\((\d+), (\d+), (\d+)(?:, (\d+))?\)/g)];
    assert.equal(prices.length, 19);
    for (const [, from, to, ert, eru] of prices) {
      await pool.query(`UPDATE alpha_cooper_current_state
        SET level = $2, unspent_attribute_points = 0 WHERE account_id = $1`,
      [accountId, Number(from)]);
      const preview = await service.preview('owner', ringId,
        { expectedCurrentLevel: Number(from), targetLevel: Number(to) });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.cost.ertExact, ert);
      assert.equal(preview.body.cost.eruExact, eru ?? '0');
      assert.equal(preview.body.target.unspentAttributePoints, 4);
      assert.deepEqual(preview.body.target.attributes, preview.body.current.attributes);
      if (eru) {
        assert.equal(preview.body.available, false);
        assert(preview.body.blockers.includes('ERU_SETTLEMENT_UNAVAILABLE'));
      }
    }
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 1, unspent_attribute_points = 0 WHERE account_id = $1`, [accountId]);
    const request = mutation(1);
    const first = await service.levelUp('owner', ringId, request);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.level, { previous: 1, current: 2 });
    assert.deepEqual(first.body.unspentAttributePoints,
      { previous: 0, granted: 4, current: 4 });
    assert.equal(first.body.balances.ertBeforeExact, '100');
    assert.equal(first.body.balances.ertAfterExact, '88');
    assert.equal((await service.levelUp('owner', ringId, request)).body.operationId,
      first.body.operationId);
    assert.equal((await service.levelUp('owner', ringId,
      { ...request, targetLevel: 3 })).body.code, 'RING_LEVEL_IDEMPOTENCY_CONFLICT');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 1);
    const race = await Promise.all([service.levelUp('owner', ringId, mutation(2)),
      service.levelUp('owner', ringId, mutation(2))]);
    assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
    assert.equal((await pool.query(`SELECT level, unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows[0].level, 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 2);
    assert.deepEqual((await pool.query(`SELECT snapshot FROM alpha_cooper_level_up_events
      WHERE operation_id = $1`, [first.body.operationId])).rows[0].snapshot, first.body);
    assert.deepEqual((await pool.query(`SELECT response_snapshot
      FROM alpha_cooper_level_up_operations WHERE id = $1`,
    [first.body.operationId])).rows[0].response_snapshot, first.body);
    await pool.query(`CREATE FUNCTION reject_level_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected level audit failure'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_level_event
      BEFORE INSERT ON alpha_cooper_level_up_events
      FOR EACH ROW EXECUTE FUNCTION reject_level_event()`);
    const failedRequest = mutation(3);
    await assert.rejects(() => service.levelUp('owner', ringId, failedRequest),
      /injected level audit failure/);
    assert.equal((await pool.query(`SELECT level, unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows[0].level, 3);
    assert.match((await pool.query(`SELECT balance::text AS balance
      FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0].balance, /^72(?:\.0+)?$/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_up_operations WHERE idempotency_key = $1`,
    [failedRequest.idempotencyKey])).rows[0].n, 0);
    await pool.query('DROP TRIGGER reject_level_event ON alpha_cooper_level_up_events');
    await pool.query('DROP FUNCTION reject_level_event()');

    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 4, unspent_attribute_points = 12 WHERE account_id = $1`, [accountId]);
    const beforeGate = (await pool.query(`SELECT balance::text AS balance
      FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0].balance;
    const blocked = await service.levelUp('owner', ringId, mutation(4));
    assert.equal(blocked.body.code, 'ERU_SETTLEMENT_UNAVAILABLE');
    assert.equal((await pool.query(`SELECT level, unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows[0].level, 4);
    assert.equal((await pool.query(`SELECT balance::text AS balance
      FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0].balance, beforeGate);
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_up_operations`)).rows[0].n, 2);
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 19, unspent_attribute_points = 72 WHERE account_id = $1`, [accountId]);
    assert.equal((await service.levelUp('owner', ringId, mutation(19)))
      .body.code, 'ERU_SETTLEMENT_UNAVAILABLE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_level_up_events'))
      .rows[0].n, 2);
    assert.equal((await pool.query(`SELECT comfort FROM alpha_starter_cooper
      WHERE account_id = $1`, [accountId])).rows[0].comfort, 20);
    assert.equal((await pool.query(`SELECT comfort FROM alpha_cooper_current_state
      WHERE account_id = $1`, [accountId])).rows[0].comfort, 20);
    await assert.rejects(() => pool.query('DELETE FROM alpha_cooper_level_up_events'), /immutable/);
    await assert.rejects(() => pool.query(down), /rollback would discard it/);

    // Existing held reservations reduce spendable ERT; no spend may consume them.
    const reservationOperation = randomUUID();
    await pool.query(`INSERT INTO alpha_hybrid_operations
      (id,account_id,wallet_address,cluster,operation_type,request_digest,ert_amount)
      VALUES ($1,$2,'disposable-wallet','devnet','cooper_level_up',$3,60)`,
    [reservationOperation, accountId, 'a'.repeat(64)]);
    await pool.query(`INSERT INTO alpha_ert_reservations(id,operation_id,account_id,amount)
      VALUES ($1,$2,$3,60)`, [randomUUID(), reservationOperation, accountId]);
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 3, unspent_attribute_points = 8 WHERE account_id = $1`, [accountId]);
    const reservationPreview = await service.preview('owner', ringId,
      { expectedCurrentLevel: 3, targetLevel: 4 });
    assert.equal(reservationPreview.body.balances.ertExact, '72');
    assert.equal(reservationPreview.body.balances.ertAvailableExact, '12');
    assert.equal(reservationPreview.body.available, false);
    assert(reservationPreview.body.blockers.includes('INSUFFICIENT_ERT'));
    assert.equal((await service.levelUp('owner', ringId, mutation(3))).body.code,
      'INSUFFICIENT_ERT');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 2);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
