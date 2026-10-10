import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { createSilverKeeper } from '../src/silver-keeper.js';
import { createSilverKeeperChain } from '../src/silver-keeper-chain.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable PostgreSQL');
const key = () => bs58.encode(randomBytes(32));
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

test('Silver keeper persists one signature before send and reconciles after restart', async () => {
  const schema = 'alpha_silver_keeper_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    const preloaded = process.env.ALPHA_TEST_SCHEMA_PRELOADED === 'true';
    if (!preloaded) await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl,
      ...(preloaded ? {} : { options: `-c search_path=${schema}` }) });
    const finalizationTable = preloaded && (await pool.query(
      "SELECT to_regclass('alpha_silver_opening_finalizations') AS name")).rows[0].name;
    for (const name of preloaded ? (finalizationTable ? [] :
      ['012_alpha_silver_opening_finalizations.sql']) :
      ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '007_alpha_silver_first_entry.sql', '008_alpha_silver_opening_candidate_intents.sql',
      '010_alpha_silver_opening_devnet_candidates.sql',
      '011_alpha_silver_opening_submissions.sql',
      '012_alpha_silver_opening_finalizations.sql'])
      await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
    const account = randomUUID(), wallet = key(), mint = key(), program = key();
    const operation = key(), request = key(), ringMint = key(), payer = key();
    const signature = key(), blockhash = key(), messageBase64 = randomBytes(64).toString('base64');
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'keeper@example.invalid','synthetic-only',now())`, [account]);
    await pool.query(`INSERT INTO alpha_silver_first_entry
      (account_id,wallet_address,cluster,issuance_id,entitlement_digest,status,
       mint_address,finalized_signature,confirmed_at)
      VALUES ($1,$2,'devnet',$3,$4,'confirmed',$5,$6,now())`,
    [account, wallet, 'a'.repeat(64), 'b'.repeat(64), mint, key()]);
    await pool.query(`INSERT INTO alpha_silver_opening_candidate_intents
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       source_token_address,escrow_address,next_operation,design_version,
       design_commitment,orao_treasury,seed_hex)
      VALUES ('devnet',$1,$2,$3,$4,$5,$6,$7,1,1,$8,$9,$10)`,
    [genesis, program, mint, account, wallet, key(), key(), 'c'.repeat(64), key(),
      'd'.repeat(64)]);
    await pool.query(`INSERT INTO alpha_silver_opening_submissions
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       message_base64,blockhash,last_valid_block_height,signature,status,settled_at)
      VALUES ('devnet',$1,$2,$3,$4,$5,$6,$7,100,$8,'confirmed',now())`,
    [genesis, program, mint, account, wallet, messageBase64, blockhash, key()]);
    let phase = 'opening', fulfilled = false, status = null, transactionMatches = true;
    let builds = 0, sends = 0, ringVerified = true, height = 10;
    let inspectCalls = 0;
    const chain = {
      payerAddress: payer,
      inspect: async () => { inspectCalls++; return { phase, fulfilled, operation,
        request, ringMint }; },
      build: async () => { builds++; return { operation, request, ringMint,
        payer, messageBase64, blockhash, lastValidBlockHeight: 100,
        signature, simulationPassed: true }; },
      signatureStatus: async () => status,
      transaction: async () => ({ meta: { err: status?.err ?? null } }),
      matchesTransaction: () => transactionMatches,
      verifyRing: async () => ringVerified,
      blockHeight: async () => height,
      blockhashValid: async () => true,
      send: async finalization => { sends++; assert.equal(finalization.signature, signature); },
    };
    const keeper = () => createSilverKeeper({ pool, chain, programId: program });
    assert.equal((await keeper().tick()).pending, 1);
    assert.equal(builds, 0);
    fulfilled = true;
    assert.equal((await keeper().tick()).unknown, 1);
    assert.equal(builds, 1);
    assert.equal(sends, 1);
    const durable = (await pool.query('SELECT * FROM alpha_silver_opening_finalizations')).rows;
    assert.equal(durable.length, 1);
    assert.equal(durable[0].signature, signature);
    assert.equal(durable[0].status, 'unknown');
    assert.equal((await keeper().tick()).unknown, 1);
    assert.equal(builds, 1);
    assert.equal(sends, 2);
    height = 101;
    assert.equal((await keeper().tick()).unknown, 1);
    assert.equal(sends, 2);
    status = { confirmationStatus: 'finalized', err: null };
    transactionMatches = false;
    phase = 'consumed';
    assert.equal((await keeper().tick()).unknown, 1);
    transactionMatches = true;
    ringVerified = false;
    assert.equal((await keeper().tick()).unknown, 1);
    ringVerified = true;
    assert.equal((await keeper().tick()).confirmed, 1);
    const settledInspectCalls = inspectCalls;
    phase = 'transferred';
    assert.equal((await keeper().tick()).confirmed, 1);
    assert.equal(inspectCalls, settledInspectCalls);
    assert.equal(builds, 1);
    assert.equal(sends, 2);
    assert.equal((await pool.query('SELECT status FROM alpha_silver_opening_finalizations')).rows[0].status,
      'confirmed');
    await assert.rejects(pool.query(`UPDATE alpha_silver_opening_finalizations
      SET signature = $1 WHERE mint_address = $2`, [key(), mint]), { code: '23514' });
  } finally {
    if (pool) await pool.end();
    if (!process.env.ALPHA_TEST_SCHEMA_PRELOADED) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await admin.end();
  }
});

test('Silver keeper adapter reads the existing finalized Box to Ring proof', {
  skip: process.env.ALPHA_KEEPER_READONLY_CHAIN_TEST !== 'true',
}, async () => {
  const live = new pg.Pool({ connectionString: process.env.ALPHA_DATABASE_URL });
  try {
    const mint = '2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq';
    const signature = '4Bu4BoFMcT7sQn7oiHGF5VQF2zqWwkuFy1qYuUogNKRech21d9P6gULgdYcuQhG2kYKHfeNwaL3Mmocw5KLXsujd';
    const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
    const { rows } = await live.query(`SELECT c.*, e.issuance_id
      FROM alpha_silver_opening_candidate_intents c
      JOIN alpha_silver_first_entry e ON e.account_id = c.account_id
        AND e.cluster = c.cluster AND e.wallet_address = c.wallet_address
        AND e.mint_address = c.mint_address
      WHERE c.mint_address = $1 AND c.program_id = $2`, [mint, programId]);
    assert.equal(rows.length, 1);
    const chain = createSilverKeeperChain({ rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
      programId, payerKeyPath: process.env.ALPHA_SILVER_KEEPER_PAYER_FILE,
      expectedProgramSha256: process.env.ALPHA_SILVER_PROGRAM_SHA256,
      expectedProgramSize: Number(process.env.ALPHA_SILVER_PROGRAM_SIZE) });
    const state = await chain.inspect(rows[0]);
    assert.equal(state.phase, 'consumed');
    const tx = await chain.transaction(signature);
    assert.equal(tx?.meta?.err, null);
    const raw = Buffer.from(tx.transaction[0], 'base64');
    assert.equal(raw[0], 1);
    const finalization = { signature, ring_mint_address: state.ringMint,
      message_base64: raw.subarray(65).toString('base64') };
    assert.equal(chain.matchesTransaction(finalization, tx), true);
    assert.equal(await chain.verifyRing(rows[0], finalization, tx), true);
  } finally {
    await live.end();
  }
});
