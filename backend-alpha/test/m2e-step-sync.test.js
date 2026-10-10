import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { createM2eStepSync, receiveM2eStepBatch } from '../src/m2e-step-sync.js';
import { recordM2eComfortChange } from '../src/m2e-comfort-epochs.js';
import { createAlphaServer } from '../src/server.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');

test('guarded Alpha batch transaction preserves account replay, order, overlap and exact settlement', async () => {
  const schema = 'alpha_step_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '006_alpha_hybrid_ert_foundation.sql', '013_alpha_starter_cooper.sql',
      '015_alpha_ring_equipment.sql', '016_alpha_m2e_daily_accounting.sql',
      '017_alpha_m2e_step_batches.sql', '019_alpha_cooper_current_state.sql',
      '034_alpha_m2e_comfort_epochs.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    await pool.query(`UPDATE alpha_m2e_comfort_cutover
      SET activated_at = '2026-09-01T00:00:00Z' WHERE id = true`);
    await pool.query(`CREATE TABLE alpha_silver_allocation_submissions (
      signature text, account_id uuid, recorded_at timestamptz,
      mint_address text, allocation jsonb, attribute text)`);
    await pool.query(`CREATE TABLE alpha_draw_cooper_rings (
      account_id uuid NOT NULL, ring_id uuid NOT NULL)`);
    const down = await readFile(new URL('../schema/rollback/017_alpha_m2e_step_batches.sql',
      import.meta.url), 'utf8');
    await pool.query(down);
    await pool.query(await readFile(new URL('../schema/017_alpha_m2e_step_batches.sql',
      import.meta.url), 'utf8'));
    const accountId = randomUUID();
    const ringId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const wallet = bs58.encode(randomBytes(32));
    const otherAccountId = randomUUID();
    const otherToken = randomBytes(32).toString('hex');
    const otherWallet = bs58.encode(randomBytes(32));
    const otherRingId = randomUUID();
    const programId = bs58.encode(randomBytes(32));
    const silverMint = bs58.encode(randomBytes(32));
    const otherSilverMint = bs58.encode(randomBytes(32));
    const installationA = randomUUID();
    const installationB = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'step@example.invalid','synthetic',now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_sessions (token_hash,account_id,expires_at)
      VALUES ($1,$2,'2027-01-01T00:00:00Z')`,
    [createHash('sha256').update(token).digest('hex'), accountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings
      (account_id,wallet_address,environment) VALUES ($1,$2,'alpha-dev')`,
    [accountId, wallet]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',20,6,7,8)`,
    [accountId, ringId, randomUUID()]);
    await pool.query(`INSERT INTO alpha_ring_selection
      (account_id,ring_kind,ring_id) VALUES ($1,'COOPER',$2)`, [accountId, ringId]);
    await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'other-step@example.invalid','synthetic',now())`, [otherAccountId]);
    await pool.query(`INSERT INTO alpha_sessions (token_hash,account_id,expires_at)
      VALUES ($1,$2,'2027-01-01T00:00:00Z')`,
    [createHash('sha256').update(otherToken).digest('hex'), otherAccountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings
      (account_id,wallet_address,environment) VALUES ($1,$2,'alpha-dev')`,
    [otherAccountId, otherWallet]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',5,6,7,8)`,
    [otherAccountId, otherRingId, randomUUID()]);
    await pool.query(`INSERT INTO alpha_ring_selection
      (account_id,ring_kind,ring_id) VALUES ($1,'COOPER',$2)`, [otherAccountId, otherRingId]);
    let clock = '2026-09-27T10:00:00.000Z';
    let resolutions = 0;
    let silverOwned = [];
    let eligibility = 'ELIGIBLE';
    let otherEligibility = 'UNKNOWN';
    let listingState = null;
    const marketReader = { async readListing(mintAddress) {
      return mintAddress === silverMint && listingState
        ? { mintAddress, kind: 'SILVER_RING', state: listingState } : null;
    } };
    const chain = {
      async listOwnedRings(request) {
        resolutions++;
        assert.equal(request.programId, programId);
        assert.equal(request.cluster, 'devnet');
        assert.ok([wallet, otherWallet].includes(request.walletAddress));
        return request.walletAddress === wallet ? silverOwned : [];
      },
      async readEquipmentEligibility({ mintAddress }) {
        if (mintAddress === otherSilverMint) return otherEligibility === 'ELIGIBLE'
          ? { state: 'ELIGIBLE', ring: silverOwned.find(ring =>
            ring.mintAddress === otherSilverMint) } : { state: otherEligibility };
        assert.equal(mintAddress, silverMint);
        return eligibility === 'ELIGIBLE' ? { state: eligibility, ring: silverOwned[0] } :
          { state: eligibility };
      },
    };
    const body = ({ installationId = installationA, batchId = randomUUID(), sequence = 0,
      date = '2026-09-27', start = '09:00', end = '09:10', steps = 1000 } = {}) => ({
      installationId, batchId, sequence, localDate: date, timezoneOffsetMinutes: 0,
      observedStartedAt: `${date}T${start}:00Z`, observedEndedAt: `${date}T${end}:00Z`,
      stepDelta: steps, sensorEventCount: steps, source: 'android_step_counter',
      algorithmVersion: 'step-counter-v1',
    });
    const receive = (request, bearer = token) => receiveM2eStepBatch({
      pool, token: bearer, body: request, chain, marketReader,
      programId, cluster: 'devnet',
      walletEnvironment: 'alpha-dev',
      now: () => new Date(clock) });

    const firstBody = body();
    const first = await receive(firstBody);
    assert.equal(first.status, 'ACCEPTED');
    assert.equal(first.earnedErtDeltaExact, '1.3065');
    assert.equal(first.dailyStepCap, 5000);
    const otherFirst = await receive(firstBody, otherToken);
    assert.equal(otherFirst.status, 'ACCEPTED');
    assert.notEqual(otherFirst.m2eSettlement.snapshotId, first.m2eSettlement.snapshotId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE account_id = $1`, [otherAccountId])).rows[0].n, 1);
    await assert.rejects(() => pool.query(`UPDATE alpha_m2e_batches
      SET accepted_step_delta = 0 WHERE batch_id = $1`, [firstBody.batchId]), /immutable/);
    assert.deepEqual(await receive(firstBody), first);
    assert.equal(resolutions, 2);
    await assert.rejects(() => receive(body({ sequence: 1,
      start: '09:10', end: '09:20' }), '0'.repeat(64)), { code: 'AUTH_REQUIRED' });
    await pool.query(`UPDATE alpha_wallet_bindings SET environment = 'other-dev'
      WHERE account_id = $1`, [otherAccountId]);
    await assert.rejects(() => receive(body({ sequence: 1,
      start: '09:10', end: '09:20' }), otherToken),
    { code: 'WALLET_BINDING_REQUIRED' });
    await pool.query(`UPDATE alpha_wallet_bindings SET environment = 'alpha-dev'
      WHERE account_id = $1`, [otherAccountId]);
    await pool.query(`UPDATE alpha_sessions SET expires_at = '2026-09-26T00:00:00Z'
      WHERE account_id = $1`, [otherAccountId]);
    await assert.rejects(() => receive(body({ sequence: 1,
      start: '09:10', end: '09:20' }), otherToken), { code: 'AUTH_REQUIRED' });
    await assert.rejects(() => receive({ ...firstBody, stepDelta: 1001 }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(() => receive(body({ start: '09:10', end: '09:20' })),
      { code: 'SEQUENCE_CONFLICT' });
    const overlapping = await receive(body({ installationId: installationB,
      start: '09:05', end: '09:15' }));
    assert.equal(overlapping.resultCode, 'OVERLAPPING_INTERVAL');
    assert.equal(overlapping.acceptedStepDelta, 0);
    assert.deepEqual(await receive(body({ installationId: installationB,
      batchId: overlapping.batchId, start: '09:05', end: '09:15' })), overlapping);
    const partial = await receive(body({ sequence: 1, start: '09:10', end: '09:40',
      steps: 5000 }));
    assert.equal(partial.status, 'PARTIALLY_ACCEPTED');
    assert.equal(partial.acceptedStepDelta, 4000);
    assert.equal(partial.earnedErtDeltaExact, '5.226');
    assert.equal(partial.m2eSettlement.snapshotId, first.m2eSettlement.snapshotId);
    const capped = await receive(body({ sequence: 2, start: '09:40', end: '09:50' }));
    assert.equal(capped.resultCode, 'DAILY_CAP_REACHED');
    assert.equal(capped.dailyStepCap, 5000);
    assert.equal(resolutions, 4);
    const future = await receive(body({ sequence: 4, start: '12:00', end: '12:10' }));
    assert.equal(future.resultCode, 'FUTURE_TIMESTAMP');
    const late = await receive(body({ sequence: 3, start: '09:50', end: '10:00' }));
    assert.equal(late.resultCode, 'SEQUENCE_OUT_OF_ORDER');

    clock = '2026-09-28T10:00:00.000Z';
    silverOwned = [{ finalized: true, kind: 'SILVER_RING', programId,
      cluster: 'devnet', tokenOwner: wallet, mintAddress: silverMint, comfort: 45 }];
    await pool.query(`UPDATE alpha_ring_selection SET ring_kind = 'SILVER_RING',
      ring_id = $2, version = version + 1 WHERE account_id = $1`,
    [accountId, silverMint]);
    const sharedClientBatchId = randomUUID();
    const day2A = await receive(body({ sequence: 5, date: '2026-09-28',
      batchId: sharedClientBatchId }));
    eligibility = 'UNKNOWN'; // New capacity cannot be trusted until chain read recovers.
    const day2BRequest = body({ installationId: installationB, sequence: 1,
      date: '2026-09-28', batchId: sharedClientBatchId, start: '09:10', end: '09:20' });
    await assert.rejects(() => receive(day2BRequest),
      { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
    eligibility = 'ELIGIBLE';
    const day2B = await receive(day2BRequest);
    assert.equal(day2A.status, 'ACCEPTED');
    assert.equal(day2B.status, 'ACCEPTED');
    assert.equal(day2A.m2eSettlement.selectedRingComfort, 45);
    assert.equal(day2A.m2eSettlement.ringCount, 2);
    assert.equal(day2B.m2eSettlement.snapshotId, day2A.m2eSettlement.snapshotId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE account_id = $1`, [accountId])).rows[0].n, 4);

    clock = '2026-09-29T10:00:00.000Z';
    eligibility = 'UNKNOWN';
    await assert.rejects(() => receive(body({ sequence: 6, date: '2026-09-29' })),
      { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_batches
      WHERE local_date = '2026-09-29'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_daily_snapshots
      WHERE accounting_date = '2026-09-29'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT ring_kind, ring_id FROM alpha_ring_selection
      WHERE account_id = $1`, [accountId])).rows[0].ring_id, silverMint);
    eligibility = 'COOLDOWN';
    const cooled = await receive(body({ sequence: 6, date: '2026-09-29' }));
    assert.equal(cooled.status, 'ACCEPTED');
    assert.deepEqual(cooled.m2eSettlement.selectedRing, { kind: 'COOPER', id: ringId });
    assert.equal(cooled.m2eSettlement.ringCount, 1);
    assert.equal((await pool.query(`SELECT ring_kind, ring_id FROM alpha_ring_selection
      WHERE account_id = $1`, [accountId])).rows[0].ring_id, ringId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
      WHERE account_id = $1 AND event_type = 'FALLBACK' AND reason = 'COOLDOWN'`,
    [accountId])).rows[0].n, 1);
    assert.deepEqual(await receive(body({ sequence: 6, date: '2026-09-29',
      batchId: cooled.batchId })), cooled);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
      WHERE account_id = $1 AND event_type = 'FALLBACK'`, [accountId])).rows[0].n, 1);
    clock = '2026-09-30T10:00:00.000Z';
    eligibility = 'ELIGIBLE';
    const [raceA, raceB] = await Promise.all([
      receive(body({ installationId: randomUUID(), date: '2026-09-30',
        end: '09:30', steps: 5000 })),
      receive(body({ installationId: randomUUID(), date: '2026-09-30',
        start: '09:30', end: '10:00', steps: 5000 })),
    ]);
    assert.deepEqual([raceA.acceptedStepDelta, raceB.acceptedStepDelta].sort(),
      [1000, 5000]);
    assert.equal(raceA.m2eSettlement.snapshotId, raceB.m2eSettlement.snapshotId);
    const raced = (await pool.query(`SELECT accepted_steps, earned_ert::text AS earned
      FROM alpha_m2e_daily_stats WHERE account_id = $1 AND accounting_date = '2026-09-30'`,
    [accountId])).rows[0];
    assert.equal(raced.accepted_steps, 6000);
    assert.equal(raced.earned, '7.839000000000000000');
    assert.deepEqual(raceA.m2eSettlement.selectedRing, { kind: 'COOPER', id: ringId });
    clock = '2026-10-01T10:00:00.000Z';
    await pool.query(`UPDATE alpha_ring_selection SET ring_kind = 'SILVER_RING',
      ring_id = $2, version = version + 1 WHERE account_id = $1`, [accountId, silverMint]);
    silverOwned = [];
    eligibility = 'TRANSFERRED_AWAY';
    const transferred = await receive(body({ sequence: 7, date: '2026-10-01' }));
    assert.equal(transferred.status, 'ACCEPTED');
    assert.deepEqual(transferred.m2eSettlement.selectedRing,
      { kind: 'COOPER', id: ringId });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
      WHERE account_id = $1 AND event_type = 'FALLBACK' AND reason = 'TRANSFERRED_AWAY'`,
    [accountId])).rows[0].n, 1);
    clock = '2026-10-02T10:00:00.000Z';
    await pool.query(`UPDATE alpha_ring_selection SET ring_kind = 'SILVER_RING',
      ring_id = $2, version = version + 1 WHERE account_id = $1`, [accountId, silverMint]);
    silverOwned = [
      { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
        tokenOwner: wallet, mintAddress: silverMint, comfort: 45 },
      { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
        tokenOwner: wallet, mintAddress: otherSilverMint, comfort: 30 },
    ];
    eligibility = 'COOLDOWN';
    const ledgerBeforeUnknown = (await pool.query(`SELECT count(*)::int AS n
      FROM alpha_ert_ledger WHERE account_id = $1`, [accountId])).rows[0].n;
    const fallbackOnlyInstallation = randomUUID();
    await assert.rejects(() => receive(body({ installationId: fallbackOnlyInstallation,
      date: '2026-10-02' })),
      { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT ring_kind, ring_id FROM alpha_ring_selection
      WHERE account_id = $1`, [accountId])).rows[0].ring_id, ringId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
      WHERE account_id = $1 AND event_type = 'FALLBACK' AND reason = 'COOLDOWN'`,
    [accountId])).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_batches
      WHERE account_id = $1 AND local_date = '2026-10-02'`, [accountId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_installations
      WHERE account_id = $1 AND installation_id = $2`,
    [accountId, fallbackOnlyInstallation])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_daily_snapshots
      WHERE account_id = $1 AND accounting_date = '2026-10-02'`,
    [accountId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE account_id = $1`, [accountId])).rows[0].n, ledgerBeforeUnknown);
    clock = '2026-10-03T10:00:00.000Z';
    silverOwned = [];
    const rateInstallation = randomUUID();
    const rateBody = (sequence, start, end, steps) => ({
      ...body({ installationId: rateInstallation, sequence, date: '2026-10-03',
        steps }), observedStartedAt: `2026-10-03T09:00:${start}Z`,
      observedEndedAt: `2026-10-03T09:00:${end}Z`,
    });
    const zeroRateBody = rateBody(0, '00.000', '00.001', 100);
    const zeroRate = await receive(zeroRateBody);
    assert.equal(zeroRate.status, 'REJECTED');
    assert.equal(zeroRate.resultCode, 'RATE_CAP_ZERO');
    assert.equal(zeroRate.acceptedStepDelta, 0);
    assert.deepEqual(await receive(zeroRateBody), zeroRate);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_daily_snapshots
      WHERE account_id = $1 AND accounting_date = '2026-10-03'`,
    [accountId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE account_id = $1`, [accountId])).rows[0].n, ledgerBeforeUnknown);
    const rateLimitedBody = rateBody(1, '01.000', '03.000', 10);
    const rateLimited = await receive(rateLimitedBody);
    assert.equal(rateLimited.status, 'PARTIALLY_ACCEPTED');
    assert.equal(rateLimited.acceptedStepDelta, 6);
    assert.deepEqual(await receive(rateLimitedBody), rateLimited);
    const exactRate = await receive(rateBody(2, '04.000', '06.000', 6));
    assert.equal(exactRate.status, 'ACCEPTED');
    assert.equal(exactRate.acceptedStepDelta, 6);
    const flooredRate = await receive(rateBody(3, '07.000', '07.999', 3));
    assert.equal(flooredRate.status, 'PARTIALLY_ACCEPTED');
    assert.equal(flooredRate.acceptedStepDelta, 2);
    const rateReceipt = (await pool.query(`SELECT claimed_step_count, accepted_step_delta
      FROM alpha_m2e_batches WHERE account_id = $1 AND batch_id = $2`,
    [accountId, rateLimitedBody.batchId])).rows[0];
    assert.equal(rateReceipt.claimed_step_count, 10);
    assert.equal(rateReceipt.accepted_step_delta, 6);
    const rateStats = (await pool.query(`SELECT accepted_steps FROM alpha_m2e_daily_stats
      WHERE account_id = $1 AND accounting_date = '2026-10-03'`,
    [accountId])).rows[0];
    assert.equal(rateStats.accepted_steps, 14);
    clock = '2026-10-04T10:20:00.000Z';
    const liveInstallation = randomUUID();
    const liveBody = (sequence, start, end, steps = 1000) => body({
      installationId: liveInstallation, sequence, date: '2026-10-04',
      start, end, steps,
    });
    const frozenFirstBody = liveBody(0, '09:00', '09:30', 5000);
    const frozenFirst = await receive(frozenFirstBody);
    assert.equal(frozenFirst.dailyStepCap, 5000);
    eligibility = 'ELIGIBLE';
    silverOwned = [{ finalized: true, kind: 'SILVER_RING', programId,
      cluster: 'devnet', tokenOwner: wallet, mintAddress: silverMint, comfort: 45 }];
    const raised = await receive(liveBody(1, '09:30', '09:40'));
    assert.equal(raised.dailyStepCap, 6000);
    assert.equal(raised.acceptedStepDelta, 1000);
    assert.equal(raised.m2eSettlement.selectedRingComfort, 20);
    assert.equal(raised.m2eSettlement.ringCount, 2);
    assert.equal(raised.m2eSettlement.snapshotId, frozenFirst.m2eSettlement.snapshotId);
    assert.deepEqual(await receive(frozenFirstBody), frozenFirst);
    listingState = 'ACTIVE';
    const loweredBody = liveBody(2, '09:40', '09:50');
    const lowered = await receive(loweredBody);
    assert.equal(lowered.resultCode, 'DAILY_CAP_REACHED');
    assert.equal(lowered.dailyStepCap, 5000);
    assert.deepEqual(await receive(loweredBody), lowered);
    listingState = 'CANCELLED';
    const unlisted = await receive(liveBody(3, '09:50', '10:00'));
    assert.equal(unlisted.resultCode, 'DAILY_CAP_REACHED');
    assert.equal(unlisted.dailyStepCap, 6000);
    silverOwned = [
      { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
        tokenOwner: wallet, mintAddress: silverMint, comfort: 45 },
      { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
        tokenOwner: wallet, mintAddress: otherSilverMint, comfort: 30 },
    ];
    otherEligibility = 'ELIGIBLE';
    const raisedAgain = await receive(liveBody(4, '10:00', '10:10'));
    assert.equal(raisedAgain.dailyStepCap, 7000);
    assert.equal(raisedAgain.acceptedStepDelta, 1000);
    silverOwned = [];
    const belowPrior = await receive(liveBody(5, '10:10', '10:20'));
    assert.equal(belowPrior.resultCode, 'DAILY_CAP_REACHED');
    assert.equal(belowPrior.dailyStepCap, 5000);
    const liveStats = (await pool.query(`SELECT accepted_steps,
      earned_ert::text AS earned FROM alpha_m2e_daily_stats
      WHERE account_id = $1 AND accounting_date = '2026-10-04'`,
    [accountId])).rows[0];
    assert.equal(liveStats.accepted_steps, 7000);
    assert.equal(liveStats.earned, '9.145500000000000000');
    assert.equal((await pool.query(`SELECT step_cap FROM alpha_m2e_daily_snapshots
      WHERE account_id = $1 AND accounting_date = '2026-10-04'`,
    [accountId])).rows[0].step_cap, 5000);
    clock = '2026-10-05T10:20:00.000Z';
    const comfortInstallation = randomUUID();
    const comfortFirstBody = body({ installationId: comfortInstallation,
      sequence: 0, date: '2026-10-05', start: '09:00', end: '09:10' });
    const comfortFirst = await receive(comfortFirstBody);
    assert.equal(comfortFirst.status, 'ACCEPTED');
    const epochClient = await pool.connect();
    try {
      await epochClient.query('BEGIN');
      await epochClient.query(`SELECT id FROM alpha_accounts WHERE id = $1 FOR UPDATE`,
        [accountId]);
      await epochClient.query(`UPDATE alpha_cooper_current_state SET comfort = 30
        WHERE account_id = $1 AND ring_id = $2`, [accountId, ringId]);
      await recordM2eComfortChange(epochClient, { accountId,
        sourceKey: 'cooper-points:step-sync-test',
        previous: { kind: 'COOPER', id: ringId, comfort: 20 },
        current: { kind: 'COOPER', id: ringId, comfort: 30 },
        effectiveAt: new Date('2026-10-05T09:20:00Z') });
      await epochClient.query('COMMIT');
    } catch (error) { await epochClient.query('ROLLBACK'); throw error; }
    finally { epochClient.release(); }
    const comfortNext = await receive(body({ installationId: comfortInstallation,
      sequence: 1, date: '2026-10-05', start: '09:30', end: '09:40' }));
    assert.equal(comfortNext.status, 'ACCEPTED');
    assert.equal(comfortNext.m2eSettlement.selectedRingComfort, 30);
    assert.equal(comfortFirst.m2eSettlement.selectedRingComfort, 20);
    assert.equal(comfortNext.m2eSettlement.snapshotId, comfortFirst.m2eSettlement.snapshotId);
    assert.ok(comfortNext.earnedErtDelta > comfortFirst.earnedErtDelta);
    assert.deepEqual(await receive(comfortFirstBody), comfortFirst);
    const adapter = createM2eStepSync({ pool, chain, programId, cluster: 'devnet',
      walletEnvironment: 'alpha-dev', now: () => new Date(clock) });
    assert.deepEqual(await adapter.receive(token, rateLimitedBody),
      { status: 200, body: rateLimited });
    assert.deepEqual(await adapter.receive('0'.repeat(64), rateLimitedBody),
      { status: 401, body: { code: 'AUTH_REQUIRED' } });
    assert.deepEqual(await adapter.receive(token, { ...rateLimitedBody, source: 'manual' }),
      { status: 400, body: { code: 'INVALID_STEP_BATCH' } });
    assert.deepEqual(await adapter.receive(token, { ...rateLimitedBody, stepDelta: 11 }),
      { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    const server = createAlphaServer({}, null, null, null, null, null, null, null,
      undefined, null, adapter);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/step-sync/batches`;
      const replay = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(rateLimitedBody) });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), rateLimited);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_batches
        WHERE account_id = $1 AND batch_id = $2`,
      [accountId, rateLimitedBody.batchId])).rows[0].n, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
    await assert.rejects(() => pool.query(down), /history exists/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
