import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { createAlphaDraw } from '../src/draw.js';
import { createCooperBreeding } from '../src/cooper-breeding.js';
import { createCooperBreedingReconciliation } from '../src/cooper-breeding-reconciliation.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must be disposable PostgreSQL');
const WALLET = 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX';
const SCHEMAS = ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
  '006_alpha_hybrid_ert_foundation.sql', '013_alpha_starter_cooper.sql',
  '015_alpha_ring_equipment.sql', '018_alpha_ert_admin_credits.sql',
  '019_alpha_cooper_current_state.sql', '020_alpha_cooper_point_allocation.sql',
  '021_alpha_cooper_level_up.sql', '022_alpha_cooper_level_eru_preparation.sql',
  '023_alpha_cooper_level_eru_issuance.sql',
  '024_alpha_cooper_level_eru_settlement.sql', '028_alpha_draw.sql',
  '029_alpha_cooper_breeding.sql'];

test('breeding preparation holds exactly two owned Level-20 parents and one ERT reserve',
  async () => {
    const schema = 'alpha_breeding_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
        options: `-c search_path=${schema}` });
      for (const file of SCHEMAS)
        await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
      const accountId = randomUUID();
      const foreignId = randomUUID();
      const starterId = randomUUID();
      const token = 'a'.repeat(64);
      await pool.query(`INSERT INTO alpha_accounts
        (id,email_normalized,password_hash,verified_at,is_admin)
        VALUES ($1,'breeding@example.invalid','synthetic',now(),true),
               ($2,'foreign-breeding@example.invalid','synthetic',now(),false)`,
      [accountId, foreignId]);
      await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
        VALUES ($1,$2,now() + interval '1 day')`,
      [createHash('sha256').update(token).digest('hex'), accountId]);
      await pool.query(`INSERT INTO alpha_wallet_bindings
        (account_id,wallet_address,environment) VALUES ($1,$2,'alpha-dev')`,
      [accountId, WALLET]);
      await pool.query(`INSERT INTO alpha_starter_cooper
        (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
        VALUES ($1,$2,$3,'copper_plain_polished',2,3,4,5)`,
      [accountId, starterId, randomUUID()]);
      await pool.query(`INSERT INTO alpha_ring_selection
        (account_id,ring_kind,ring_id) VALUES ($1,'COOPER',$2)`,
      [accountId, starterId]);
      await pool.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)`, [accountId]);
      await pool.query(`INSERT INTO alpha_ert_ledger
        (id,account_id,event_key,amount) VALUES ($1,$2,'test-credit',1000)`,
      [randomUUID(), accountId]);
      const auth = { async me(value) {
        if (value === 'owner') return { status: 200, body: { id: accountId } };
        if (value === 'foreign') return { status: 200, body: { id: foreignId } };
        return { status: 401, body: { code: 'AUTH_REQUIRED' } };
      } };
      const draw = createAlphaDraw({ pool, auth, walletEnvironment: 'alpha-dev',
        sampleCooper: min => min, nextInt: () => 97 });
      const configurationVersion = randomUUID();
      assert.equal((await draw.createDraft('owner', { configurationVersion,
        dailyAttemptLimit: 5,
        weights: { ERT: 90, ERU: 6, COPPER_RING: 3, SILVER_BOX: 1 } })).status, 200);
      assert.equal((await draw.activate('owner', { configurationVersion })).status, 200);
      const awarded = await draw.submit('owner', { contractVersion: 'raffle-v2',
        configurationVersion, idempotencyKey: randomUUID() });
      assert.equal(awarded.status, 200);
      assert.equal(awarded.body.reward.type, 'COPPER_RING');
      const secondId = (await pool.query(`SELECT ring_id::text AS id FROM
        alpha_draw_cooper_rings WHERE account_id = $1`, [accountId])).rows[0].id;
      const breeding = createCooperBreeding({ pool, auth });
      assert.equal((await breeding.preview('owner', starterId,
        { secondRingId: secondId })).body.code, 'COOPER_PARENT_LEVEL_REQUIRED');
      // The disposable fixture starts at Level 20; production reaches it only
      // through the already accepted Cooper progression path.
      await pool.query(`UPDATE alpha_cooper_current_state SET level = 20
        WHERE account_id = $1`, [accountId]);
      assert.equal((await breeding.preview('foreign', starterId,
        { secondRingId: secondId })).status, 404);
      assert.equal((await breeding.preview('owner', starterId,
        { secondRingId: starterId })).body.code, 'COOPER_BREEDING_SAME_PARENT');
      const preview = await breeding.preview('owner', starterId,
        { secondRingId: secondId });
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.body.cost, { ertExact: '150',
        eruPrincipalExact: '30', eruFeeExact: '0.6', eruTotalExact: '30.6' });
      const key = randomUUID();
      const competingKey = randomUUID();
      const [first, competing] = await Promise.all([
        breeding.prepare('owner', starterId, { secondRingId: secondId,
          idempotencyKey: key }),
        breeding.prepare('owner', secondId, { secondRingId: starterId,
          idempotencyKey: competingKey }),
      ]);
      assert.equal([first, competing].filter(result => result.status === 200).length, 1);
      assert.equal([first, competing].filter(result => result.status === 409).length, 1);
      const winning = first.status === 200 ? first : competing;
      const replay = await breeding.prepare('owner', winning.body.firstRingId,
        { secondRingId: winning.body.secondRingId,
          idempotencyKey: first.status === 200 ? key : competingKey });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.operationId, winning.body.operationId);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
        alpha_cooper_breeding_operations`)).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
        alpha_cooper_breeding_parent_holds WHERE released_at IS NULL`)).rows[0].n, 2);
      assert.equal((await pool.query(`SELECT amount::text FROM alpha_ert_reservations
        WHERE operation_id = (SELECT hybrid_operation_id FROM
          alpha_cooper_breeding_operations LIMIT 1)`)).rows[0].amount, '150.000000000000000000');
      assert.deepEqual((await pool.query(`SELECT DISTINCT breeding_uses FROM
        alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows,
      [{ breeding_uses: 0 }]);
      await assert.rejects(() => pool.query(`UPDATE alpha_cooper_current_state
        SET breeding_uses = 1 WHERE account_id = $1 AND ring_id = $2`,
      [accountId, starterId]), /finalized settlement/);
      const op = (await pool.query(`SELECT * FROM alpha_cooper_breeding_operations
        WHERE id = $1`, [winning.body.operationId])).rows[0];
      const signature = bs58.encode(Buffer.alloc(64, 1));
      const boxMint = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
      await pool.query(`INSERT INTO alpha_cooper_breeding_issuances
        (operation_id,account_id,reservation_id,wallet_address,cluster,genesis_hash,
         gateway_program_id,attestor_address,intent_digest,nonce,config_epoch,expiry_slot)
        VALUES ($1,$2,$3,$4,'devnet',$5,$6,$7,$8,1,1,9999)`,
      [op.id, accountId, op.reservation_id, WALLET,
        'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF',
        '65g5pwTFDqXKKHaTfFQ2etKX8iPSTVFbUkZRoPJfXQfy', 'a'.repeat(64)]);
      let finalized = false;
      const finalityReader = { async verify(_accountId, operationId, submittedSignature) {
        return finalized ? { status: 'verified',
          operationId, accountId, signature: submittedSignature, slot: 42,
          intentDigest: 'a'.repeat(64), transactionDigest: 'b'.repeat(64),
          operationReplayDigest: 'c'.repeat(64),
          boxMint: operationId === op.id ? boxMint : WALLET } : { status: 'unknown' }; } };
      const reconciliation = createCooperBreedingReconciliation({ pool, finalityReader });
      assert.equal((await reconciliation.recordSubmission(accountId, op.id, signature))
        .status, 'unknown');
      assert.equal((await reconciliation.reconcile(accountId, op.id)).status, 'unknown');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
        alpha_cooper_breeding_settlements`)).rows[0].n, 0);
      finalized = true;
      const restarted = createCooperBreedingReconciliation({ pool, finalityReader });
      assert.equal((await restarted.reconcile(accountId, op.id)).status, 'confirmed');
      assert.equal((await reconciliation.reconcile(accountId, op.id)).status, 'confirmed');
      assert.equal((await reconciliation.reconcile(accountId, op.id)).status, 'confirmed');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
        WHERE event_key = $1`, [`cooper-breeding:${op.id}`])).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
        alpha_cooper_breeding_parent_holds WHERE released_at IS NULL`)).rows[0].n, 0);
      assert.deepEqual((await pool.query(`SELECT DISTINCT breeding_uses FROM
        alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows,
      [{ breeding_uses: 1 }]);
      const secondBreeding = await breeding.prepare('owner', starterId,
        { secondRingId: secondId, idempotencyKey: randomUUID() });
      assert.equal(secondBreeding.status, 200);
      assert.deepEqual(secondBreeding.body.cost, { ertExact: '250',
        eruPrincipalExact: '50', eruFeeExact: '1' });
      const secondOp = (await pool.query(`SELECT * FROM alpha_cooper_breeding_operations
        WHERE id = $1`, [secondBreeding.body.operationId])).rows[0];
      const secondSignature = bs58.encode(Buffer.alloc(64, 2));
      await pool.query(`INSERT INTO alpha_cooper_breeding_issuances
        (operation_id,account_id,reservation_id,wallet_address,cluster,genesis_hash,
         gateway_program_id,attestor_address,intent_digest,nonce,config_epoch,expiry_slot)
        VALUES ($1,$2,$3,$4,'devnet',$5,$6,$7,$8,2,1,9999)`,
      [secondOp.id, accountId, secondOp.reservation_id, WALLET,
        'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF',
        '65g5pwTFDqXKKHaTfFQ2etKX8iPSTVFbUkZRoPJfXQfy', 'a'.repeat(64)]);
      await restarted.recordSubmission(accountId, secondOp.id, secondSignature);
      assert.equal((await restarted.reconcile(accountId, secondOp.id)).status, 'confirmed');
      assert.deepEqual((await pool.query(`SELECT DISTINCT breeding_uses FROM
        alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows,
      [{ breeding_uses: 2 }]);
      assert.equal((await breeding.preview('owner', starterId,
        { secondRingId: secondId })).body.code, 'COOPER_PARENT_EXHAUSTED');
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

test('unused breeding migration rolls back without touching preceding Cooper authority',
  async () => {
    const schema = 'alpha_breeding_rollback_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: databaseUrl,
        options: `-c search_path=${schema}` });
      for (const file of SCHEMAS)
        await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
      await pool.query(await readFile(new URL(
        '../schema/rollback/029_alpha_cooper_breeding.sql', import.meta.url), 'utf8'));
      const tables = (await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'alpha_cooper_breeding_operations'`,
      [schema])).rows[0];
      assert.equal(tables.n, 0);
      const prior = (await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'alpha_cooper_level_eru_settlements'`,
      [schema])).rows[0];
      assert.equal(prior.n, 1);
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
