import { drawBoxIdentity } from './draw-box-identity.js';
import { BOX_HASH, BOX_URI } from './silver-issuer-chain.js';

// Reuses the canonical Silver issuer signer/builder and finalized reader. The
// persisted Draw result determines one mint PDA; attempts are stored before send.
export function createDrawBoxIssuer({ pool, chain, reader, programId }) {
  if (!pool || typeof chain?.build !== 'function' ||
      typeof reader?.readFinalized !== 'function' || !programId)
    throw new Error('Draw Box issuer requires canonical Silver runtime');

  const rows = async () => (await pool.query(`SELECT r.id AS draw_result_id,
    r.account_id, r.selected_reward_type, r.result_snapshot,
    o.id AS operation_id, o.wallet_address, o.utc_day,
    f.state AS fulfillment_state
    FROM alpha_draw_results r
    JOIN alpha_draw_operations o ON o.id = r.operation_id
    JOIN alpha_draw_fulfillments f ON f.result_id = r.id
    JOIN alpha_wallet_bindings b ON b.account_id = r.account_id
      AND b.wallet_address = o.wallet_address
    JOIN alpha_ert_ledger l ON l.account_id = r.account_id
      AND l.event_key = 'draw-entry:' || o.id::text AND l.amount = -5
    WHERE r.selected_reward_type = 'SILVER_BOX'
      AND f.state IN ('PENDING','UNKNOWN')
    ORDER BY r.created_at LIMIT 20`)).rows;
  const latest = async id => (await pool.query(`SELECT * FROM alpha_draw_chain_attempts
    WHERE result_id = $1 AND leg = 'BOX_ISSUE'
    ORDER BY attempt DESC LIMIT 1`, [id])).rows[0] ?? null;
  const identity = row => drawBoxIdentity(row.account_id,
    row.wallet_address, row.draw_result_id);
  const bound = row => {
    const snapshot = row.result_snapshot;
    if (row.selected_reward_type !== 'SILVER_BOX' ||
        snapshot?.draw?.drawResultId !== row.draw_result_id ||
        snapshot?.operation?.operationId !== row.operation_id ||
        snapshot?.reward?.type !== 'SILVER_BOX' ||
        snapshot?.reward?.media?.uri !== BOX_URI ||
        snapshot?.reward?.media?.contentHash !== BOX_HASH ||
        snapshot?.draw?.cost?.amountExact !== '5')
      throw new Error('Draw Box result binding mismatch');
    return { ...row, ...identity(row), issuance_source: 'draw',
      status: 'pending', cluster: 'devnet' };
  };
  const state = async (row, signature = null) => reader.readFinalized({
    programId, cluster: 'devnet', issuanceId: row.issuanceId,
    walletAddress: row.wallet_address,
    expectedIssuanceSource: 'draw', expectedDrawResultId: row.draw_result_id,
    expectedFinalizedSignature: signature,
  });
  async function confirm(row, attempt) {
    const asset = await state(row, attempt.signature);
    if (!asset || asset.finalized !== true || asset.programId !== programId ||
        asset.cluster !== 'devnet' || asset.kind !== 'SILVER_BOX' ||
        asset.issuanceSource !== 'draw' || asset.drawResultId !== row.draw_result_id ||
        asset.accountId !== row.account_id ||
        asset.entitlementDigest !== row.entitlementDigest ||
        asset.issuanceId !== row.issuanceId ||
        asset.originalRecipient !== row.wallet_address ||
        asset.tokenOwner !== row.wallet_address || asset.lifecycle !== 'SEALED' ||
        asset.mintAddress !== attempt.mint_address ||
        asset.uri !== BOX_URI || asset.contentHash !== BOX_HASH ||
        asset.supply !== '1' || asset.tokenAmount !== '1' ||
        asset.mintAuthority !== null || asset.freezeAuthority !== null)
      return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE alpha_draw_chain_attempts
        SET state = 'CONFIRMED', settled_at = now()
        WHERE result_id = $1 AND leg = 'BOX_ISSUE' AND attempt = $2
          AND signature = $3 AND state = 'UNKNOWN'`,
      [row.draw_result_id, attempt.attempt, attempt.signature]);
      await client.query(`UPDATE alpha_draw_fulfillments
        SET state = 'CONFIRMED', chain_signature = $2,
          chain_asset_address = $3, updated_at = now()
        WHERE result_id = $1 AND reward_type = 'SILVER_BOX'
          AND state IN ('PENDING','UNKNOWN')`,
      [row.draw_result_id, attempt.signature, asset.mintAddress]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  return { async tick() {
    const summary = { pending: 0, unknown: 0, confirmed: 0, failed: 0 };
    for (const raw of await rows()) {
      const row = bound(raw);
      let attempt = await latest(row.draw_result_id);
      if (attempt?.state === 'UNKNOWN') {
        const status = await chain.status(attempt.signature);
        if (status?.confirmationStatus === 'finalized') {
          if (status.err === null && await confirm(row, attempt)) {
            summary.confirmed++;
            continue;
          }
          if (status.err === null) throw new Error('Finalized Draw Box state mismatch');
          await pool.query(`UPDATE alpha_draw_chain_attempts
            SET state = 'FAILED', settled_at = now()
            WHERE result_id = $1 AND leg = 'BOX_ISSUE' AND attempt = $2
              AND state = 'UNKNOWN'`, [row.draw_result_id, attempt.attempt]);
          summary.failed++;
          continue;
        }
        if (status?.err) throw new Error('Draw Box ambiguous signature status');
        if (await chain.blockHeight() <= Number(attempt.last_valid_block_height) + 32) {
          try { await chain.send(attempt); } catch { /* durable UNKNOWN */ }
          summary.unknown++;
          continue;
        }
        if (await state(row)) throw new Error('Draw Box state exists without finalized attempt');
        await pool.query(`UPDATE alpha_draw_chain_attempts
          SET state = 'EXPIRED', settled_at = now()
          WHERE result_id = $1 AND leg = 'BOX_ISSUE' AND attempt = $2
            AND state = 'UNKNOWN'`, [row.draw_result_id, attempt.attempt]);
        attempt = await latest(row.draw_result_id);
      }
      if (attempt?.state === 'FAILED') { summary.failed++; continue; }
      if (await state(row)) throw new Error('Draw Box exists without confirmed attempt');
      const signed = await chain.build({ account_id: row.account_id,
        wallet_address: row.wallet_address, draw_result_id: row.draw_result_id,
        issuance_source: 'draw', issuance_id: row.issuanceId,
        entitlement_digest: row.entitlementDigest,
        status: 'pending', cluster: 'devnet' });
      if (signed.issuerAddress !== chain.issuerAddress)
        throw new Error('Draw Box signer mismatch');
      await pool.query(`INSERT INTO alpha_draw_chain_attempts
        (result_id, leg, attempt, signature, raw_transaction_base64,
         blockhash, last_valid_block_height, mint_address)
        VALUES ($1,'BOX_ISSUE',$2,$3,$4,$5,$6,$7)`,
      [row.draw_result_id, (attempt?.attempt ?? 0) + 1,
        signed.signature, signed.rawTransactionBase64, signed.blockhash,
        signed.lastValidBlockHeight, signed.mintAddress]);
      const stored = await latest(row.draw_result_id);
      try { await chain.send(stored); } catch { /* durable UNKNOWN */ }
      await pool.query(`UPDATE alpha_draw_fulfillments SET state = 'UNKNOWN', updated_at = now()
        WHERE result_id = $1 AND state = 'PENDING'`, [row.draw_result_id]);
      summary.unknown++;
    }
    return summary;
  } };
}
