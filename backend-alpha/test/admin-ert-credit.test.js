import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createAdminErtCredit } from '../src/admin-ert-credit.js';
import { createAuth } from '../src/auth.js';
import { createAlphaServer } from '../src/server.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');

test('Alpha admin credit reuses exact ERT ledger with role, replay and audit guards', async () => {
  const schema = 'alpha_admin_credit_test_' + randomUUID().replaceAll('-', '');
  const root = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '006_alpha_hybrid_ert_foundation.sql',
      '018_alpha_ert_admin_credits.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL(
      '../schema/rollback/018_alpha_ert_admin_credits.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL(
      '../schema/018_alpha_ert_admin_credits.sql', import.meta.url), 'utf8'));

    const actor = randomUUID(), other = randomUUID();
    const target = randomUUID(), target2 = randomUUID();
    for (const [id, role, verified] of [[actor, true, true], [other, false, true],
      [target, false, true], [target2, false, true]])
      await pool.query(`INSERT INTO alpha_accounts
        (id, email_normalized, password_hash, verified_at, is_admin)
        VALUES ($1, $2, 'synthetic-only', $3, $4)`,
      [id, `${id}@example.invalid`, verified ? new Date() : null, role]);
    const adminToken = 'a'.repeat(64), ordinaryToken = 'b'.repeat(64);
    for (const [token, accountId] of [[adminToken, actor], [ordinaryToken, other]])
      await pool.query(`INSERT INTO alpha_sessions(token_hash, account_id, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest('hex'), accountId]);
    const auth = createAuth({ pool, mailer: { async sendVerification() {} },
      codeSecret: 'test-only-secret-01234567890123456789' });
    const credit = createAdminErtCredit({ pool, auth });
    const input = { idempotencyKey: randomUUID(), targetAccountId: target,
      amountExact: '12.000000000000000001', reason: 'Test progression funding' };
    assert.equal((await credit.credit('invalid', input)).status, 401);
    assert.equal((await credit.credit(ordinaryToken, input)).status, 403);
    assert.equal((await credit.credit(adminToken, { ...input, amountExact: '-1' })).status, 400);
    assert.equal((await credit.credit(adminToken, { ...input, amountExact: '1.0' })).status, 400);
    assert.equal((await credit.credit(adminToken, { ...input, reason: ' ' })).status, 400);
    assert.equal((await credit.credit(adminToken, { ...input,
      targetAccountId: randomUUID() })).status, 404);
    assert.equal((await pool.query('SELECT count(*) FROM alpha_ert_ledger')).rows[0].count, '0');

    const first = await credit.credit(adminToken, input);
    assert.equal(first.status, 200);
    assert.equal(first.body.replay, false);
    assert.equal(first.body.balanceAfterExact, input.amountExact);
    assert.equal(first.body.availableAfterExact, input.amountExact);
    assert.equal(first.body.amountDisplay, '12.00');
    assert.deepEqual((await credit.credit(adminToken, input)).body,
      { ...first.body, replay: true });
    assert.equal((await credit.credit(ordinaryToken, input)).status, 403);
    assert.equal((await credit.credit(adminToken, { ...input, amountExact: '13' })).status, 409);
    assert.equal((await credit.credit(adminToken, { ...input, targetAccountId: target2 })).status, 409);
    assert.equal((await pool.query('SELECT count(*) FROM alpha_ert_ledger')).rows[0].count, '1');
    const audit = (await pool.query(`SELECT actor_account_id, target_account_id, reason,
      amount::text AS amount, ledger_id FROM alpha_ert_admin_credits WHERE id = $1`,
    [input.idempotencyKey])).rows[0];
    assert.equal(audit.actor_account_id, actor);
    assert.equal(audit.target_account_id, target);
    assert.equal(audit.reason, input.reason);
    assert.equal(audit.ledger_id, first.body.ledgerId);
    assert.equal(audit.amount, input.amountExact);
    await assert.rejects(pool.query(`UPDATE alpha_ert_admin_credits SET reason = 'changed'
      WHERE id = $1`, [input.idempotencyKey]), { code: '23514' });
    await assert.rejects(pool.query(await readFile(new URL(
      '../schema/rollback/018_alpha_ert_admin_credits.sql', import.meta.url), 'utf8')),
    { code: '23514' });

    const raceKey = randomUUID();
    const competing = await Promise.all([
      credit.credit(adminToken, { ...input, idempotencyKey: raceKey, targetAccountId: target }),
      credit.credit(adminToken, { ...input, idempotencyKey: raceKey, targetAccountId: target2 }),
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    assert.equal((await pool.query(`SELECT count(*) FROM alpha_ert_ledger
      WHERE event_key = $1`, [`admin-credit:${raceKey}`])).rows[0].count, '1');

    const server = createAlphaServer(auth, null, null, null, null, null, null, null,
      undefined, null, null, null, credit);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/admin/ert/credit`;
      assert.equal((await fetch(url, { method: 'GET' })).status, 404);
      const send = (token, body) => fetch(url, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      assert.equal((await send('f'.repeat(64), input)).status, 401);
      assert.equal((await send(ordinaryToken, input)).status, 403);
      const replay = await send(adminToken, input);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).replay, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally {
    if (pool) await pool.end();
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
  }
});
