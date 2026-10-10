import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { createAdminCooperGrant } from '../src/admin-cooper-grant.js';
import { createAdminEruTransfer } from '../src/admin-eru-transfer.js';
import { createAdminBoxGrant } from '../src/admin-box-grant.js';
import { adminBoxIdentity } from '../src/admin-box-identity.js';
import { BOX_HASH, BOX_URI } from '../src/silver-issuer-chain.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Disposable Alpha PostgreSQL required');

test('admin grants keep role, identity, one operation per key and finalized state', async () => {
  const schema = 'alpha_admin_panel_' + randomUUID().replaceAll('-', '');
  const root = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema}`, max: 8 });
    const names = (await readdir(new URL('../schema/', import.meta.url)))
      .filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
    assert.equal(names.length, 41);
    for (const name of names)
      await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
    const actor = randomUUID(), target = randomUUID(), other = randomUUID();
    for (const [id, admin] of [[actor, true], [target, false], [other, false]])
      await pool.query(`INSERT INTO alpha_accounts
        (id,email_normalized,password_hash,verified_at,is_admin)
        VALUES ($1,$2,'synthetic-only',now(),$3)`,
      [id, `${id}@example.invalid`, admin]);
    const wallet = bs58.encode(Buffer.alloc(32, 9));
    const mint = bs58.encode(Buffer.alloc(32, 10));
    await pool.query(`INSERT INTO alpha_wallet_bindings
      (account_id,wallet_address,environment) VALUES ($1,$2,'alpha-public')`,
    [target, wallet]);
    const starter = randomUUID();
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_plain_polished',5,6,7,8)`,
    [target, starter, randomUUID()]);
    const auth = { async me(token) {
      if (token === 'admin') return { status: 200, body: { id: actor } };
      if (token === 'other') return { status: 200, body: { id: other } };
      return { status: 401, body: { code: 'UNAUTHORIZED' } };
    } };

    const cooper = createAdminCooperGrant({ pool, auth });
    const cooperInput = { idempotencyKey: randomUUID(), targetAccountId: target,
      reason: 'Test grant' };
    assert.equal((await cooper.grant('other', cooperInput)).status, 403);
    const awarded = await cooper.grant('admin', cooperInput);
    assert.equal(awarded.status, 200);
    assert.equal(awarded.body.replay, false);
    assert.equal((await cooper.grant('admin', cooperInput)).body.ringId,
      awarded.body.ringId);
    assert.equal((await cooper.grant('admin', { ...cooperInput,
      reason: 'Changed' })).status, 409);
    const rings = await pool.query(`SELECT g.issuance_reason, p.level,
      p.comfort FROM alpha_admin_cooper_rings g
      JOIN alpha_cooper_current_state p USING (account_id,ring_id)`);
    assert.deepEqual(rings.rows, [{ issuance_reason: 'admin-grant',
      level: 1, comfort: 5 }]);

    const eruSignature = bs58.encode(Buffer.alloc(64, 11));
    let eruSends = 0;
    const eruChain = {
      async adminRemaining() { return 20_000_000_000_000n; },
      async buildAdmin({ amountBaseUnits }) {
        assert.equal(amountBaseUnits, '50000000000');
        return { signature: eruSignature, rawTransactionBase64: 'dGVzdA==',
          blockhash: wallet, lastValidBlockHeight: 500 };
      },
      async send() { eruSends++; },
      async status() { return { confirmationStatus: 'finalized', err: null }; },
      async readAdminFinalized(id, recipient, amount, signature) {
        assert.equal(recipient, wallet);
        assert.equal(signature, eruSignature);
        return { signature, amountBaseUnits: amount };
      },
    };
    const eru = createAdminEruTransfer({ pool, auth, chain: eruChain });
    const eruInput = { idempotencyKey: randomUUID(), walletAddress: wallet,
      amountExact: '50', reason: 'Test payout' };
    assert.equal((await eru.create('other', eruInput)).status, 403);
    assert.equal((await eru.create('admin', { ...eruInput,
      amountExact: '50.000000001' })).status, 400);
    assert.equal((await eru.create('admin', eruInput)).status, 202);
    assert.equal((await eru.create('admin', eruInput)).status, 202);
    assert.equal((await eru.create('admin', { ...eruInput, reason: 'Changed' })).status, 409);
    assert.equal((await eru.tick()).state, 'UNKNOWN');
    assert.equal((await eru.tick()).state, 'CONFIRMED');
    assert.equal((await eru.get('admin', eruInput.idempotencyKey)).body.state, 'CONFIRMED');
    assert.equal(eruSends, 1);

    const boxSignature = bs58.encode(Buffer.alloc(64, 12));
    let boxSends = 0;
    const boxChain = {
      issuerAddress: wallet,
      async build(row) {
        assert.equal(row.issuance_source, 'admin-grant');
        return { signature: boxSignature, rawTransactionBase64: 'dGVzdA==',
          blockhash: wallet, lastValidBlockHeight: 500, mintAddress: mint };
      },
      async send() { boxSends++; },
      async status() { return { confirmationStatus: 'finalized', err: null }; },
    };
    const reader = { async readFinalized(input) {
      return { finalized: true, kind: 'SILVER_BOX', issuanceSource: 'admin-grant',
        adminOperationId: input.expectedAdminOperationId, accountId: target,
        originalRecipient: wallet, tokenOwner: wallet, lifecycle: 'SEALED',
        issuanceId: input.issuanceId,
        entitlementDigest: adminBoxIdentity(target, wallet,
          input.expectedAdminOperationId).entitlementDigest,
        mintAddress: mint, uri: BOX_URI, contentHash: BOX_HASH,
        supply: '1', tokenAmount: '1', mintAuthority: null,
        freezeAuthority: null };
    } };
    const box = createAdminBoxGrant({ pool, auth, chain: boxChain, reader,
      programId: wallet });
    const boxInput = { idempotencyKey: randomUUID(), targetAccountId: target,
      reason: 'Test Box' };
    assert.equal((await box.create('other', boxInput)).status, 403);
    assert.equal((await box.create('admin', boxInput)).status, 202);
    assert.equal((await box.create('admin', boxInput)).status, 202);
    assert.equal((await box.create('admin', { ...boxInput,
      reason: 'Changed' })).status, 409);
    assert.equal((await box.tick()).state, 'UNKNOWN');
    assert.equal((await box.tick()).state, 'CONFIRMED');
    assert.equal((await box.list('admin')).body.grants[0].state, 'CONFIRMED');
    assert.equal(boxSends, 1);
  } finally {
    if (pool) await pool.end();
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
  }
});
