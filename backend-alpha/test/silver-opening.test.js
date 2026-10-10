import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAlphaServer } from '../src/server.js';
import { createSilverOpeningPreflight } from '../src/silver-opening.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const key = () => bs58.encode(randomBytes(32));
const hash = value => createHash('sha256').update(value).digest('hex');

test('opening preflight is authenticated, bound and never issues signing bytes', async () => {
  const schema = 'alpha_open_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql']) {
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    }
    const accountId = randomUUID();
    const walletAddress = key();
    const token = randomBytes(32).toString('hex');
    const mintAddress = key();
    const programId = key();
    const now = 1_790_000_000_000;
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'opening@example.invalid','synthetic-only',to_timestamp($2))`, [accountId, now / 1000]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-dev')`, [accountId, walletAddress]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,to_timestamp($3))`, [hash(token), accountId, now / 1000 + 3600]);

    let assets = [{ kind: 'SILVER_BOX', mintAddress, lifecycle: 'SEALED',
      cooldownUntilUnixSeconds: '0' }];
    let escrowMutation = {};
    let escrowReads = 0;
    const silver = { inventory: async () => ({ status: 200, body: { assets } }) };
    const chain = { readEscrow: async input => {
      escrowReads++;
      return { finalized: true, cluster: 'devnet', address: input.escrowAddress,
        programOwner: TOKEN_2022_PROGRAM_ADDRESS, mintAddress,
        authority: input.escrowAuthority, amount: '0', ...escrowMutation };
    } };
    const opening = () => createSilverOpeningPreflight({ pool, silver, chain, cluster: 'devnet',
      programId, walletEnvironment: 'alpha-dev', now: () => now });
    const serve = async enabled => {
      server = createAlphaServer({}, {}, null, null, enabled ? opening() : null);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    };
    const close = async () => {
      await new Promise(resolve => server.close(resolve));
      server = null;
    };
    const post = async (body, bearer = token) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/silver/opening/preflight`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    await serve(false);
    assert.equal((await post({ mintAddress })).status, 404);
    await close();
    await serve(true);
    assert.equal((await post({ mintAddress }, null)).status, 401);
    assert.equal((await post({ mintAddress }, randomBytes(32).toString('hex'))).status, 401);
    assert.equal((await post({ mintAddress, walletAddress })).status, 400);
    assert.equal((await post({ mintAddress: key() })).status, 409);
    assert.equal(escrowReads, 0);
    await pool.query('UPDATE alpha_accounts SET verified_at = NULL WHERE id = $1', [accountId]);
    assert.equal((await post({ mintAddress })).status, 401);
    await pool.query('UPDATE alpha_accounts SET verified_at = to_timestamp($2) WHERE id = $1',
      [accountId, now / 1000]);
    await pool.query('DELETE FROM alpha_wallet_bindings WHERE account_id = $1', [accountId]);
    assert.equal((await post({ mintAddress })).status, 409);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'wrong-environment')`, [accountId, walletAddress]);
    assert.equal((await post({ mintAddress })).status, 409);
    await pool.query(`UPDATE alpha_wallet_bindings SET environment = 'alpha-dev' WHERE account_id = $1`,
      [accountId]);
    assets = [];
    assert.equal((await post({ mintAddress })).status, 409);
    assets = [{ kind: 'SILVER_BOX', mintAddress, lifecycle: 'SEALED',
      cooldownUntilUnixSeconds: String(now / 1000 + 1) }];
    assert.equal((await post({ mintAddress })).status, 409);
    assets[0].cooldownUntilUnixSeconds = '0';
    for (const mutation of [{ finalized: false }, { cluster: 'local-validator' },
      { address: key() }, { programOwner: programId }, { mintAddress: key() },
      { authority: key() }, { amount: '1' }]) {
      escrowMutation = mutation;
      assert.equal((await post({ mintAddress })).status, 409);
    }
    escrowMutation = {};
    const valid = await post({ mintAddress });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.walletAddress, walletAddress);
    assert.equal(valid.body.cluster, 'devnet');
    assert.equal(valid.body.signingEnabled, false);
    assert.deepEqual(Object.keys(valid.body).sort(),
      ['cluster', 'escrowAddress', 'mintAddress', 'signingEnabled', 'walletAddress']);
    await close();
    await pool.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await serve(true);
    assert.deepEqual(await post({ mintAddress }), valid);
    await pool.query('UPDATE alpha_sessions SET expires_at = to_timestamp($2) WHERE token_hash = $1',
      [hash(token), now / 1000 - 1]);
    assert.equal((await post({ mintAddress })).status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
