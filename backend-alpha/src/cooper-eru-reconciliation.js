import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { canonicalErt, displayErt, ErtDecimal } from './m2e-ert-decimal.js';
import { readPreparedCooperEru } from './cooper-eru-candidate-reader.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const unavailable = () => new Error('Cooper ERU reconciliation unavailable');
const validSignature = value => typeof value === 'string' &&
  /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value) && bs58.decode(value).length === 64;

// Internal only. A submission is untrusted recovery evidence, not proof of
// success. Future submitters must record before broadcasting the signed tx.
// Until a verified terminal transition, this path represents UNKNOWN by the
// durable submission while keeping preparation/hold/outbox pending; calling
// generic hybrid.markUnknown would make the current finality reader fail closed.
export function createCooperEruReconciliation({ pool, finalityReader, cluster }) {
  if (!pool || typeof pool.connect !== 'function' ||
      typeof finalityReader?.verify !== 'function' ||
      !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  const identity = (accountId, operationId) => {
    if (!UUID.test(accountId ?? '') || !UUID.test(operationId ?? '')) throw unavailable();
  };
  const settled = async (client, accountId, operationId) =>
    (await client.query(`SELECT s.signature, l.response_snapshot
      FROM alpha_cooper_level_eru_settlements s
      JOIN alpha_cooper_level_up_operations l ON l.id = s.operation_id
      WHERE s.account_id = $1 AND s.operation_id = $2`,
    [accountId, operationId])).rows[0];
  return {
    async recordSubmission(accountId, operationId, signature) {
      identity(accountId, operationId);
      if (!validSignature(signature)) throw unavailable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner || await settled(client, accountId, operationId)) throw unavailable();
        await readPreparedCooperEru(client, accountId, operationId, cluster);
        const issuance = (await client.query(`SELECT operation_id FROM
          alpha_cooper_level_eru_issuances WHERE operation_id = $1 AND account_id = $2`,
        [operationId, accountId])).rows[0];
        if (!issuance) throw unavailable();
        const inserted = await client.query(`INSERT INTO alpha_cooper_level_eru_submissions
          (signature, operation_id, account_id) VALUES ($1,$2,$3)
          ON CONFLICT (signature) DO NOTHING`, [signature, operationId, accountId]);
        const stored = (await client.query(`SELECT operation_id, account_id
          FROM alpha_cooper_level_eru_submissions WHERE signature = $1`, [signature])).rows[0];
        if (stored?.operation_id !== operationId || stored.account_id !== accountId)
          throw unavailable();
        await client.query('COMMIT');
        return { operationId, signature, status: 'unknown', replay: inserted.rowCount === 0 };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },

    async reconcile(accountId, operationId) {
      identity(accountId, operationId);
      const prior = await settled(pool, accountId, operationId);
      if (prior) return { status: 'confirmed', snapshot: prior.response_snapshot };
      const submissions = (await pool.query(`SELECT signature FROM
        alpha_cooper_level_eru_submissions WHERE account_id = $1 AND operation_id = $2
        ORDER BY recorded_at, signature`, [accountId, operationId])).rows;
      if (!submissions.length) return { status: 'unknown' };
      let receipt = null;
      for (const { signature } of submissions) {
        const observed = await finalityReader.verify(accountId, operationId, signature);
        if (observed.status === 'unknown') continue;
        if (observed.status !== 'verified' || receipt ||
            observed.signature !== signature || observed.accountId !== accountId ||
            observed.operationId !== operationId ||
            !Number.isSafeInteger(observed.slot) || observed.slot < 1 ||
            !DIGEST.test(observed.intentDigest ?? '') ||
            !DIGEST.test(observed.transactionDigest ?? '') ||
            !DIGEST.test(observed.operationReplayDigest ?? '')) throw unavailable();
        receipt = observed;
      }
      if (!receipt) return { status: 'unknown' };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) throw unavailable();
        const replay = await settled(client, accountId, operationId);
        if (replay) {
          await client.query('COMMIT');
          return { status: 'confirmed', snapshot: replay.response_snapshot };
        }
        const operation = (await client.query(`SELECT * FROM alpha_cooper_level_up_operations
          WHERE id = $1 AND account_id = $2 FOR UPDATE`, [operationId, accountId])).rows[0];
        const prepared = await readPreparedCooperEru(client, accountId, operationId, cluster);
        const issuance = (await client.query(`SELECT * FROM alpha_cooper_level_eru_issuances
          WHERE operation_id = $1 AND account_id = $2 FOR UPDATE`,
        [operationId, accountId])).rows[0];
        if (!operation || operation.response_snapshot || !issuance ||
            issuance.intent_digest !== receipt.intentDigest ||
            issuance.reservation_id !== prepared.reservation_id ||
            issuance.wallet_address !== prepared.wallet_address ||
            !(await client.query(`SELECT 1 FROM alpha_cooper_level_eru_submissions
              WHERE operation_id = $1 AND account_id = $2 AND signature = $3`,
            [operationId, accountId, receipt.signature])).rowCount) throw unavailable();
        const ring = (await client.query(`SELECT * FROM alpha_cooper_current_state
          WHERE account_id = $1 AND ring_id = $2 FOR UPDATE`,
        [accountId, prepared.ring_id])).rows[0];
        if (!ring || ring.level !== prepared.expected_level ||
            ring.unspent_attribute_points !== prepared.unspent_points_before ||
            ring.unspent_attribute_points + 4 > 76) throw unavailable();
        const ertAccount = (await client.query(`SELECT account_id FROM alpha_ert_accounts
          WHERE account_id = $1 FOR UPDATE`, [accountId])).rows[0];
        if (!ertAccount) throw unavailable();
        const before = (await client.query(`SELECT balance::text, available::text
          FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
        if (!before || new ErtDecimal(before.balance).lessThan(prepared.ert_cost))
          throw unavailable();
        const ledgerId = randomUUID();
        await client.query(`INSERT INTO alpha_cooper_level_eru_settlements
          (operation_id, account_id, hybrid_operation_id, reservation_id, signature,
           finalized_slot, intent_digest, transaction_digest, operation_replay_digest,
           ledger_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [operationId, accountId, prepared.hybrid_operation_id, prepared.reservation_id,
          receipt.signature, receipt.slot, receipt.intentDigest,
          receipt.transactionDigest, receipt.operationReplayDigest, ledgerId]);
        await client.query(`UPDATE alpha_cooper_level_eru_preparations
          SET status = 'confirmed' WHERE operation_id = $1`, [operationId]);
        await client.query(`UPDATE alpha_ert_reservations SET state = 'consumed'
          WHERE id = $1 AND state = 'held'`, [prepared.reservation_id]);
        await client.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
          VALUES ($1,$2,$3,$4::numeric)`, [ledgerId, accountId,
          `cooper-level-up:${operationId}`, `-${canonicalErt(prepared.ert_cost)}`]);
        await client.query(`UPDATE alpha_cooper_current_state
          SET level = $3, unspent_attribute_points = $4, updated_at = now()
          WHERE account_id = $1 AND ring_id = $2`, [accountId, prepared.ring_id,
          prepared.target_level, ring.unspent_attribute_points + 4]);
        const after = (await client.query(`SELECT balance::text, available::text
          FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
        const snapshot = { operationId, rulesVersion: operation.rules_version,
          ringId: prepared.ring_id, idempotencyKey: operation.idempotency_key,
          level: { previous: ring.level, current: prepared.target_level },
          unspentAttributePoints: { previous: ring.unspent_attribute_points,
            granted: 4, current: ring.unspent_attribute_points + 4 },
          attributes: { comfort: ring.comfort, charm: ring.charm,
            quality: ring.quality, luck: ring.luck },
          cost: { ert: Number(prepared.ert_cost.split('.')[0]),
            ertExact: canonicalErt(prepared.ert_cost),
            ertDisplay: displayErt(prepared.ert_cost),
            eru: Number(prepared.eru_principal.split('.')[0]),
            eruExact: canonicalErt(prepared.eru_principal),
            eruFeeExact: canonicalErt(prepared.eru_fee) },
          balances: { ertBeforeExact: canonicalErt(before.balance),
            ertAfterExact: canonicalErt(after.balance),
            ertAvailableBeforeExact: canonicalErt(before.available),
            ertAvailableAfterExact: canonicalErt(after.available),
            eruBeforeExact: null, eruAfterExact: null },
          ledgerTransactionId: ledgerId,
          ledgerTransactionIds: { ert: ledgerId, eru: null },
          chainTransactionSignature: receipt.signature };
        await client.query(`INSERT INTO alpha_cooper_level_up_events
          (id,account_id,ring_id,operation_id,ledger_id,event_type,operation_key,
           rules_version,snapshot)
          VALUES ($1,$2,$3,$4,$5,'LEVEL_UP',$6,$7,$8::jsonb)`,
        [randomUUID(), accountId, prepared.ring_id, operationId, ledgerId,
          `level-up:${operationId}`, operation.rules_version, JSON.stringify(snapshot)]);
        await client.query(`UPDATE alpha_cooper_level_up_operations
          SET response_snapshot = $2::jsonb, completed_at = now() WHERE id = $1`,
        [operationId, JSON.stringify(snapshot)]);
        await client.query(`UPDATE alpha_hybrid_operations SET status = 'confirmed'
          WHERE id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`UPDATE alpha_hybrid_outbox SET state = 'done'
          WHERE operation_id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`INSERT INTO alpha_hybrid_inbox
          (source,event_key,operation_id,payload_digest,state)
          VALUES ($1,$2,$3,$4,'verified')`, [cluster, receipt.signature,
          prepared.hybrid_operation_id, receipt.transactionDigest]);
        await client.query('COMMIT');
        return { status: 'confirmed', snapshot };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },
  };
}
