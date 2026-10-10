import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { calculateM2eEntitlementForSteps } from '../src/m2e-earning-calculator.js';
import { recordM2eComfortChange, resolveM2eComfortEpoch } from
  '../src/m2e-comfort-epochs.js';
import { settleM2eDailyInTransaction } from '../src/m2e-daily-accounting.js';
import { createM2eBalanceConfig } from '../src/m2e-balance-config.js';
import { ErtDecimal, canonicalErt } from '../src/m2e-ert-decimal.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');

test('same-day Comfort changes preserve old/offline batches, segment parity and replay', async () => {
  const schema = 'alpha_comfort_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '006_alpha_hybrid_ert_foundation.sql',
      '016_alpha_m2e_daily_accounting.sql', '034_alpha_m2e_comfort_epochs.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    await pool.query(`CREATE TABLE alpha_silver_allocation_submissions (
      signature text, account_id uuid, recorded_at timestamptz,
      mint_address text, allocation jsonb, attribute text)`);
    const accountId = randomUUID();
    const ringId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts
      (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'comfort@example.invalid','synthetic',now())`, [accountId]);
    const before = { kind: 'COOPER', id: ringId, comfort: 10 };
    const after = { kind: 'COOPER', id: ringId, comfort: 20 };
    const date = '2026-10-02';
    const started = new Date('2026-10-02T09:00:00Z');
    const changed = new Date('2026-10-02T10:00:00Z');
    const config = createM2eBalanceConfig({});
    const transaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const settle = (batchId, steps, segment, hash = 'a'.repeat(64)) =>
      transaction(client => settleM2eDailyInTransaction(client, {
        accountId, accountingDate: date, batchId, payloadHash: hash,
        acceptedStepDelta: steps, earningSegment: segment, effectiveRingCount: 1,
        resolveRingInputs: async () => ({ ringCount: 1,
          selectedRing: { kind: before.kind, id: before.id },
          selectedRingComfort: before.comfort }), config }));
    const legacy = { segmentKey: 'legacy', ring: before };
    const firstId = randomUUID();
    const first = await settle(firstId, 1000, legacy);
    const old1000 = calculateM2eEntitlementForSteps(1000, 10, config);
    assert.equal(first.deltaAuthoritativeErt, old1000.authoritativeErt);
    assert.deepEqual(await settle(firstId, 1000, legacy), first);
    const eventId = await transaction(client => recordM2eComfortChange(client, {
      accountId, sourceKey: 'cooper-points:test', previous: before,
      current: after, effectiveAt: changed }));
    const current = await transaction(client => resolveM2eComfortEpoch(client, {
      accountId, observedStartedAt: new Date('2026-10-02T10:01:00Z'),
      observedEndedAt: new Date('2026-10-02T10:02:00Z'), current: after }));
    assert.equal(current.segmentKey, eventId);
    const second = await settle(randomUUID(), 1000, current);
    const new1000 = calculateM2eEntitlementForSteps(1000, 20, config);
    assert.equal(second.deltaAuthoritativeErt, new1000.authoritativeErt);
    assert.equal(second.cumulativeAuthoritativeErt,
      canonicalErt(new ErtDecimal(old1000.authoritativeErt).plus(new1000.authoritativeErt)));
    const oldOffline = await transaction(async client => {
      const dailySnapshot = (await client.query(`SELECT *
        FROM alpha_m2e_daily_snapshots WHERE account_id = $1`, [accountId])).rows[0];
      return resolveM2eComfortEpoch(client, { accountId,
        observedStartedAt: started,
        observedEndedAt: new Date('2026-10-02T09:30:00Z'),
        current: after, dailySnapshot });
    });
    assert.equal(oldOffline.segmentKey, 'legacy');
    const third = await settle(randomUUID(), 500, oldOffline);
    const old1500 = calculateM2eEntitlementForSteps(1500, 10, config);
    assert.equal(third.deltaAuthoritativeErt,
      canonicalErt(new ErtDecimal(old1500.authoritativeErt).minus(old1000.authoritativeErt)));
    const lower = { kind: 'COOPER', id: randomUUID(), comfort: 5 };
    const lowerEvent = await transaction(client => recordM2eComfortChange(client, {
      accountId, sourceKey: 'equip:lower', previous: after, current: lower,
      effectiveAt: new Date('2026-10-02T11:00:00Z') }));
    const lowerEpoch = await transaction(client => resolveM2eComfortEpoch(client, {
      accountId, observedStartedAt: new Date('2026-10-02T11:01:00Z'),
      observedEndedAt: new Date('2026-10-02T11:02:00Z'), current: lower }));
    assert.equal(lowerEpoch.segmentKey, lowerEvent);
    const lowerFirst = await settle(randomUUID(), 1000, lowerEpoch);
    assert.equal(lowerFirst.deltaAuthoritativeErt,
      calculateM2eEntitlementForSteps(1000, 5, config).authoritativeErt);
    const lowerSecond = await settle(randomUUID(), 500, lowerEpoch);
    assert.equal(lowerSecond.deltaAuthoritativeErt, canonicalErt(
      new ErtDecimal(calculateM2eEntitlementForSteps(1500, 5, config).authoritativeErt)
        .minus(lowerFirst.deltaAuthoritativeErt)));
    await assert.rejects(() => transaction(client => resolveM2eComfortEpoch(client, {
      accountId, observedStartedAt: new Date('2026-10-02T09:59:00Z'),
      observedEndedAt: new Date('2026-10-02T10:01:00Z'), current: after })),
    { code: 'M2E_COMFORT_EPOCH_UNAVAILABLE' });
    const noEvidenceAccountId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts
      (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'no-evidence@example.invalid','synthetic',now())`,
    [noEvidenceAccountId]);
    await assert.rejects(() => transaction(client => resolveM2eComfortEpoch(client, {
      accountId: noEvidenceAccountId, observedStartedAt: new Date('2026-09-30T09:00:00Z'),
      observedEndedAt: new Date('2026-09-30T09:01:00Z'), current: after })),
    { code: 'M2E_COMFORT_EPOCH_UNAVAILABLE' });
    const silverMint = 'SilverMintForComfortEpochTest';
    const cutoverAt = (await pool.query(`SELECT activated_at FROM
      alpha_m2e_comfort_cutover WHERE id = true`)).rows[0].activated_at.getTime();
    const submittedAt = new Date(cutoverAt + 60_000);
    const oldSilver = { kind: 'SILVER_RING', id: silverMint, comfort: 12 };
    const upgradedSilver = { ...oldSilver, comfort: 13 };
    const cutoverSegment = await transaction(client => resolveM2eComfortEpoch(client, {
      accountId: noEvidenceAccountId,
      observedStartedAt: new Date(cutoverAt + 10_000),
      observedEndedAt: new Date(cutoverAt + 20_000),
      current: upgradedSilver,
      dailySnapshot: { selected_ring_kind: oldSilver.kind,
        selected_ring_id: oldSilver.id, selected_ring_comfort: oldSilver.comfort } }));
    assert.deepEqual(cutoverSegment, { segmentKey: 'cutover', ring: upgradedSilver });
    await pool.query(`INSERT INTO alpha_silver_allocation_submissions
      (signature, account_id, recorded_at, mint_address, allocation)
      VALUES ('pending-silver-comfort', $1, $2, $3, '{"comfort":1}')`,
    [noEvidenceAccountId, submittedAt, silverMint]);
    await assert.rejects(() => transaction(client => resolveM2eComfortEpoch(client, {
      accountId: noEvidenceAccountId,
      observedStartedAt: new Date(cutoverAt + 10_000),
      observedEndedAt: new Date(cutoverAt + 20_000),
      current: upgradedSilver,
      dailySnapshot: { selected_ring_kind: oldSilver.kind,
        selected_ring_id: oldSilver.id, selected_ring_comfort: oldSilver.comfort } })),
    { code: 'M2E_COMFORT_EPOCH_UNAVAILABLE' });
    await assert.rejects(() => transaction(client => resolveM2eComfortEpoch(client, {
      accountId: noEvidenceAccountId,
      observedStartedAt: new Date(cutoverAt + 70_000),
      observedEndedAt: new Date(cutoverAt + 80_000),
      current: upgradedSilver,
      dailySnapshot: { selected_ring_kind: oldSilver.kind,
        selected_ring_id: oldSilver.id, selected_ring_comfort: oldSilver.comfort } })),
    { code: 'M2E_COMFORT_EPOCH_UNAVAILABLE' });
    await pool.query(`INSERT INTO alpha_silver_allocation_submissions
      (signature, account_id, recorded_at, mint_address, allocation)
      VALUES ('unrelated-silver-comfort', $1, $2, $3, '{"comfort":1}')`,
    [accountId, submittedAt, silverMint]);
    const unrelated = await transaction(client => resolveM2eComfortEpoch(client, {
      accountId,
      observedStartedAt: new Date(cutoverAt + 70_000),
      observedEndedAt: new Date(cutoverAt + 80_000), current: lower }));
    assert.equal(unrelated.segmentKey, lowerEvent);
    const reselectedSilverEvent = await transaction(client =>
      recordM2eComfortChange(client, { accountId: noEvidenceAccountId,
        sourceKey: 'equip:verified-silver-after-pending',
        previous: { kind: 'COOPER', id: ringId, comfort: 10 },
        current: upgradedSilver,
        effectiveAt: new Date(cutoverAt + 90_000) }));
    const reselectedSilver = await transaction(client => resolveM2eComfortEpoch(client, {
      accountId: noEvidenceAccountId,
      observedStartedAt: new Date(cutoverAt + 100_000),
      observedEndedAt: new Date(cutoverAt + 110_000),
      current: upgradedSilver }));
    assert.equal(reselectedSilver.segmentKey, reselectedSilverEvent);
    const snapshot = (await pool.query(`SELECT selected_ring_comfort FROM
      alpha_m2e_daily_snapshots WHERE account_id = $1`, [accountId])).rows[0];
    assert.equal(snapshot.selected_ring_comfort, 10);
    const segments = (await pool.query(`SELECT segment_key,accepted_steps FROM
      alpha_m2e_comfort_segments WHERE account_id = $1 ORDER BY segment_key`,
    [accountId])).rows;
    assert.deepEqual(segments.map(row => row.accepted_steps).sort(), [1000, 1500, 1500]);
    await assert.rejects(() => pool.query(`UPDATE alpha_m2e_comfort_changes
      SET current_comfort = 99 WHERE id = $1`, [eventId]), /immutable/);
    const down = await readFile(new URL(
      '../schema/rollback/034_alpha_m2e_comfort_epochs.sql', import.meta.url), 'utf8');
    await assert.rejects(() => pool.query(down), /evidence exists/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
