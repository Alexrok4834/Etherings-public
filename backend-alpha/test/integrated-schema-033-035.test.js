import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import Decimal from 'decimal.js';
import { createHybridErtFoundation } from '../src/hybrid-ert.js';
import { createAlphaDraw } from '../src/draw.js';
import { receiveM2eStepBatch } from '../src/m2e-step-sync.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/alpha_42_disposable') {
  throw new Error('ALPHA_TEST_DATABASE_URL must target alpha_42_disposable');
}

test('current 001–037 ERT holds, M2E and Draw handlers compose with recovery', async () => {
  const schema = `alpha_42_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const files = (await readdir(new URL('../schema/', import.meta.url)))
      .filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
    assert.equal(files.length, 37);
    for (const [index, file] of files.entries()) {
      assert.equal(Number(file.slice(0, 3)), index + 1);
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    }

    const guard = (await pool.query(`SELECT pg_get_functiondef(
      'alpha_ert_reservation_hold_immutable()'::regprocedure) AS definition`)).rows[0].definition;
    for (const settlement of ['alpha_cooper_level_eru_settlements',
      'alpha_silver_progression_settlements', 'alpha_cooper_breeding_settlements']) {
      assert.ok(guard.includes(settlement), `missing ${settlement} from shared hold guard`);
    }
    const tables = (await pool.query(`SELECT to_regclass('alpha_m2e_comfort_changes') AS changes,
      to_regclass('alpha_m2e_comfort_segments') AS segments,
      to_regclass('alpha_eru_intents') AS intents`)).rows[0];
    assert.deepEqual(tables, { changes: 'alpha_m2e_comfort_changes',
      segments: 'alpha_m2e_comfort_segments', intents: 'alpha_eru_intents' });
    const namespace = (await pool.query(`SELECT column_default, is_nullable FROM
      information_schema.columns WHERE table_schema = $1 AND table_name = 'alpha_eru_intents'
      AND column_name = 'intent_namespace'`, [schema])).rows[0];
    assert.deepEqual(namespace, { column_default: "'legacy'::text", is_nullable: 'NO' });
    const triggers = (await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid =
      'alpha_eru_intents'::regclass AND NOT tgisinternal`)).rows.map(row => row.tgname);
    assert.ok(triggers.includes('alpha_eru_intent_namespace_immutable'));

    const accountId = randomUUID();
    const walletAddress = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
    await pool.query(`INSERT INTO alpha_accounts
      (id,email_normalized,password_hash,verified_at,is_admin)
      VALUES ($1,'composition@example.invalid','synthetic',now(),true)`, [accountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [accountId, walletAddress]);
    const starterId = randomUUID();
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_plain_polished',2,3,4,5)`,
    [accountId, starterId, randomUUID()]);
    await pool.query(`INSERT INTO alpha_ring_selection(account_id,ring_kind,ring_id)
      VALUES ($1,'COOPER',$2)`, [accountId, starterId]);
    await pool.query('INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)', [accountId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'synthetic:initial',100)`, [randomUUID(), accountId]);
    const hybrid = createHybridErtFoundation({ pool });
    const request = (operationType, ertAmount, marker) => ({
      operationId: randomUUID(), accountId, walletAddress, cluster: 'devnet',
      operationType, requestDigest: marker.repeat(64), ertAmount,
    });
    const cooper = request('cooper_level_up', '60', 'a');
    const silver = request('silver_progression', '30', 'b');
    const cooperHold = await hybrid.reserve(cooper);
    const silverHold = await hybrid.reserve(silver);
    assert.equal(cooperHold.availableAfter, '40');
    assert.equal(silverHold.availableAfter, '10');
    assert.equal((await hybrid.reserve(cooper)).reservationId, cooperHold.reservationId);
    await assert.rejects(hybrid.reserve(request('cooper_breeding', '11', 'c')),
      { code: 'INSUFFICIENT_ERT' });

    const breeding = request('cooper_breeding', '7', 'e');
    await hybrid.reserve(breeding);
    const draw = createAlphaDraw({ pool,
      auth: { async me() { return { status: 200, body: { id: accountId } }; } },
      walletEnvironment: 'alpha-local', sampleCooper: min => min,
      nextInt: max => { assert.equal(max, 100); return 90; } });
    const configurationVersion = randomUUID();
    assert.equal((await draw.createDraft('token', { configurationVersion,
      dailyAttemptLimit: 5, weights: { ERT: 90, ERU: 6, COPPER_RING: 3,
        SILVER_BOX: 1 } })).status, 200);
    assert.equal((await draw.activate('token', { configurationVersion })).status, 200);
    const drawRequest = { contractVersion: 'raffle-v2', configurationVersion,
      idempotencyKey: randomUUID() };
    assert.deepEqual(await draw.submit('token', drawRequest),
      { status: 409, body: { code: 'INSUFFICIENT_ERT' } });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_draw_operations'))
      .rows[0].n, 0);

    await pool.query(`UPDATE alpha_m2e_comfort_cutover
      SET activated_at = '2026-10-01T00:00:00Z' WHERE id = true`);
    const token = 'f'.repeat(64);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,'2027-01-01T00:00:00Z')`,
    [createHash('sha256').update(token).digest('hex'), accountId]);
    const batch = { installationId: randomUUID(), batchId: randomUUID(), sequence: 0,
      localDate: '2026-10-03', timezoneOffsetMinutes: 0,
      observedStartedAt: '2026-10-03T09:00:00Z',
      observedEndedAt: '2026-10-03T09:30:00Z',
      stepDelta: 5000, sensorEventCount: 5000,
      source: 'android_step_counter', algorithmVersion: 'step-counter-v1' };
    const receive = body => receiveM2eStepBatch({ pool, token, body,
      chain: { async listOwnedRings() { return []; },
        async readEquipmentEligibility() { return { state: 'UNKNOWN' }; } },
      programId: walletAddress, cluster: 'devnet', walletEnvironment: 'alpha-local',
      now: () => new Date('2026-10-03T10:00:00Z') });
    const earned = await receive(batch);
    assert.equal(earned.status, 'ACCEPTED');
    assert.equal(earned.acceptedStepDelta, 5000);
    assert.ok(new Decimal(earned.earnedErtDeltaExact).gt(2));
    assert.deepEqual(await receive(batch), earned);
    await assert.rejects(receive({ ...batch, stepDelta: 4999 }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    const awarded = await draw.submit('token', drawRequest);
    assert.equal(awarded.status, 200);
    assert.equal(awarded.body.reward.type, 'ERU');
    assert.equal(awarded.body.fulfillment.state, 'PENDING');
    const replay = await draw.submit('token', drawRequest);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.operation.replayed, true);
    assert.equal(replay.body.draw.drawResultId, awarded.body.draw.drawResultId);
    const expectedBalance = new Decimal(earned.earnedErtDeltaExact).plus(95).toString();
    const expectedAvailable = new Decimal(expectedBalance).minus(97).toString();
    assert.deepEqual(await hybrid.available(accountId),
      { balance: expectedBalance, reserved: '97', available: expectedAvailable });
    await assert.rejects(pool.query(`INSERT INTO alpha_ert_ledger
      (id,account_id,event_key,amount) VALUES ($1,$2,'draw-entry:overspend',-7)`,
    [randomUUID(), accountId]), { code: '23514' });
    await assert.rejects(pool.query(`UPDATE alpha_ert_reservations SET state = 'consumed'
      WHERE id = $1`, [silverHold.reservationId]), { code: '23514' });

    await hybrid.markUnknown(cooper.operationId);
    await hybrid.markUnknown(silver.operationId);
    const restarted = createHybridErtFoundation({ pool });
    const event = { operationId: silver.operationId, cluster: 'devnet',
      eventKey: 'synthetic:silver:finality', payloadDigest: 'd'.repeat(64) };
    assert.deepEqual(await restarted.recordInbox(event),
      { operationId: silver.operationId, replay: false, status: 'unverified' });
    assert.deepEqual(await restarted.recordInbox(event),
      { operationId: silver.operationId, replay: true, status: 'unverified' });
    assert.equal((await restarted.reserve(silver)).reservationId, silverHold.reservationId);
    assert.deepEqual(await restarted.available(accountId),
      { balance: expectedBalance, reserved: '97', available: expectedAvailable });
    const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM alpha_ert_reservations WHERE state = 'held') AS holds,
      (SELECT count(*)::int FROM alpha_hybrid_outbox WHERE state = 'unknown') AS unknown,
      (SELECT count(*)::int FROM alpha_hybrid_inbox) AS inbox,
      (SELECT count(*)::int FROM alpha_draw_operations) AS draws,
      (SELECT count(*)::int FROM alpha_ert_ledger WHERE event_key LIKE
        'draw-entry:%' AND event_key <> 'draw-entry:overspend') AS drawDebits,
      (SELECT count(*)::int FROM alpha_m2e_batches WHERE status = 'ACCEPTED') AS batches,
      (SELECT count(*)::int FROM alpha_ert_ledger WHERE event_key LIKE
        'm2e-step-batch:%') AS m2eCredits,
      (SELECT count(*)::int FROM alpha_ert_ledger WHERE event_key =
        'draw-entry:overspend') AS overspend`)).rows[0];
    assert.deepEqual(counts, { holds: 3, unknown: 2, inbox: 1, draws: 1,
      drawdebits: 1, batches: 1, m2ecredits: 1, overspend: 0 });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
