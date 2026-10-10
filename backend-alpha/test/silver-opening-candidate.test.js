import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { getAddressEncoder, getProgramDerivedAddress, address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAlphaServer } from '../src/server.js';
import { createSilverOpeningPreflight } from '../src/silver-opening.js';
import { createSilverOpeningCandidateIntent } from '../src/silver-opening-candidate.js';
import { verifySilverOpeningCandidateMessage } from '../src/silver-opening-intent.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable PostgreSQL');
const key = () => bs58.encode(randomBytes(32));
const hash = value => createHash('sha256').update(value).digest('hex');

for (const cluster of ['local-validator', 'devnet']) test(`${cluster} candidate opening intent binds session, wallet and immutable chain snapshot before signing`, async () => {
  const schema = 'alpha_open_candidate_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const name of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '008_alpha_silver_opening_candidate_intents.sql',
      '010_alpha_silver_opening_devnet_candidates.sql']) {
      await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
    }
    const accountId = randomUUID();
    const walletAddress = key();
    const otherWallet = key();
    const token = randomBytes(32).toString('hex');
    const mintAddress = key();
    const programId = key();
    const genesisHash = cluster === 'devnet'
      ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : key();
    const sourceTokenAddress = key();
    const oraoTreasury = key();
    const blockhash = key();
    const now = 1_790_000_000_000;
    const [escrowAuthority] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-escrow'),
        getAddressEncoder().encode(address(mintAddress))] });
    const [escrowAddress] = await findAssociatedTokenPda({ mint: address(mintAddress),
      owner: escrowAuthority, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'opening-candidate@example.invalid','synthetic-only',to_timestamp($2))`,
    [accountId, now / 1000]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [accountId, walletAddress]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,to_timestamp($3))`, [hash(token), accountId, now / 1000 + 3600]);

    let snapshotMutation = {};
    let inventoryAssets = [{ kind: 'SILVER_BOX', mintAddress, lifecycle: 'SEALED',
      cooldownUntilUnixSeconds: '0' }];
    let absent = true;
    const silver = { inventory: async () => ({ status: 200, body: { assets: inventoryAssets } }) };
    const chain = {
      readEscrow: async input => ({ finalized: true, cluster,
        address: input.escrowAddress, programOwner: TOKEN_2022_PROGRAM_ADDRESS,
        mintAddress, authority: input.escrowAuthority, amount: '0' }),
      readCandidateOpeningSnapshot: async () => ({ finalized: true, cluster,
        genesisHash, programId, mintAddress, walletAddress, escrowAddress,
        sourceTokenAddress, oraoTreasury, boxAmount: '1', escrowAmount: '0',
        lifecycle: 'SEALED', nextOperation: 1, designFrozen: true,
        designVersion: 1, designCommitment: 'a'.repeat(64), ...snapshotMutation }),
      isCandidateRequestAbsent: async () => absent,
      getCandidateBlockhash: async () => ({ genesisHash, blockhash,
        lastValidBlockHeight: 1000 }),
    };
    const serve = async enabled => {
      const opening = createSilverOpeningPreflight({ pool, silver, chain,
        cluster, programId, walletEnvironment: 'alpha-local', now: () => now });
      const candidate = createSilverOpeningCandidateIntent({ pool, preflight: opening, chain,
        programId, cluster, expectedGenesisHash: genesisHash, now: () => now });
      server = createAlphaServer({}, {}, null, null, opening, enabled ? candidate : null);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    };
    const close = async () => {
      await new Promise(resolve => server.close(resolve));
      server = null;
    };
    const post = async (body = { mintAddress }, bearer = token) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/silver/opening/candidate-intent`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const rows = async () => (await pool.query('SELECT * FROM alpha_silver_opening_candidate_intents')).rows;

    await serve(false);
    assert.equal((await post()).status, 404);
    await close();
    await serve(true);
    assert.equal((await post({ mintAddress }, null)).status, 401);
    assert.equal((await post({ mintAddress: key() })).status, 409);
    assert.equal((await post({ mintAddress, walletAddress: otherWallet })).status, 400);
    await pool.query('DELETE FROM alpha_wallet_bindings WHERE account_id = $1', [accountId]);
    assert.equal((await post()).status, 409);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [accountId, otherWallet]);
    assert.equal((await post()).status, 409);
    await pool.query('UPDATE alpha_wallet_bindings SET wallet_address = $2 WHERE account_id = $1',
      [accountId, walletAddress]);
    for (const mutation of [{ finalized: false }, { genesisHash: key() },
      { cluster: cluster === 'devnet' ? 'local-validator' : 'devnet' },
      { mintAddress: key() }, { walletAddress: otherWallet },
      { sourceTokenAddress: null }, { escrowAmount: '1' }, { lifecycle: 'OPENING' },
      { designFrozen: false }, { designCommitment: 'b' }]) {
      snapshotMutation = mutation;
      assert.equal((await post()).status, 409);
      assert.equal((await rows()).length, 0);
    }
    snapshotMutation = {};
    inventoryAssets = [];
    assert.equal((await post()).status, 409);
    inventoryAssets = [{ kind: 'SILVER_BOX', mintAddress, lifecycle: 'SEALED',
      cooldownUntilUnixSeconds: '0' }];
    const [first, parallel] = await Promise.all([post(), post()]);
    assert.equal(first.status, 200);
    assert.equal(parallel.status, 200);
    assert.equal(parallel.body.seedHex, first.body.seedHex);
    assert.equal(first.body.testOnly, true);
    assert.equal(first.body.cluster, cluster);
    assert.equal((await rows())[0].cluster, cluster);
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0].seed_hex, first.body.seedHex);
    assert.equal(await verifySilverOpeningCandidateMessage({ cluster,
      programId, walletAddress, mintAddress, userTokenAddress: sourceTokenAddress,
      escrowAddress, nextOperation: 1, designVersion: 1, oraoTreasury,
      seed: Buffer.from(first.body.seedHex, 'hex'), blockhash,
      lastValidBlockHeight: 1000 }, first.body.messageBase64), true);
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal(retry.body.seedHex, first.body.seedHex);
    assert.equal((await rows()).length, 1);
    snapshotMutation = { designCommitment: 'b'.repeat(64) };
    assert.equal((await post()).status, 409);
    snapshotMutation = {};
    absent = false;
    assert.equal((await post()).status, 409);
    absent = true;
    await assert.rejects(pool.query(`UPDATE alpha_silver_opening_candidate_intents
      SET wallet_address = $1`, [otherWallet]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM alpha_silver_opening_candidate_intents'), /immutable/);
    await close();
    await pool.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await serve(true);
    const restarted = await post();
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.seedHex, first.body.seedHex);
    assert.equal((await rows()).length, 1);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('migration preserves local candidate and separates Devnet uniqueness', async () => {
  const schema = 'alpha_open_migration_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const name of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '008_alpha_silver_opening_candidate_intents.sql']) {
      await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
    }
    const accountId = randomUUID();
    const program = key(), mint = key(), wallet = key();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'migration@example.invalid','synthetic-only',now())`, [accountId]);
    const insert = async (cluster, genesis, seed) => pool.query(`INSERT INTO
      alpha_silver_opening_candidate_intents (cluster, genesis_hash, program_id,
        mint_address, account_id, wallet_address, source_token_address, escrow_address,
        next_operation, design_version, design_commitment, orao_treasury, seed_hex)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,$10,$11)`, [cluster, genesis, program,
      mint, accountId, wallet, key(), key(), 'a'.repeat(64), key(), seed]);
    const localGenesis = key();
    await insert('local-validator', localGenesis, '1'.repeat(64));
    const original = (await pool.query('SELECT * FROM alpha_silver_opening_candidate_intents')).rows[0];
    await pool.query(await readFile(new URL(
      '../schema/010_alpha_silver_opening_devnet_candidates.sql', import.meta.url), 'utf8'));
    const preserved = (await pool.query(`SELECT * FROM alpha_silver_opening_candidate_intents
      WHERE cluster = 'local-validator'`)).rows[0];
    assert.deepEqual(preserved, original);
    const devnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    await insert('devnet', devnetGenesis, '2'.repeat(64));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_opening_candidate_intents'))
      .rows[0].n, 2);
    await assert.rejects(insert('devnet', devnetGenesis, '3'.repeat(64)),
      error => error.code === '23505');
    await assert.rejects(pool.query(`UPDATE alpha_silver_opening_candidate_intents
      SET wallet_address = $1 WHERE cluster = 'local-validator'`, [key()]), /immutable/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
