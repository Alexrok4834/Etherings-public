import { randomUUID } from 'node:crypto';

const SCALE = 1_000_000_000_000_000_000n;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,29})(?:\.([0-9]{0,17}[1-9]))?$/;
const TYPES = new Set(['cooper_breeding', 'silver_progression', 'cooper_level_up', 'draw']);
const CLUSTERS = new Set(['local-validator', 'devnet']);

function units(value) {
  if (typeof value !== 'string' || !AMOUNT.test(value))
    throw new TypeError('Expected canonical ERT decimal string');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
}

function storedUnits(value) {
  if (typeof value !== 'string' || !/^-?[0-9]+(?:\.[0-9]{1,18})?$/.test(value))
    throw new TypeError('Invalid persisted ERT decimal');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole) * SCALE + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  return negative ? -result : result;
}

function decimal(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return sign + (absolute / SCALE).toString() + (fraction ? `.${fraction}` : '');
}

function reject(message) {
  const error = new Error(message);
  error.code = message;
  throw error;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createHybridErtFoundation({ pool }) {
  return {
    async available(accountId) {
      if (!UUID.test(accountId)) throw new TypeError('Invalid account ID');
      const row = (await pool.query(
        'SELECT balance, reserved, available FROM alpha_ert_available WHERE account_id = $1',
        [accountId])).rows[0];
      return row ? Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, decimal(storedUnits(value))])) : null;
    },

    async reserve({ operationId, accountId, walletAddress, cluster, operationType,
      requestDigest, ertAmount }) {
      if (!UUID.test(operationId) || !UUID.test(accountId) ||
          typeof walletAddress !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress) ||
          !CLUSTERS.has(cluster) || !TYPES.has(operationType) || !DIGEST.test(requestDigest))
        throw new TypeError('Invalid hybrid operation binding');
      const required = units(ertAmount);
      if (required <= 0n) throw new TypeError('ERT reservation must be positive');

      return transaction(pool, async client => {
        await client.query(
          `INSERT INTO alpha_ert_accounts(account_id)
           SELECT id FROM alpha_accounts WHERE id = $1 AND verified_at IS NOT NULL
           ON CONFLICT DO NOTHING`, [accountId]);
        const locked = await client.query(
          'SELECT account_id FROM alpha_ert_accounts WHERE account_id = $1 FOR UPDATE',
          [accountId]);
        if (!locked.rowCount) reject('VERIFIED_ACCOUNT_REQUIRED');
        const binding = (await client.query(
          'SELECT wallet_address FROM alpha_wallet_bindings WHERE account_id = $1',
          [accountId])).rows[0];
        if (!binding || binding.wallet_address !== walletAddress) reject('BOUND_WALLET_REQUIRED');

        const existing = (await client.query(
          `SELECT o.*, r.id AS reservation_id, r.state AS reservation_state,
                  x.payload_digest AS outbox_digest
           FROM alpha_hybrid_operations o
           LEFT JOIN alpha_ert_reservations r ON r.operation_id = o.id
           LEFT JOIN alpha_hybrid_outbox x ON x.operation_id = o.id
           WHERE o.id = $1`, [operationId])).rows[0];
        if (existing) {
          if (existing.account_id !== accountId || existing.wallet_address !== walletAddress ||
              existing.cluster !== cluster || existing.operation_type !== operationType ||
              existing.request_digest !== requestDigest ||
              storedUnits(existing.ert_amount) !== required || !existing.reservation_id ||
              existing.outbox_digest !== requestDigest) reject('OPERATION_CONFLICT');
          return { operationId, reservationId: existing.reservation_id,
            status: existing.status, reservationState: existing.reservation_state, replay: true };
        }

        const row = (await client.query(
          'SELECT available FROM alpha_ert_available WHERE account_id = $1',
          [accountId])).rows[0];
        const available = storedUnits(row.available);
        if (available < required) reject('INSUFFICIENT_ERT');
        const reservationId = randomUUID();
        await client.query(
          `INSERT INTO alpha_hybrid_operations
           (id, account_id, wallet_address, cluster, operation_type, request_digest, ert_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [operationId, accountId, walletAddress, cluster, operationType, requestDigest, ertAmount]);
        await client.query(
          `INSERT INTO alpha_ert_reservations(id, operation_id, account_id, amount)
           VALUES ($1, $2, $3, $4)`, [reservationId, operationId, accountId, ertAmount]);
        await client.query(
          `INSERT INTO alpha_hybrid_outbox(operation_id, payload_digest) VALUES ($1, $2)`,
          [operationId, requestDigest]);
        return { operationId, reservationId, status: 'pending',
          reservationState: 'held', availableAfter: decimal(available - required), replay: false };
      });
    },

    async markUnknown(operationId) {
      if (!UUID.test(operationId)) throw new TypeError('Invalid operation ID');
      return transaction(pool, async client => {
        const row = (await client.query(
          'SELECT status FROM alpha_hybrid_operations WHERE id = $1 FOR UPDATE',
          [operationId])).rows[0];
        if (!row) reject('OPERATION_NOT_FOUND');
        if (row.status !== 'pending' && row.status !== 'unknown') reject('TERMINAL_OPERATION');
        await client.query(
          "UPDATE alpha_hybrid_operations SET status = 'unknown' WHERE id = $1", [operationId]);
        await client.query(
          "UPDATE alpha_hybrid_outbox SET state = 'unknown' WHERE operation_id = $1", [operationId]);
        return { operationId, status: 'unknown' };
      });
    },

    async recordInbox({ operationId, cluster, eventKey, payloadDigest }) {
      if (!UUID.test(operationId) || !CLUSTERS.has(cluster) ||
          typeof eventKey !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(eventKey) ||
          !DIGEST.test(payloadDigest)) throw new TypeError('Invalid inbox event');
      return transaction(pool, async client => {
        const operation = (await client.query(
          'SELECT cluster FROM alpha_hybrid_operations WHERE id = $1 FOR UPDATE',
          [operationId])).rows[0];
        if (!operation || operation.cluster !== cluster) reject('OPERATION_CLUSTER_MISMATCH');
        const inserted = await client.query(
          `INSERT INTO alpha_hybrid_inbox(source, event_key, operation_id, payload_digest)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [cluster, eventKey, operationId, payloadDigest]);
        const existing = (await client.query(
          'SELECT operation_id, payload_digest FROM alpha_hybrid_inbox WHERE source = $1 AND event_key = $2',
          [cluster, eventKey])).rows[0];
        if (existing.operation_id !== operationId || existing.payload_digest !== payloadDigest)
          reject('INBOX_CONFLICT');
        return { operationId, replay: inserted.rowCount === 0, status: 'unverified' };
      });
    },
  };
}
