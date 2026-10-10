import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { createStarterCooper } from '../src/starter-cooper.js';
import { resolveM2eUnboundCooperCount } from '../src/m2e-ring-inputs.js';

const disposableUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!disposableUrl || new URL(disposableUrl).pathname !== '/alpha_report_disposable')
  throw new Error('ALPHA_TEST_DATABASE_URL must target alpha_report_disposable');

test('owner report grant adds one usable Cooper and exact audited ERT once', async () => {
  const schema = `alpha_report_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: disposableUrl });
  const scoped = new URL(disposableUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: scoped.toString(), max: 2 });
    const files = (await readdir(new URL('../schema/', import.meta.url)))
      .filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
    assert.equal(files.length, 37);
    for (const file of files)
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));

    const actorId = randomUUID();
    const targetId = randomUUID();
    const token = 'a'.repeat(64);
    const op = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts
      (id,email_normalized,password_hash,verified_at,is_admin) VALUES
      ($1,'report-admin@example.invalid','synthetic',now(),true),
      ($2,'report-user@example.invalid','synthetic',now(),false)`, [actorId, targetId]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), targetId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings
      (account_id,wallet_address,environment) VALUES
      ($1,'5h7zVML8RPRME1rED8RbGmcyhUZmkXQFcm5HzP2H9AGX','alpha-public')`,
    [targetId]);
    const starter = createStarterCooper({ pool, walletEnvironment: 'alpha-public',
      sample: (min) => min });
    assert.equal((await starter.claim(token)).status, 200);
    await pool.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)`, [targetId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'seed-report-test',4.634952146341463415)`, [randomUUID(), targetId]);

    const env = { ...process.env, ALPHA_DATABASE_URL: scoped.toString(),
      REPORT_ACTOR_EMAIL: 'report-admin@example.invalid',
      REPORT_TARGET_EMAIL: 'report-user@example.invalid', REPORT_OPERATION_ID: op };
    const script = fileURLToPath(new URL('../deploy/prepare-report-account.mjs', import.meta.url));
    const first = JSON.parse(execFileSync(process.execPath, [script],
      { env, encoding: 'utf8' }));
    assert.equal(first.status, 'created');
    assert.equal(first.ertCreditExact, '2170.365047853658536585');
    const second = JSON.parse(execFileSync(process.execPath, [script],
      { env, encoding: 'utf8' }));
    assert.equal(second.status, 'replay');
    assert.equal(second.ringId, first.ringId);
    assert.equal((await starter.inventory(token)).body.rings.length, 2);
    assert.equal(await resolveM2eUnboundCooperCount({ client: pool, accountId: targetId }), 2);
    await pool.query(`UPDATE alpha_ring_selection SET ring_id = $1 WHERE account_id = $2`,
      [first.ringId, targetId]);
    assert.equal((await starter.inventory(token)).body.rings.find(
      ring => ring.id === first.ringId).equipped, true);
    const facts = (await pool.query(`SELECT
      (SELECT count(*)::integer FROM alpha_admin_cooper_rings) AS grants,
      (SELECT count(*)::integer FROM alpha_ert_admin_credits) AS credits,
      (SELECT available::text FROM alpha_ert_available WHERE account_id=$1) AS available`,
    [targetId])).rows[0];
    assert.deepEqual(facts, { grants: 1, credits: 1, available: '2175.000000000000000000' });
    await assert.rejects(pool.query(`DELETE FROM alpha_admin_cooper_rings WHERE ring_id=$1`,
      [first.ringId]), /immutable/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
