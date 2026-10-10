import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createSilverIssuer } from '../src/silver-issuer.js';
import { firstEntryIdentity } from '../src/silver-first-entry.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const PROGRAM = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const WALLET = '3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr';
const URI = 'ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png';
const HASH = 'e86589ee25bcaa5c2a5dc8a708adecce7955955a2529310796d5a0fe3db67d37';

test('Silver issuance persists signed attempt before send and confirms once after restart', async () => {
  const schema = 'alpha_issuer_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '007_alpha_silver_first_entry.sql', '009_alpha_silver_state_finality.sql',
      '014_alpha_silver_issuance_attempts.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const accountId = randomUUID();
    const identity = firstEntryIdentity(accountId, WALLET, 'devnet');
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'issuer@example.invalid','synthetic',now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-dev')`, [accountId, WALLET]);
    await pool.query(`INSERT INTO alpha_silver_first_entry
      (account_id,wallet_address,cluster,issuance_id,entitlement_digest)
      VALUES ($1,$2,'devnet',$3,$4)`,
    [accountId, WALLET, identity.issuanceId, identity.entitlementDigest]);
    let observation = null;
    let status = null;
    let height = 100;
    let builds = 0;
    let sends = 0;
    const chain = { issuerAddress: 'FsYtNsVfPbox56MswyRxfS1v5pBGBzvptWfUt167ohQG',
      async build() { builds++; return { signature: `signature-${builds}`,
        rawTransactionBase64: Buffer.from(`signed-${builds}`).toString('base64'),
        blockhash: `blockhash-${builds}`, lastValidBlockHeight: height + 100,
        mintAddress: '2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq',
        tokenAddress: 'D7GJguPdDt3v8XzsMvQv2Sso22k32no5DQvmdR29eAby',
        issuerAddress: this.issuerAddress }; },
      async send(attempt) { sends++; const stored = (await pool.query(
        'SELECT signature FROM alpha_silver_issuance_attempts WHERE signature = $1',
        [attempt.signature])).rows[0];
        assert(stored, 'signed operation must exist before broadcast');
        return attempt.signature; },
      async status() { return status; }, async blockHeight() { return height; } };
    const reader = { async readFinalized() { return observation; } };
    const worker = () => createSilverIssuer({ pool, chain, reader, programId: PROGRAM });
    assert.equal((await worker().tick()).unknown, 1);
    assert.equal(builds, 1);
    assert.equal(sends, 1);
    assert.equal((await worker().tick()).unknown, 1);
    assert.equal(builds, 1);
    status = { confirmationStatus: 'finalized', err: null };
    observation = { finalized: true, programId: PROGRAM, cluster: 'devnet',
      kind: 'SILVER_BOX', issuanceId: identity.issuanceId,
      entitlementDigest: identity.entitlementDigest, accountId,
      issuanceSource: 'first-entry', originalRecipient: WALLET,
      tokenOwner: WALLET, lifecycle: 'SEALED',
      mintAddress: '2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq',
      supply: '1', decimals: 0, tokenAmount: '1', mintAuthority: null,
      freezeAuthority: null, uri: URI, contentHash: HASH, issuanceSlot: '504000000' };
    observation = { ...observation, contentHash: '0'.repeat(64) };
    await assert.rejects(() => worker().tick(), /state mismatch/);
    assert.equal((await pool.query(`SELECT status FROM alpha_silver_first_entry
      WHERE account_id = $1`, [accountId])).rows[0].status, 'pending');
    observation = { ...observation, contentHash: HASH };
    assert.equal((await worker().tick()).confirmed, 1);
    assert.equal((await worker().tick()).confirmed, 0);
    assert.equal((await pool.query(`SELECT status FROM alpha_silver_first_entry
      WHERE account_id = $1`, [accountId])).rows[0].status, 'confirmed');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_silver_issuance_attempts`))
      .rows[0].n, 1);
    await assert.rejects(() => pool.query(`UPDATE alpha_silver_issuance_attempts
      SET signature = 'other' WHERE account_id = $1`, [accountId]), /immutable/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
