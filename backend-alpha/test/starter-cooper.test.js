import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createAuth } from '../src/auth.js';
import { CaptureMailTransport } from '../src/mail.js';
import { resolveM2eRingInputsInTransaction } from '../src/m2e-ring-inputs.js';
import { createStarterCooper } from '../src/starter-cooper.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');

test('starter Cooper is account-bound, atomic, concurrent and restart-idempotent', async () => {
  const schema = 'alpha_starter_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '013_alpha_starter_cooper.sql', '015_alpha_ring_equipment.sql',
      '019_alpha_cooper_current_state.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    // The starter inventory reader also projects optional Draw Coopers. This
    // focused fixture has no Draw result, but needs its empty projection table.
    await pool.query(`CREATE TABLE alpha_draw_cooper_rings (
      ring_id uuid PRIMARY KEY, account_id uuid NOT NULL,
      visual_variant_code text NOT NULL, visual_set_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE alpha_admin_cooper_rings (
      ring_id uuid PRIMARY KEY, account_id uuid NOT NULL,
      visual_variant_code text NOT NULL, visual_set_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    const accountId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const digest = createHash('sha256').update(token).digest('hex');
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'starter@example.invalid','synthetic',now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,now() + interval '1 hour')`, [digest, accountId]);
    const values = [2, 20, 7, 11, 8];
    const calls = [];
    const sample = (min, max) => {
      calls.push([min, max]);
      return values[calls.length - 1];
    };
    const service = () => createStarterCooper({ pool, walletEnvironment: 'alpha-dev', sample });
    const beforeWallet = await service().claim(token);
    assert.equal(beforeWallet.status, 200);
    assert.equal(beforeWallet.body.walletBound, false);
    assert.equal(beforeWallet.body.ring.equipped, true);
    assert.equal((await service().inventory(token)).status, 200);
    assert.equal((await service().claim(null)).status, 401);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,'2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc','alpha-dev')`, [accountId]);
    const results = await Promise.all(Array.from({ length: 8 }, () => service().claim(token)));
    assert(results.every(result => result.status === 200));
    assert(results.every(result => result.body.walletBound === true));
    assert(results.every(result => result.body.ring.id === results[0].body.ring.id));
    assert.deepEqual(calls, [[2, 21], [2, 21], [2, 21], [2, 21], [0, 9]]);
    const ring = results[0].body.ring;
    assert.deepEqual(ring.attributes, { comfort: 2, charm: 20, quality: 7, luck: 11 });
    assert.equal(ring.visualVariantCode, 'copper_signet');
    assert.equal(ring.equipped, true);
    assert.equal(ring.equippedAt.toISOString(), ring.createdAt.toISOString());
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_starter_cooper')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_current_state')).rows[0].n, 1);
    assert.deepEqual((await service().inventory(token)).body.ring, ring);
    assert.deepEqual((await service().claim(token)).body.ring, ring);
    await assert.rejects(() => pool.query(`UPDATE alpha_starter_cooper SET comfort = 3
      WHERE account_id = $1`, [accountId]), /immutable/);
    await pool.end();
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4,
      options: `-c search_path=${schema}` });
    assert.deepEqual((await service().claim(token)).body.ring, ring);
    const second = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'second@example.invalid','synthetic',now())`, [second]);
    const secondToken = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,now() + interval '1 hour')`,
    [createHash('sha256').update(secondToken).digest('hex'), second]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,'3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr','alpha-dev')`, [second]);
    const invalid = createStarterCooper({ pool, walletEnvironment: 'alpha-dev',
      sample: () => 21 });
    await assert.rejects(() => invalid.claim(secondToken), /out-of-contract/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_starter_cooper')).rows[0].n, 1);
    await pool.query(`UPDATE alpha_cooper_current_state SET level = 2,
      unspent_attribute_points = 4, comfort = 3, updated_at = now()
      WHERE account_id = $1`, [accountId]);
    const progressed = (await service().inventory(token)).body.ring;
    assert.equal(progressed.id, ring.id);
    assert.equal(progressed.level, 2);
    assert.equal(progressed.unspentAttributePoints, 4);
    assert.equal(progressed.attributes.comfort, 3);
    const historical = (await pool.query(`SELECT level, comfort FROM alpha_starter_cooper
      WHERE account_id = $1`, [accountId])).rows[0];
    assert.deepEqual(historical, { level: 1, comfort: 2 });
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_current_state
      SET ring_id = $1 WHERE account_id = $2`, [randomUUID(), accountId]),
    /identity are immutable/);
    const inputs = await resolveM2eRingInputsInTransaction({ client: pool, accountId,
      chain: { async listOwnedRings() { return []; },
        async readEquipmentEligibility() { throw new Error('not needed'); } },
      programId: 'disposable-program', cluster: 'devnet',
      walletAddress: 'disposable-wallet' });
    assert.equal(inputs.selectedRingComfort, 3);
    assert.equal(inputs.ringCount, 1);
    const rollback = await readFile(new URL('../schema/rollback/019_alpha_cooper_current_state.sql',
      import.meta.url), 'utf8');
    await assert.rejects(() => pool.query(rollback), /rollback would discard current gameplay state/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('Cooper current-state migration backfills and guarded rollback preserves starter history', async () => {
  const schema = 'alpha_cooper_migration_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '013_alpha_starter_cooper.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const accountId = randomUUID();
    const ringId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'migration@example.invalid','synthetic',now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',7,8,9,10)`, [accountId, ringId, randomUUID()]);
    const up = await readFile(new URL('../schema/019_alpha_cooper_current_state.sql',
      import.meta.url), 'utf8');
    const down = await readFile(new URL('../schema/rollback/019_alpha_cooper_current_state.sql',
      import.meta.url), 'utf8');
    await pool.query(up);
    const current = (await pool.query(`SELECT ring_id, level, comfort,
      unspent_attribute_points FROM alpha_cooper_current_state WHERE account_id = $1`,
    [accountId])).rows[0];
    assert.deepEqual(current, { ring_id: ringId, level: 1, comfort: 7,
      unspent_attribute_points: 0 });
    await pool.query(down);
    assert.equal((await pool.query(`SELECT level FROM alpha_starter_cooper
      WHERE account_id = $1`, [accountId])).rows[0].level, 1);
    await pool.query(up);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_current_state'))
      .rows[0].n, 1);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('email verification creates Cooper and initial selection before wallet binding atomically', async () => {
  const schema = 'alpha_starter_verify_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '013_alpha_starter_cooper.sql', '015_alpha_ring_equipment.sql',
      '019_alpha_cooper_current_state.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    await pool.query(`CREATE TABLE alpha_draw_cooper_rings (
      ring_id uuid PRIMARY KEY, account_id uuid NOT NULL,
      visual_variant_code text NOT NULL, visual_set_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    const mailer = new CaptureMailTransport();
    const starter = createStarterCooper({ pool, walletEnvironment: 'alpha-dev' });
    const options = { pool, mailer, codeSecret: 'disposable-proof-only-secret-with-32-chars' };
    const email = 'verify-starter@example.invalid';
    const register = createAuth(options);
    assert.equal((await register.register({ email, password: 'disposable-password' })).status, 202);
    const code = mailer.messages[0].code;
    const failed = createAuth({ ...options, onVerified: async (client, id) => {
      await starter.ensureForAccount(client, id);
      throw new Error('proof rollback');
    } });
    await assert.rejects(() => failed.verify({ email, code }), /proof rollback/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_starter_cooper')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_ring_selection')).rows[0].n, 0);
    const auth = createAuth({ ...options, onVerified: starter.ensureForAccount });
    const verified = await auth.verify({ email, code });
    assert.equal(verified.status, 200);
    const claimed = await starter.claim(verified.body.accessToken);
    assert.equal(claimed.body.walletBound, false);
    assert.equal(claimed.body.ring.equipped, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_starter_cooper')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_ring_equipment_events')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_wallet_bindings')).rows[0].n, 0);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
