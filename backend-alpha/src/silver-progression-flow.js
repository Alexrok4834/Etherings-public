import { createPublicKey, randomUUID, verify } from 'node:crypto';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { canonicalErt, ErtDecimal } from './m2e-ert-decimal.js';
import { sameSilverProgressionIntent,
  verifySilverProgressionCandidateMessage } from './silver-progression-intent.js';
import { readPreparedSilver } from './silver-progression-read.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const unavailable = () => new Error('Silver progression unavailable');
const signature = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw unavailable();
  return bytes;
};
const signed = (message, bytes, owner) => {
  const key = Buffer.from(bs58.decode(owner));
  return key.length === 32 && verify(null, message, createPublicKey({
    key: Buffer.concat([SPKI, key]), format: 'der', type: 'spki',
  }), bytes);
};
const identity = (accountId, operationId) => {
  if (!UUID.test(accountId ?? '') || !UUID.test(operationId ?? '')) throw unavailable();
};

export function createSilverProgressionFlow({ pool, signer, finality, programId }) {
  if (typeof pool?.connect !== 'function' ||
      typeof signer?.signGuardedProgression !== 'function' ||
      typeof signer?.isBlockhashValid !== 'function' ||
      typeof signer?.send !== 'function' || typeof finality?.verify !== 'function' ||
      typeof programId !== 'string')
    throw unavailable();
  const settled = async (db, accountId, operationId) =>
    (await db.query(`SELECT o.response_snapshot FROM alpha_silver_progression_operations o
      JOIN alpha_silver_progression_settlements s ON s.operation_id = o.id
      WHERE o.account_id = $1 AND o.id = $2`, [accountId, operationId])).rows[0];
  const review = async (accountId, operationId, approvedCandidate = null) => {
    identity(accountId, operationId);
    const result = await signer.signGuardedProgression(accountId, operationId, approvedCandidate);
    const eruExact = result.candidate.targetLevel === 5 ? '38.76' :
      result.candidate.targetLevel === 20 ? '76.50' : '0';
    return { ...result, terms: { operationId, reservationId: result.candidate.reservationId,
      mintAddress: result.candidate.mintAddress,
      walletAddress: result.candidate.walletAddress,
      currentLevel: result.candidate.currentLevel,
      targetLevel: result.candidate.targetLevel,
      ertExact: result.candidate.ertCost, eruExact, pointsGranted: 6 } };
  };
  return {
    review,
    async refresh(accountId, operationId, approved) {
      identity(accountId, operationId);
      if (approved?.candidate?.operationId !== operationId) throw unavailable();
      const current = await review(accountId, operationId, approved.candidate);
      if (!sameSilverProgressionIntent(approved.candidate, current.candidate) ||
          JSON.stringify(approved.terms) !== JSON.stringify(current.terms))
        throw unavailable();
      return current;
    },
    async submit(accountId, operationId, refreshed, userSignatureBase64) {
      identity(accountId, operationId);
      if (refreshed?.candidate?.operationId !== operationId) throw unavailable();
      const candidate = refreshed.candidate;
      const preparation = await readPreparedSilver(pool, accountId, operationId);
      if (candidate.issuerAddress !== signer.issuerAddress ||
          !await verifySilverProgressionCandidateMessage(candidate, preparation, programId))
        throw unavailable();
      const message = Buffer.from(candidate.messageBase64, 'base64');
      const userSignature = signature(userSignatureBase64);
      const issuerSignature = signature(refreshed.issuerSignatureBase64);
      if (!signed(message, userSignature, candidate.walletAddress) ||
          !signed(message, issuerSignature, candidate.issuerAddress)) throw unavailable();
      const current = await review(accountId, operationId, candidate);
      if (!sameSilverProgressionIntent(candidate, current.candidate) ||
          JSON.stringify(refreshed.terms) !== JSON.stringify(current.terms))
        throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (!await signer.isBlockhashValid(decoded.lifetimeToken)) throw unavailable();
      const raw = Buffer.concat([Buffer.from([2]), userSignature, issuerSignature, message]);
      if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
      const sig = bs58.encode(userSignature);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) throw unavailable();
        await readPreparedSilver(client, accountId, operationId);
        await client.query(`INSERT INTO alpha_silver_progression_submissions
          (signature, operation_id, account_id, message_base64, issuer_signature_base64,
           intent_digest,gateway_config_base64) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (signature) DO NOTHING`, [sig, operationId, accountId,
          candidate.messageBase64, refreshed.issuerSignatureBase64, candidate.intentDigest,
          candidate.gatewayConfigBase64 ?? null]);
        const stored = (await client.query(`SELECT operation_id, account_id, message_base64,
          issuer_signature_base64, intent_digest, gateway_config_base64
          FROM alpha_silver_progression_submissions
          WHERE signature = $1`, [sig])).rows[0];
        if (stored?.operation_id !== operationId || stored.account_id !== accountId ||
            stored.message_base64 !== candidate.messageBase64 ||
            stored.issuer_signature_base64 !== refreshed.issuerSignatureBase64 ||
            stored.intent_digest !== candidate.intentDigest ||
            stored.gateway_config_base64 !== (candidate.gatewayConfigBase64 ?? null))
          throw unavailable();
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
      try {
        const sent = await signer.send({ raw_transaction_base64: raw.toString('base64') });
        if (sent !== sig) throw unavailable();
      } catch { /* Durable signature remains UNKNOWN for finality reconciliation. */ }
      return { status: 'unknown', signature: sig };
    },
    async status(accountId, operationId) {
      identity(accountId, operationId);
      const prior = await settled(pool, accountId, operationId);
      if (prior) return { status: 'confirmed', snapshot: prior.response_snapshot };
      const rows = (await pool.query(`SELECT signature FROM alpha_silver_progression_submissions
        WHERE account_id = $1 AND operation_id = $2 ORDER BY recorded_at, signature`,
      [accountId, operationId])).rows;
      if (!rows.length) return { status: 'unknown' };
      let receipt = null;
      for (const row of rows) {
        const observed = await finality.verify(accountId, operationId, row.signature);
        if (observed.status === 'unknown') continue;
        if (observed.status !== 'verified' || receipt ||
            observed.accountId !== accountId || observed.operationId !== operationId ||
            observed.signature !== row.signature ||
            !Number.isSafeInteger(observed.slot) || observed.slot < 1 ||
            ['intentDigest', 'transactionDigest', 'replayDigest'].some(key =>
              !/^[a-f0-9]{64}$/.test(observed[key] ?? ''))) throw unavailable();
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
        const prepared = await readPreparedSilver(client, accountId, operationId);
        const account = (await client.query(`SELECT account_id FROM alpha_ert_accounts
          WHERE account_id = $1 FOR UPDATE`, [accountId])).rows[0];
        if (!account) throw unavailable();
        const before = (await client.query(`SELECT balance::text, available::text
          FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
        if (!before || new ErtDecimal(before.balance).lessThan(prepared.ert_cost))
          throw unavailable();
        const ledgerId = randomUUID();
        await client.query(`INSERT INTO alpha_silver_progression_settlements
          (operation_id,account_id,hybrid_operation_id,reservation_id,signature,
           finalized_slot,intent_digest,transaction_digest,replay_digest,ledger_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [operationId, accountId, prepared.hybrid_operation_id, prepared.reservation_id,
          receipt.signature, receipt.slot, receipt.intentDigest,
          receipt.transactionDigest, receipt.replayDigest, ledgerId]);
        await client.query(`UPDATE alpha_ert_reservations SET state = 'consumed'
          WHERE id = $1 AND state = 'held'`, [prepared.reservation_id]);
        await client.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
          VALUES ($1,$2,$3,$4::numeric)`, [ledgerId, accountId,
          `silver-level-up:${operationId}`, `-${canonicalErt(prepared.ert_cost)}`]);
        const after = (await client.query(`SELECT balance::text, available::text
          FROM alpha_ert_available WHERE account_id = $1`, [accountId])).rows[0];
        const snapshot = { operationId, mintAddress: prepared.mint_address,
          level: { previous: prepared.expected_level, current: prepared.target_level },
          pointsGranted: 6, cost: { ertExact: canonicalErt(prepared.ert_cost),
            eruExact: prepared.target_level === 5 ? '38.76' :
              prepared.target_level === 20 ? '76.50' : '0' },
          balances: { ertBeforeExact: canonicalErt(before.balance),
            ertAfterExact: canonicalErt(after.balance),
            ertAvailableBeforeExact: canonicalErt(before.available),
            ertAvailableAfterExact: canonicalErt(after.available) },
          ledgerTransactionId: ledgerId, chainTransactionSignature: receipt.signature };
        await client.query(`UPDATE alpha_silver_progression_operations
          SET status = 'confirmed', response_snapshot = $2::jsonb, completed_at = now()
          WHERE id = $1`, [operationId, JSON.stringify(snapshot)]);
        await client.query(`UPDATE alpha_hybrid_operations SET status = 'confirmed'
          WHERE id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`UPDATE alpha_hybrid_outbox SET state = 'done'
          WHERE operation_id = $1`, [prepared.hybrid_operation_id]);
        await client.query(`INSERT INTO alpha_hybrid_inbox
          (source,event_key,operation_id,payload_digest,state)
          VALUES ('devnet',$1,$2,$3,'verified')`, [receipt.signature,
          prepared.hybrid_operation_id, receipt.transactionDigest]);
        await client.query('COMMIT');
        return { status: 'confirmed', snapshot };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },
  };
}
