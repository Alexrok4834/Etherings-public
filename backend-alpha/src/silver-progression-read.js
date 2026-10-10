import { createHash } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unavailable = () => new Error('Silver progression preparation unavailable');
const units = value => {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(text)) throw unavailable();
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
};

export async function readPreparedSilver(client, accountId, operationId) {
  if (!UUID.test(accountId ?? '') || !UUID.test(operationId ?? '')) throw unavailable();
  const row = (await client.query(`SELECT p.id AS operation_id, p.*, r.state AS reservation_state,
      b.wallet_address AS current_wallet
    FROM alpha_silver_progression_operations p
    JOIN alpha_accounts a ON a.id = p.account_id AND a.verified_at IS NOT NULL
    JOIN alpha_wallet_bindings b ON b.account_id = p.account_id
    JOIN alpha_hybrid_operations h ON h.id = p.hybrid_operation_id
      AND h.account_id = p.account_id AND h.wallet_address = p.wallet_address
      AND h.cluster = p.cluster AND h.operation_type = 'silver_progression'
      AND h.request_digest = p.request_digest AND h.ert_amount = p.ert_cost
      AND h.status = 'pending'
    JOIN alpha_ert_reservations r ON r.id = p.reservation_id
      AND r.operation_id = h.id AND r.account_id = p.account_id
      AND r.amount = p.ert_cost
    JOIN alpha_hybrid_outbox x ON x.operation_id = h.id
      AND x.payload_digest = p.request_digest AND x.state = 'pending'
    WHERE p.id = $1 AND p.account_id = $2`, [operationId, accountId])).rows[0];
  if (!row || row.cluster !== 'devnet' || row.status !== 'prepared' ||
      row.reservation_state !== 'held' || row.response_snapshot !== null ||
      row.current_wallet !== row.wallet_address ||
      !Number.isInteger(row.expected_level) ||
      row.target_level !== row.expected_level + 1 ||
      Number(row.ert_cost) !== 5 * (row.target_level + 1)) throw unavailable();
  const expected = row.target_level === 5 ? ['38', '0.76'] :
    row.target_level === 20 ? ['75', '1.5'] : ['0', '0'];
  if (units(row.eru_principal) !== units(expected[0]) ||
      units(row.eru_fee) !== units(expected[1])) throw unavailable();
  const cost = String(5 * (row.target_level + 1));
  const digest = createHash('sha256').update(JSON.stringify({
    accountId, mint: row.mint_address, expectedLevel: row.expected_level,
    targetLevel: row.target_level, cost,
  })).digest('hex');
  if (row.request_digest !== digest) throw unavailable();
  return row;
}
