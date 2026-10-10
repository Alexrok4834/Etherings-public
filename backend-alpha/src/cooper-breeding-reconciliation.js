import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { ErtDecimal, canonicalErt } from './m2e-ert-decimal.js';
import { readPreparedCooperBreeding } from './cooper-breeding-candidate-reader.js';

const unavailable = () => new Error('Cooper breeding reconciliation unavailable');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createCooperBreedingReconciliation({ pool, finalityReader }) {
  if (typeof pool?.connect !== 'function' ||
      typeof finalityReader?.verify !== 'function') throw unavailable();
  const identity = (accountId, operationId) => {
    if (!UUID.test(accountId ?? '') || !UUID.test(operationId ?? ''))
      throw unavailable();
  };
  const settled = async (client, accountId, operationId) =>
    (await client.query(`SELECT s.signature, s.box_mint, s.finalized_slot
      FROM alpha_cooper_breeding_settlements s
      WHERE s.account_id = $1 AND s.operation_id = $2`,
    [accountId, operationId])).rows[0];
  return {
    async recordSubmission(accountId, operationId, signature) {
      identity(accountId, operationId);
      if (typeof signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
          bs58.decode(signature).length !== 64) throw unavailable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!account || await settled(client, accountId, operationId)) throw unavailable();
        await readPreparedCooperBreeding(client, accountId, operationId);
        const issuance = (await client.query(`SELECT operation_id FROM
          alpha_cooper_breeding_issuances WHERE operation_id = $1 AND account_id = $2`,
        [operationId, accountId])).rows[0];
        if (!issuance) throw unavailable();
        const inserted = await client.query(`INSERT INTO alpha_cooper_breeding_submissions
          (signature,operation_id,account_id) VALUES ($1,$2,$3)
          ON CONFLICT (signature) DO NOTHING`, [signature, operationId, accountId]);
        const stored = (await client.query(`SELECT operation_id,account_id FROM
          alpha_cooper_breeding_submissions WHERE signature = $1`, [signature])).rows[0];
        if (stored?.operation_id !== operationId || stored.account_id !== accountId)
          throw unavailable();
        await client.query('COMMIT');
        return { status: 'unknown', signature, replay: inserted.rowCount === 0 };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },
    async reconcile(accountId, operationId) {
      identity(accountId, operationId);
      const prior = await settled(pool, accountId, operationId);
      if (prior) return { status: 'confirmed', signature: prior.signature,
        boxMint: prior.box_mint, finalizedSlot: Number(prior.finalized_slot) };
      const submissions = (await pool.query(`SELECT signature FROM
        alpha_cooper_breeding_submissions WHERE account_id = $1 AND operation_id = $2
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
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!account) throw unavailable();
        const replay = await settled(client, accountId, operationId);
        if (replay) {
          await client.query('COMMIT');
          return { status: 'confirmed', signature: replay.signature,
            boxMint: replay.box_mint, finalizedSlot: Number(replay.finalized_slot) };
        }
        const prepared = await readPreparedCooperBreeding(client, accountId, operationId);
        const issuance = (await client.query(`SELECT * FROM alpha_cooper_breeding_issuances
          WHERE operation_id = $1 AND account_id = $2 FOR UPDATE`,
        [operationId, accountId])).rows[0];
        if (!issuance || issuance.intent_digest !== receipt.intentDigest ||
            issuance.reservation_id !== prepared.reservation_id ||
            issuance.wallet_address !== prepared.wallet_address ||
            !(await client.query(`SELECT 1 FROM alpha_cooper_breeding_submissions
              WHERE operation_id = $1 AND account_id = $2 AND signature = $3`,
            [operationId, accountId, receipt.signature])).rowCount) throw unavailable();
        const parents = (await client.query(`SELECT ring_id::text, level, breeding_uses
          FROM alpha_cooper_current_state WHERE account_id = $1
            AND ring_id = ANY($2::uuid[]) ORDER BY ring_id FOR UPDATE`,
        [accountId, [prepared.first_ring_id, prepared.second_ring_id]])).rows;
        if (parents.length !== 2 || parents.some(row => row.level !== 20) ||
            parents.find(row => row.ring_id === prepared.first_ring_id)?.breeding_uses !==
              prepared.first_uses ||
            parents.find(row => row.ring_id === prepared.second_ring_id)?.breeding_uses !==
              prepared.second_uses) throw unavailable();
        const ertAccount = (await client.query(`SELECT account_id FROM alpha_ert_accounts
          WHERE account_id = $1 FOR UPDATE`, [accountId])).rows[0];
        const before = (await client.query(`SELECT balance::text FROM alpha_ert_available
          WHERE account_id = $1`, [accountId])).rows[0];
        if (!ertAccount || !before ||
            new ErtDecimal(before.balance).lessThan(prepared.ert_cost)) throw unavailable();
        const ledgerId = randomUUID();
        await client.query(`INSERT INTO alpha_cooper_breeding_settlements
          (operation_id,account_id,signature,finalized_slot,transaction_digest,
           operation_replay_digest,box_mint,ledger_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [operationId, accountId, receipt.signature, receipt.slot,
          receipt.transactionDigest, receipt.operationReplayDigest,
          receipt.boxMint, ledgerId]);
        await client.query(`UPDATE alpha_ert_reservations SET state = 'consumed'
          WHERE id = $1 AND state = 'held'`, [prepared.reservation_id]);
        await client.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
          VALUES ($1,$2,$3,$4::numeric)`,
        [ledgerId, accountId, `cooper-breeding:${operationId}`,
          `-${canonicalErt(prepared.ert_cost)}`]);
        for (const id of [prepared.first_ring_id, prepared.second_ring_id]) {
          await client.query(`UPDATE alpha_cooper_current_state
            SET breeding_uses = breeding_uses + 1, updated_at = now()
            WHERE account_id = $1 AND ring_id = $2`, [accountId, id]);
        }
        await client.query(`UPDATE alpha_cooper_breeding_parent_holds
          SET released_at = now() WHERE operation_id = $1 AND released_at IS NULL`,
        [operationId]);
        await client.query(`UPDATE alpha_hybrid_operations SET status = 'confirmed'
          WHERE id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`UPDATE alpha_hybrid_outbox SET state = 'done'
          WHERE operation_id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`INSERT INTO alpha_hybrid_inbox
          (source,event_key,operation_id,payload_digest,state)
          VALUES ('devnet',$1,$2,$3,'verified')`,
        [receipt.signature, prepared.hybrid_operation_id, receipt.transactionDigest]);
        await client.query('COMMIT');
        return { status: 'confirmed', signature: receipt.signature,
          boxMint: receipt.boxMint, finalizedSlot: receipt.slot };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },
  };
}
