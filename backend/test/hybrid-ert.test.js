import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createHybridErtFoundation } from '../src/hybrid-ert.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const digest = value => createHash('sha256').update(value).digest('hex');

test('Alpha ERT reservation and durable hybrid outbox/inbox on real PostgreSQL', async () => {
  const schema = 'alpha_hybrid_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connect = () => new pg.Pool({ connectionString: databaseUrl, max: 6,
      options: `-c search_path=${schema}` });
    pool = connect();
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '003_alpha_eru_intents.sql', '004_alpha_eru_intent_cluster.sql',
      '005_alpha_eru_reconciliation.sql', '006_alpha_hybrid_ert_foundation.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));

    const accountId = randomUUID();
    const walletAddress = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
    await pool.query(
      `INSERT INTO alpha_accounts(id, email_normalized, password_hash, verified_at)
       VALUES ($1, 'hybrid@example.invalid', 'synthetic-only', now())`, [accountId]);
    await pool.query(
      `INSERT INTO alpha_wallet_bindings(account_id, wallet_address, environment)
       VALUES ($1, $2, 'alpha-local')`, [accountId, walletAddress]);
    await pool.query('INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)', [accountId]);
    await pool.query(
      `INSERT INTO alpha_ert_ledger(id, account_id, event_key, amount)
       VALUES ($1, $2, 'synthetic-credit', '100.000000000000000001')`,
      [randomUUID(), accountId]);

    const service = createHybridErtFoundation({ pool });
    const request = (operationId, requestDigest) => ({ operationId, accountId,
      walletAddress, cluster: 'devnet', operationType: 'cooper_breeding',
      requestDigest, ertAmount: '60' });
    const first = request(randomUUID(), digest('first'));
    const second = request(randomUUID(), digest('second'));

    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT account_id FROM alpha_ert_accounts WHERE account_id = $1 FOR UPDATE',
      [accountId]);
    const concurrent = Promise.allSettled([service.reserve(first), service.reserve(second)]);
    await new Promise(resolve => setTimeout(resolve, 100));
    await lock.query('COMMIT');
    lock.release();
    const results = await concurrent;
    assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'INSUFFICIENT_ERT');
    const winner = results[0].status === 'fulfilled' ? first : second;
    const accepted = results.find(result => result.status === 'fulfilled').value;
    assert.equal(accepted.availableAfter, '40.000000000000000001');
    assert.deepEqual(await service.available(accountId), {
      balance: '100.000000000000000001', reserved: '60',
      available: '40.000000000000000001' });
    assert.deepEqual(await service.reserve(winner), {
      operationId: winner.operationId, reservationId: accepted.reservationId,
      status: 'pending', reservationState: 'held', replay: true });
    const repeated = await Promise.all([service.reserve(winner), service.reserve(winner)]);
    assert.deepEqual(repeated.map(result => result.reservationId),
      [accepted.reservationId, accepted.reservationId]);
    await assert.rejects(service.reserve({ ...winner, requestDigest: digest('altered') }),
      { code: 'OPERATION_CONFLICT' });
    await assert.rejects(service.reserve({ ...winner, ertAmount: '60.0000000000000000001' }),
      TypeError);
    await assert.rejects(service.reserve({ ...winner, walletAddress:
      'EdXT16XWGS5vf1X2ezwaL5TB6ZLb5XqsMxBF439FmHmi' }),
      { code: 'BOUND_WALLET_REQUIRED' });

    await assert.rejects(pool.query(
      `INSERT INTO alpha_ert_ledger(id, account_id, event_key, amount)
       VALUES ($1, $2, 'overspend', '-41')`, [randomUUID(), accountId]),
    { code: '23514' });
    await pool.query(
      `INSERT INTO alpha_ert_ledger(id, account_id, event_key, amount)
       VALUES ($1, $2, 'within-available', '-40')`, [randomUUID(), accountId]);
    assert.deepEqual(await service.available(accountId), {
      balance: '60.000000000000000001', reserved: '60',
      available: '0.000000000000000001' });
    await assert.rejects(pool.query(
      "UPDATE alpha_ert_ledger SET amount = '1000' WHERE event_key = 'synthetic-credit'"),
    { code: '23514' });
    await assert.rejects(pool.query(
      'UPDATE alpha_hybrid_operations SET request_digest = $2 WHERE id = $1',
      [winner.operationId, digest('mutated-binding')]), { code: '23514' });
    await assert.rejects(pool.query(
      `UPDATE alpha_ert_reservations SET state = 'released', release_evidence_digest = $2
       WHERE operation_id = $1`, [winner.operationId, digest('ttl-only')]),
    { code: '23514' });

    const direct = await pool.connect();
    try {
      await direct.query('BEGIN');
      const rawOperation = randomUUID();
      await direct.query(
        `INSERT INTO alpha_hybrid_operations
         (id, account_id, wallet_address, cluster, operation_type, request_digest, ert_amount)
         VALUES ($1, $2, $3, 'devnet', 'cooper_breeding', $4, '60')`,
        [rawOperation, accountId, walletAddress, digest('raw-operation')]);
      await assert.rejects(direct.query(
        `INSERT INTO alpha_ert_reservations(id, operation_id, account_id, amount)
         VALUES ($1, $2, $3, '60')`, [randomUUID(), rawOperation, accountId]),
      { code: '23514' });
    } finally {
      await direct.query('ROLLBACK');
      direct.release();
    }
    const forged = await pool.connect();
    try {
      await forged.query('BEGIN');
      const rawOperation = randomUUID();
      await forged.query(
        `INSERT INTO alpha_hybrid_operations
         (id, account_id, wallet_address, cluster, operation_type, request_digest, ert_amount)
         VALUES ($1, $2, $3, 'devnet', 'cooper_breeding', $4, '1')`,
        [rawOperation, accountId, walletAddress, digest('forged-release')]);
      await assert.rejects(forged.query(
        `INSERT INTO alpha_ert_reservations
         (id, operation_id, account_id, amount, state, release_evidence_digest)
         VALUES ($1, $2, $3, '1', 'released', $4)`,
        [randomUUID(), rawOperation, accountId, digest('fake-evidence')]),
      { code: '23514' });
    } finally {
      await forged.query('ROLLBACK');
      forged.release();
    }

    assert.deepEqual(await service.markUnknown(winner.operationId),
      { operationId: winner.operationId, status: 'unknown' });
    assert.deepEqual(await service.markUnknown(winner.operationId),
      { operationId: winner.operationId, status: 'unknown' });
    const event = { operationId: winner.operationId, cluster: 'devnet',
      eventKey: 'synthetic:finality:1', payloadDigest: digest('unverified-observation') };
    assert.deepEqual(await service.recordInbox(event),
      { operationId: winner.operationId, replay: false, status: 'unverified' });
    assert.deepEqual(await service.recordInbox(event),
      { operationId: winner.operationId, replay: true, status: 'unverified' });
    await assert.rejects(service.recordInbox({ ...event, payloadDigest: digest('altered') }),
      { code: 'INBOX_CONFLICT' });
    await assert.rejects(service.recordInbox({ ...event, cluster: 'local-validator' }),
      { code: 'OPERATION_CLUSTER_MISMATCH' });

    await pool.query(
      `UPDATE alpha_hybrid_outbox SET next_attempt_at = now() - interval '7 days'
       WHERE operation_id = $1`, [winner.operationId]);
    await pool.end();
    pool = connect();
    const restarted = createHybridErtFoundation({ pool });
    const state = (await pool.query(
      `SELECT o.status, r.state AS reservation, x.state AS outbox,
              i.state AS inbox, x.next_attempt_at < now() AS overdue
       FROM alpha_hybrid_operations o
       JOIN alpha_ert_reservations r ON r.operation_id = o.id
       JOIN alpha_hybrid_outbox x ON x.operation_id = o.id
       JOIN alpha_hybrid_inbox i ON i.operation_id = o.id
       WHERE o.id = $1`, [winner.operationId])).rows[0];
    assert.deepEqual(state, { status: 'unknown', reservation: 'held',
      outbox: 'unknown', inbox: 'unverified', overdue: true });
    assert.equal((await restarted.reserve(winner)).reservationId, accepted.reservationId);
    assert.deepEqual(await restarted.recordInbox(event),
      { operationId: winner.operationId, replay: true, status: 'unverified' });
    assert.deepEqual(await restarted.available(accountId), {
      balance: '60.000000000000000001', reserved: '60',
      available: '0.000000000000000001' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_hybrid_operations')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_ert_reservations')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_hybrid_outbox')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_hybrid_inbox')).rows[0].n, 1);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
