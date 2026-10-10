import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { settleM2eDailyInTransaction } from '../src/m2e-daily-accounting.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');

test('MVP cumulative ERT, immutable first snapshot, replay, concurrency and rollback', async () => {
  const schema = 'alpha_m2e_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '006_alpha_hybrid_ert_foundation.sql',
      '016_alpha_m2e_daily_accounting.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const down = await readFile(new URL(
      '../schema/rollback/016_alpha_m2e_daily_accounting.sql', import.meta.url), 'utf8');
    await pool.query(down);
    assert.equal((await pool.query(`SELECT to_regclass('alpha_m2e_daily_snapshots') AS name`))
      .rows[0].name, null);
    await pool.query(await readFile(new URL(
      '../schema/016_alpha_m2e_daily_accounting.sql', import.meta.url), 'utf8'));
    const accountId = randomUUID();
    const ringId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'m2e@example.invalid','synthetic',now())`, [accountId]);
    let comfort = 20;
    let ringCount = 1;
    let resolves = 0;
    const resolveRingInputs = async () => { resolves++;
      return { ringCount, selectedRing: { kind: 'COOPER', id: ringId },
        selectedRingComfort: comfort }; };
    const settle = async (batchId, payloadHash, acceptedStepDelta, date = '2026-09-27',
      resolver = resolveRingInputs) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await settleM2eDailyInTransaction(client, {
          accountId, accountingDate: date, batchId, payloadHash, acceptedStepDelta,
          resolveRingInputs: resolver });
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const batchA = randomUUID();
    const hashA = 'a'.repeat(64);
    const first = await settle(batchA, hashA, 1000);
    assert.equal(first.cumulativeAuthoritativeErt, '1.3065');
    assert.equal(first.deltaAuthoritativeErt, '1.3065');
    assert.equal(first.selectedRing.kind, 'COOPER');
    const replay = await settle(batchA, hashA, 1000, '2026-09-27', () => {
      throw new Error('replay must not resolve Ring'); });
    assert.deepEqual(replay, first);
    await assert.rejects(() => settle(batchA, 'b'.repeat(64), 1000),
      { code: 'IDEMPOTENCY_CONFLICT' });
    comfort = 45; ringCount = 4;
    const batchB = randomUUID();
    const second = await settle(batchB, 'c'.repeat(64), 4000);
    assert.equal(second.snapshotId, first.snapshotId);
    assert.equal(second.ringCount, 1);
    assert.equal(second.selectedRingComfort, 20);
    assert.equal(second.cumulativeAuthoritativeErt, '6.5325');
    assert.equal(second.deltaAuthoritativeErt, '5.226');
    assert.equal(resolves, 1);
    const next = await settle(randomUUID(), 'd'.repeat(64), 1000, '2026-09-28');
    assert.equal(next.ringCount, 4);
    assert.equal(next.selectedRingComfort, 45);
    assert.notEqual(next.snapshotId, first.snapshotId);
    await assert.rejects(() => pool.query(`UPDATE alpha_m2e_daily_snapshots
      SET ring_count = 99 WHERE id = $1`, [first.snapshotId]), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE alpha_m2e_settlements
      SET accepted_step_delta = 1 WHERE batch_id = $1`, [batchA]), /immutable/);

    const stats = (await pool.query(`SELECT accepted_steps, earned_ert::text AS earned
      FROM alpha_m2e_daily_stats WHERE account_id = $1 AND accounting_date = '2026-09-27'`,
    [accountId])).rows[0];
    assert.equal(stats.accepted_steps, 5000);
    assert.equal(stats.earned, '6.532500000000000000');
    const ledger = (await pool.query(`SELECT COALESCE(sum(amount),0)::text AS total,
      count(*)::int AS entries FROM alpha_ert_ledger WHERE account_id = $1`,
    [accountId])).rows[0];
    assert.equal(ledger.entries, 3);
    assert.equal(ledger.total, '8.006500000000000000');
    const otherAccountId = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
      VALUES ($1,'other-m2e@example.invalid','synthetic',now())`, [otherAccountId]);
    const otherClient = await pool.connect();
    try {
      await otherClient.query('BEGIN');
      const other = await settleM2eDailyInTransaction(otherClient, {
        accountId: otherAccountId, accountingDate: '2026-09-27',
        batchId: batchA, payloadHash: hashA, acceptedStepDelta: 1000,
        resolveRingInputs: async () => ({ ringCount: 1,
          selectedRing: { kind: 'COOPER', id: randomUUID() }, selectedRingComfort: 20 }) });
      assert.equal(other.cumulativeAuthoritativeErt, first.cumulativeAuthoritativeErt);
      await otherClient.query('COMMIT');
    } catch (error) { await otherClient.query('ROLLBACK'); throw error; }
    finally { otherClient.release(); }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'm2e-step-batch:%'`)).rows[0].n, 4);
    const [left, right] = await Promise.allSettled([
      settle(randomUUID(), 'e'.repeat(64), 5000, '2026-09-29'),
      settle(randomUUID(), 'f'.repeat(64), 5000, '2026-09-29'),
    ]);
    assert.deepEqual([left.status, right.status].sort(), ['fulfilled', 'rejected']);
    assert.match((left.status === 'rejected' ? left : right).reason.message,
      /frozen daily cap/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_daily_snapshots
      WHERE account_id = $1 AND accounting_date = '2026-09-29'`, [accountId])).rows[0].n, 1);
    await assert.rejects(() => settle(randomUUID(), '1'.repeat(64), 100,
      '2026-09-30', () => { throw new Error('M2E_RING_SELECTION_UNAVAILABLE'); }),
    /M2E_RING_SELECTION_UNAVAILABLE/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_m2e_daily_snapshots
      WHERE account_id = $1 AND accounting_date = '2026-09-30'`, [accountId])).rows[0].n, 0);
    await assert.rejects(() => pool.query(down), /history exists/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
