import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import { createSilverProgression } from '../src/silver-progression.js';
import { createSilverProgressionFlow } from '../src/silver-progression-flow.js';
import { readPreparedSilver } from '../src/silver-progression-read.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must be disposable PostgreSQL');
const key = byte => bs58.encode(Buffer.alloc(32, byte));
const sig = byte => bs58.encode(Buffer.alloc(64, byte));
const programId = key(6), wallet = key(7), box = key(8), ringMint = key(9);
const cluster = 'devnet';
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

test('Silver 1→2 holds 15 ERT, settles once only after verified chain receipt', async () => {
  const schema = 'alpha_silver_progression_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6,
      options: `-c search_path=${schema}` });
    const files = await readdir(new URL('../schema/', import.meta.url));
    for (let n = 1; n <= 29; n++) {
      const file = files.find(value => value.startsWith(String(n).padStart(3, '0') + '_'));
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    }
    await pool.query(await readFile(new URL('../schema/032_alpha_silver_current_owner_progression.sql',
      import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../schema/033_alpha_silver_breeding_reservation_guard.sql',
      import.meta.url), 'utf8'));
    const guard = (await pool.query(`SELECT pg_get_functiondef(
      'alpha_ert_reservation_hold_immutable()'::regprocedure) AS definition`)).rows[0].definition;
    for (const settlement of ['alpha_cooper_level_eru_settlements',
      'alpha_silver_progression_settlements', 'alpha_cooper_breeding_settlements'])
      assert.ok(guard.includes(settlement));
    const accountId = randomUUID(), issuanceId = 'a'.repeat(64);
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'silver-progress@example.invalid','synthetic',now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-dev')`, [accountId, wallet]);
    await pool.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)`, [accountId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'initial',100)`, [randomUUID(), accountId]);
    await pool.query(`INSERT INTO alpha_silver_first_entry
      (account_id,wallet_address,cluster,issuance_id,entitlement_digest,status,
       mint_address,finalized_signature,confirmed_at)
      VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,now())`,
    [accountId, wallet, cluster, issuanceId, 'b'.repeat(64), box, sig(10)]);
    await pool.query(`INSERT INTO alpha_silver_opening_candidate_intents
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       source_token_address,escrow_address,next_operation,design_version,
       design_commitment,orao_treasury,seed_hex)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,$10,$11)`,
    [cluster, genesis, programId, box, accountId, wallet, key(11), key(12),
      'c'.repeat(64), key(13), 'd'.repeat(64)]);
    await pool.query(`INSERT INTO alpha_silver_opening_submissions
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       message_base64,blockhash,last_valid_block_height,signature,status,settled_at)
      VALUES ($1,$2,$3,$4,$5,$6,'AA==',$7,1,$8,'confirmed',now())`,
    [cluster, genesis, programId, box, accountId, wallet, key(14), sig(15)]);
    await pool.query(`INSERT INTO alpha_silver_opening_finalizations
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       operation_address,request_address,ring_mint_address,payer_address,
       message_base64,blockhash,last_valid_block_height,signature,status,settled_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AA==',$11,1,$12,'confirmed',now())`,
    [cluster, genesis, programId, box, accountId, wallet, key(16), key(17),
      ringMint, key(18), key(19), sig(20)]);
    let ringLevel = 1;
    const chain = { listOwnedRings: async ({ walletAddress }) => walletAddress === wallet ?
      [{ kind: 'SILVER_RING', mintAddress: ringMint, boxMint: box,
        tokenOwner: wallet, cluster, programId, issuanceId,
        level: ringLevel, cooldownUntilUnixSeconds: '0' }] : [] };
    const auth = { me: async () => ({ status: 200, body: { id: accountId } }) };
    const progression = createSilverProgression({ pool, auth, chain, programId });
    const request = { expectedCurrentLevel: 1, targetLevel: 2,
      idempotencyKey: randomUUID() };
    const prepared = await progression.prepare('session', ringMint, request);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.cost.ertExact, '15');
    assert.equal((await readPreparedSilver(pool, accountId,
      prepared.body.operationId)).operation_id, prepared.body.operationId);
    assert.equal((await progression.prepare('session', ringMint, request)).body.operationId,
      prepared.body.operationId);
    assert.equal((await progression.prepare('session', ringMint, {
      ...request, idempotencyKey: randomUUID(),
    })).body.operationId, prepared.body.operationId);
    const held = (await pool.query(`SELECT balance::text, reserved::text, available::text
      FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
    assert.deepEqual(Object.values(held).map(Number), [100, 15, 85]);
    const submitted = sig(21), digest = createHash('sha256').update('verified').digest('hex');
    await pool.query(`INSERT INTO alpha_silver_progression_submissions
      (signature,operation_id,account_id,message_base64,issuer_signature_base64,intent_digest)
      VALUES ($1,$2,$3,'AA==','AA==',$4)`,
    [submitted, prepared.body.operationId, accountId, digest]);
    const flow = createSilverProgressionFlow({ pool, programId,
      signer: { signGuardedProgression() {}, isBlockhashValid() {}, send() {} },
      finality: { verify: async () => ({ status: 'verified', accountId,
        operationId: prepared.body.operationId, signature: submitted, slot: 123,
        intentDigest: digest, transactionDigest: digest, replayDigest: digest }) } });
    const confirmed = await flow.status(accountId, prepared.body.operationId);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.snapshot.level.current, 2);
    assert.equal((await flow.status(accountId, prepared.body.operationId)).snapshot
      .ledgerTransactionId, confirmed.snapshot.ledgerTransactionId);
    const after = (await pool.query(`SELECT balance::text, reserved::text, available::text
      FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
    assert.deepEqual(Object.values(after).map(Number), [85, 0, 85]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_silver_progression_settlements`))
      .rows[0].n, 1);
    ringLevel = 4;
    const paid = await progression.prepare('session', ringMint, {
      expectedCurrentLevel: 4, targetLevel: 5, idempotencyKey: randomUUID(),
    });
    assert.equal(paid.status, 200);
    assert.deepEqual(paid.body.cost, { ertExact: '30', eruExact: '38.76' });
    const paidRow = await readPreparedSilver(pool, accountId, paid.body.operationId);
    assert.equal(paidRow.eru_principal, '38.000000000');
    assert.equal(paidRow.eru_fee, '0.760000000');

    // A finalized non-first-entry Box may have been transferred after opening.
    // Its current bound owner, not the origin account, pays for progression.
    const origin = randomUUID(), current = randomUUID();
    const originWallet = key(30), currentWallet = key(31);
    const otherBox = key(32), otherRing = key(33), otherIssuance = 'e'.repeat(64);
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'silver-origin@example.invalid','synthetic',now()),
        ($2,'silver-current@example.invalid','synthetic',now())`, [origin, current]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-dev'),($3,$4,'alpha-dev')`,
    [origin, originWallet, current, currentWallet]);
    await pool.query('INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)', [current]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'transferred-ring-initial',100)`, [randomUUID(), current]);
    await pool.query(`INSERT INTO alpha_silver_opening_candidate_intents
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       source_token_address,escrow_address,next_operation,design_version,
       design_commitment,orao_treasury,seed_hex)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,$10,$11)`,
    [cluster, genesis, programId, otherBox, origin, originWallet, key(34), key(35),
      'f'.repeat(64), key(36), '1'.repeat(64)]);
    await pool.query(`INSERT INTO alpha_silver_opening_submissions
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       message_base64,blockhash,last_valid_block_height,signature,status,settled_at)
      VALUES ($1,$2,$3,$4,$5,$6,'AA==',$7,1,$8,'confirmed',now())`,
    [cluster, genesis, programId, otherBox, origin, originWallet, key(37), sig(38)]);
    await pool.query(`INSERT INTO alpha_silver_opening_finalizations
      (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
       operation_address,request_address,ring_mint_address,payer_address,
       message_base64,blockhash,last_valid_block_height,signature,status,settled_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AA==',$11,1,$12,'confirmed',now())`,
    [cluster, genesis, programId, otherBox, origin, originWallet, key(39), key(40),
      otherRing, key(41), key(42), sig(43)]);
    chain.listOwnedRings = async ({ walletAddress }) => walletAddress === currentWallet ?
      [{ kind: 'SILVER_RING', mintAddress: otherRing, boxMint: otherBox,
        tokenOwner: currentWallet, cluster, programId, issuanceId: otherIssuance,
        level: 1, cooldownUntilUnixSeconds: '0' }] : [];
    let listed = false;
    const currentProgression = createSilverProgression({ pool,
      auth: { me: async () => ({ status: 200, body: { id: current } }) },
      chain, programId, marketReader: { readListing: async mintAddress => listed ?
        { mintAddress, kind: 'SILVER_RING', state: 'ACTIVE' } : null } });
    const ownedRing = (await chain.listOwnedRings({ walletAddress: currentWallet }))[0];
    const requestForCurrent = () => ({ expectedCurrentLevel: 1, targetLevel: 2,
      idempotencyKey: randomUUID() });
    chain.listOwnedRings = async () => [{ ...ownedRing, tokenOwner: originWallet }];
    assert.equal((await currentProgression.prepare('session', otherRing,
      requestForCurrent())).body.code, 'SILVER_RING_NOT_OWNED');
    chain.listOwnedRings = async () => [{ ...ownedRing, boxMint: key(44) }];
    assert.equal((await currentProgression.prepare('session', otherRing,
      requestForCurrent())).body.code, 'SILVER_RING_NOT_OWNED');
    chain.listOwnedRings = async () => [{ ...ownedRing,
      cooldownUntilUnixSeconds: String(Math.floor(Date.now() / 1000) + 86400) }];
    assert.equal((await currentProgression.prepare('session', otherRing,
      requestForCurrent())).body.code, 'SILVER_RING_COOLDOWN');
    chain.listOwnedRings = async () => [ownedRing];
    listed = true;
    assert.equal((await currentProgression.prepare('session', otherRing,
      requestForCurrent())).body.code, 'SILVER_RING_LISTED');
    listed = false;
    const transferred = await currentProgression.prepare('session', otherRing, {
      expectedCurrentLevel: 1, targetLevel: 2, idempotencyKey: randomUUID(),
    });
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body.cost.ertExact, '15');
    assert.equal((await pool.query(`SELECT account_id, issuance_id FROM
      alpha_silver_progression_operations WHERE id = $1`,
    [transferred.body.operationId])).rows[0].account_id, current);
    await pool.query(await readFile(new URL(
      '../schema/rollback/033_alpha_silver_breeding_reservation_guard.sql', import.meta.url),
    'utf8'));
    assert.equal((await pool.query(`SELECT position('alpha_silver_progression_settlements' in
      pg_get_functiondef('alpha_ert_reservation_hold_immutable()'::regprocedure)) AS present`))
      .rows[0].present, 0);
    await pool.query(await readFile(new URL(
      '../schema/rollback/032_alpha_silver_current_owner_progression.sql', import.meta.url),
    'utf8'));
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
