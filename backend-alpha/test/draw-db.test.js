import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createAlphaDraw } from '../src/draw.js';
import { createDrawBoxIssuer } from '../src/draw-box-issuer.js';
import { createDrawEruIssuer } from '../src/draw-eru-issuer.js';
import { drawBoxIdentity } from '../src/draw-box-identity.js';
import { BOX_HASH, BOX_URI } from '../src/silver-issuer-chain.js';
import { createCooperLevelUp } from '../src/cooper-level-up.js';
import { createCooperPointAllocation } from '../src/cooper-point-allocation.js';
import { createStarterCooper } from '../src/starter-cooper.js';
import { createRingEquipment } from '../src/ring-equipment.js';
import { resolveM2eRingInputsInTransaction } from '../src/m2e-ring-inputs.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const WALLET = 'CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX';

test('Alpha Draw persists one result/debit and exact four-family outcomes with replay', async () => {
  const schema = 'alpha_draw_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '006_alpha_hybrid_ert_foundation.sql', '013_alpha_starter_cooper.sql',
      '015_alpha_ring_equipment.sql', '018_alpha_ert_admin_credits.sql',
      '019_alpha_cooper_current_state.sql', '020_alpha_cooper_point_allocation.sql',
      '021_alpha_cooper_level_up.sql', '022_alpha_cooper_level_eru_preparation.sql',
      '028_alpha_draw.sql', '016_alpha_m2e_daily_accounting.sql',
      '034_alpha_m2e_comfort_epochs.sql', '037_alpha_admin_cooper_grant.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const accountId = randomUUID();
    const starterId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts
      (id,email_normalized,password_hash,verified_at,is_admin)
      VALUES ($1,'draw@example.invalid','synthetic',now(),true)`, [accountId]);
    const token = 'a'.repeat(64);
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
      (account_id,ring_kind,ring_id) VALUES ($1,'COOPER',$2)`, [accountId, starterId]);
    await pool.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)`, [accountId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'test-opening-credit',100)`, [randomUUID(), accountId]);
    const tickets = [0, 97, 90, 96];
    const draw = createAlphaDraw({ pool,
      auth: { async me() { return { status: 200, body: { id: accountId } }; } },
      walletEnvironment: 'alpha-dev',
      sampleCooper: min => min,
      nextInt: max => {
        const ticket = tickets.shift();
        assert(ticket < max);
        return ticket;
      } });
    const configurationVersion = randomUUID();
    const draft = await draw.createDraft('token', {
      configurationVersion, dailyAttemptLimit: 5,
      weights: { ERT: 90, ERU: 6, COPPER_RING: 3, SILVER_BOX: 1 } });
    assert.equal(draft.status, 200);
    assert.equal((await draw.activate('token', { configurationVersion })).status, 200);
    const current = await draw.current('token');
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.draw.rewards.map(r => r.weight), ['90','6','3','1']);
    assert.equal(current.body.draw.cost.amountExact, '5');
    assert.equal(current.body.draw.attempts.limit, 5);
    const expected = ['ERT', 'COPPER_RING', 'ERU', 'SILVER_BOX'];
    const keys = [];
    let boxResultId;
    let eruResultId;
    for (const type of expected) {
      const idempotencyKey = randomUUID();
      keys.push(idempotencyKey);
      const body = { contractVersion: 'raffle-v2', configurationVersion, idempotencyKey };
      const response = await draw.submit('token', body);
      assert.equal(response.status, 200);
      assert.equal(response.body.reward.type, type);
      assert.equal(response.body.operation.replayed, false);
      const replay = await draw.submit('token', body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.operation.replayed, true);
      assert.equal(replay.body.draw.drawResultId, response.body.draw.drawResultId);
      if (type === 'SILVER_BOX') {
        assert.equal(replay.body.fulfillment.state, 'PENDING');
        boxResultId = response.body.draw.drawResultId;
      }
      if (type === 'ERU') eruResultId = response.body.draw.drawResultId;
    }
    assert.equal(tickets.length, 0, 'replay must not select again');
    const ledger = (await pool.query(`SELECT event_key, amount::text AS amount
      FROM alpha_ert_ledger WHERE account_id = $1`, [accountId])).rows;
    assert.equal(ledger.filter(row => row.event_key.startsWith('draw-entry:')).length, 4);
    assert.equal(ledger.filter(row => row.event_key.startsWith('draw-reward:')).length, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_draw_cooper_rings`))
      .rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_draw_cooper_events`))
      .rows[0].n, 1);
    const drawRing = (await pool.query(`SELECT ring_id::text AS id
      FROM alpha_draw_cooper_rings WHERE account_id = $1`, [accountId])).rows[0].id;
    const alphaAuth = { async me() { return { status: 200, body: { id: accountId } }; } };
    const levelUp = createCooperLevelUp({ pool, auth: alphaAuth });
    const levelResult = await levelUp.levelUp('token', drawRing, {
      expectedCurrentLevel: 1, targetLevel: 2, idempotencyKey: randomUUID() });
    assert.equal(levelResult.status, 200);
    assert.equal(levelResult.body.level.current, 2);
    const allocation = createCooperPointAllocation({ pool, auth: alphaAuth });
    const allocated = await allocation.allocate('token', drawRing, {
      expectedUnspentPoints: 4,
      allocation: { comfort: 4, charm: 0, quality: 0, luck: 0 },
      idempotencyKey: randomUUID() });
    assert.equal(allocated.status, 200);
    assert.equal(allocated.body.unspentAttributePoints.current, 0);
    const states = (await pool.query(`SELECT ring_id::text AS id, level, comfort
      FROM alpha_cooper_current_state WHERE account_id = $1`, [accountId])).rows;
    assert.equal(states.length, 2);
    assert.equal(states.find(row => row.id === starterId).level, 1);
    assert.equal(states.find(row => row.id === drawRing).level, 2);
    const starter = createStarterCooper({ pool, walletEnvironment: 'alpha-dev' });
    const owned = await starter.inventory(token);
    assert.equal(owned.status, 200);
    assert.equal(owned.body.rings.length, 2);
    assert.equal(owned.body.rings.find(ring => ring.id === drawRing).level, 2);
    const chainForCooper = { async readEquipmentEligibility() {
      throw new Error('Silver not involved');
    }, async listOwnedRings() { return []; } };
    const equipment = createRingEquipment({ pool, chain: chainForCooper,
      programId: '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX',
      cluster: 'devnet', walletEnvironment: 'alpha-dev' });
    const equipped = await equipment.equip(token, { contractVersion: 'alpha-ring-equipment-v1',
      target: { kind: 'COOPER', id: drawRing },
      expectedCurrent: { kind: 'COOPER', id: starterId }, expectedVersion: '1',
      idempotencyKey: randomUUID() });
    assert.equal(equipped.status, 200);
    assert.equal((await starter.inventory(token)).body.rings
      .find(ring => ring.id === drawRing).equipped, true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await resolveM2eRingInputsInTransaction({ client, accountId,
        chain: chainForCooper, programId: '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX',
        cluster: 'devnet', walletAddress: WALLET });
      assert.equal(snapshot.ringCount, 2);
      assert.equal(snapshot.selectedRing.id, drawRing);
      assert.equal(snapshot.selectedRingComfort, states.find(row => row.id === drawRing).comfort);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_draw_results`))
      .rows[0].n, 4);
    assert.equal((await draw.current('token')).body.draw.attempts.remaining, 1);
    assert.equal((await draw.history('token')).body.items.length, 4);
    await assert.rejects(() => pool.query(`UPDATE alpha_draw_results
      SET selected_reward_type = 'ERT'`), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE alpha_draw_configurations
      SET cost_ert = 6 WHERE id = $1`, [configurationVersion]), /immutable|check constraint/);
    assert.equal((await pool.query(`SELECT ring_id::text AS ring_id FROM alpha_draw_cooper_rings`))
      .rows.length, 1);
    const boxIdentity = drawBoxIdentity(accountId, WALLET, boxResultId);
    let sends = 0;
    const chain = {
      issuerAddress: 'issuer',
      async build(row) {
        assert.equal(row.issuance_id, boxIdentity.issuanceId);
        assert.equal(row.entitlement_digest, boxIdentity.entitlementDigest);
        return { issuerAddress: 'issuer', signature: 'box-signature',
          rawTransactionBase64: 'signed-box', blockhash: 'blockhash',
          lastValidBlockHeight: 1000, mintAddress: 'box-mint' };
      },
      async send(attempt) { assert.equal(attempt.raw_transaction_base64, 'signed-box'); sends++; },
      async status() { return { confirmationStatus: 'finalized', err: null }; },
      async blockHeight() { return 900; },
    };
    const reader = { async readFinalized(input) {
      assert.equal(input.expectedIssuanceSource, 'draw');
      assert.equal(input.expectedDrawResultId, boxResultId);
      if (!input.expectedFinalizedSignature) return null;
      return { finalized: true, programId: 'program', cluster: 'devnet',
        kind: 'SILVER_BOX', issuanceSource: 'draw', drawResultId: boxResultId,
        accountId, entitlementDigest: boxIdentity.entitlementDigest,
        issuanceId: boxIdentity.issuanceId, originalRecipient: WALLET,
        tokenOwner: WALLET, lifecycle: 'SEALED', mintAddress: 'box-mint',
        uri: BOX_URI, contentHash: BOX_HASH, supply: '1', tokenAmount: '1',
        mintAuthority: null, freezeAuthority: null };
    } };
    const issuer = createDrawBoxIssuer({ pool, chain, reader, programId: 'program' });
    assert.equal((await issuer.tick()).unknown, 1);
    assert.equal(sends, 1);
    const durable = (await pool.query(`SELECT state, raw_transaction_base64
      FROM alpha_draw_chain_attempts WHERE result_id = $1`, [boxResultId])).rows[0];
    assert.deepEqual(durable, { state: 'UNKNOWN', raw_transaction_base64: 'signed-box' });
    assert.equal((await issuer.tick()).confirmed, 1);
    assert.equal((await issuer.tick()).confirmed, 0);
    assert.equal(sends, 1, 'one durable Box issuance, no replay');
    assert.equal((await pool.query(`SELECT state, chain_asset_address FROM alpha_draw_fulfillments
      WHERE result_id = $1`, [boxResultId])).rows[0].state, 'CONFIRMED');
    let eruSends = 0;
    const eruIssuer = createDrawEruIssuer({ pool, chain: {
      async build(row) {
        assert.deepEqual(row, { accountId, resultId: eruResultId, wallet: WALLET });
        return { signature: 'eru-signature', rawTransactionBase64: 'signed-eru',
          blockhash: 'blockhash', lastValidBlockHeight: 1000 };
      },
      async send(attempt) { assert.equal(attempt.raw_transaction_base64, 'signed-eru'); eruSends++; },
      async status() { return { confirmationStatus: 'finalized', err: null }; },
      async blockHeight() { return 900; },
      async readFinalized(owner, id, wallet, signature) {
        assert.equal(owner, accountId);
        assert.equal(id, eruResultId); assert.equal(wallet, WALLET);
        return { signature, destination: 'wallet-eru-ata', amountBaseUnits: '5000000000' };
      },
    } });
    assert.equal((await eruIssuer.tick()).unknown, 1);
    assert.equal((await pool.query(`SELECT raw_transaction_base64, state
      FROM alpha_draw_chain_attempts WHERE result_id = $1`, [eruResultId]))
      .rows[0].raw_transaction_base64, 'signed-eru');
    assert.equal((await eruIssuer.tick()).confirmed, 1);
    assert.equal((await eruIssuer.tick()).confirmed, 0);
    assert.equal(eruSends, 1);
    assert.equal((await pool.query(`SELECT state FROM alpha_draw_fulfillments
      WHERE result_id = $1`, [eruResultId])).rows[0].state, 'CONFIRMED');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
