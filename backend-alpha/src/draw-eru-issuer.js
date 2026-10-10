// The result and ERT debit are durable before this worker acts. One signed
// grant+claim transaction is recorded before broadcast and always reconciled
// against the saved result; an ambiguous send never chooses a new reward.
export function createDrawEruIssuer({ pool, chain }) {
  if (!pool || typeof chain?.build !== 'function' ||
      typeof chain?.readFinalized !== 'function')
    throw new Error('Draw ERU issuer requires canonical chain runtime');

  const rows = async () => (await pool.query(`SELECT r.id AS result_id,
    r.account_id, r.selected_reward_type, r.result_snapshot,
    o.id AS operation_id, o.wallet_address, f.state AS fulfillment_state
    FROM alpha_draw_results r
    JOIN alpha_draw_operations o ON o.id = r.operation_id
    JOIN alpha_draw_fulfillments f ON f.result_id = r.id
    JOIN alpha_wallet_bindings b ON b.account_id = r.account_id
      AND b.wallet_address = o.wallet_address
    JOIN alpha_ert_ledger l ON l.account_id = r.account_id
      AND l.event_key = 'draw-entry:' || o.id::text AND l.amount = -5
    WHERE r.selected_reward_type = 'ERU' AND f.state IN ('PENDING','UNKNOWN')
    ORDER BY r.created_at LIMIT 20`)).rows;
  const latest = async id => (await pool.query(`SELECT * FROM alpha_draw_chain_attempts
    WHERE result_id = $1 AND leg = 'ERU_CLAIM'
    ORDER BY attempt DESC LIMIT 1`, [id])).rows[0] ?? null;
  function bound(row) {
    const snapshot = row.result_snapshot;
    if (row.selected_reward_type !== 'ERU' ||
        snapshot?.operation?.operationId !== row.operation_id ||
        snapshot?.draw?.drawResultId !== row.result_id ||
        snapshot?.draw?.cost?.amountExact !== '5' ||
        snapshot?.reward?.type !== 'ERU' ||
        snapshot?.reward?.amountExact !== '5' ||
        snapshot?.fulfillment?.type !== 'ERU_PAYOUT')
      throw new Error('Draw ERU result binding mismatch');
    return row;
  }
  async function confirm(row, attempt) {
    const settled = await chain.readFinalized(row.account_id, row.result_id,
      row.wallet_address, attempt.signature);
    if (!settled || settled.signature !== attempt.signature ||
        settled.amountBaseUnits !== '5000000000')
      throw new Error('Draw ERU finalized payout mismatch');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE alpha_draw_chain_attempts
        SET state = 'CONFIRMED', settled_at = now()
        WHERE result_id = $1 AND leg = 'ERU_CLAIM' AND attempt = $2
          AND signature = $3 AND state = 'UNKNOWN'`,
      [row.result_id, attempt.attempt, attempt.signature]);
      await client.query(`UPDATE alpha_draw_fulfillments
        SET state = 'CONFIRMED', chain_signature = $2,
          chain_asset_address = $3, updated_at = now()
        WHERE result_id = $1 AND reward_type = 'ERU'
          AND state IN ('PENDING','UNKNOWN')`,
      [row.result_id, attempt.signature, settled.destination]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return { async tick() {
    const summary = { pending: 0, unknown: 0, confirmed: 0, failed: 0 };
    for (const raw of await rows()) {
      const row = bound(raw);
      let attempt = await latest(row.result_id);
      if (attempt?.state === 'UNKNOWN') {
        const status = await chain.status(attempt.signature);
        if (status?.confirmationStatus === 'finalized') {
          if (status.err === null) {
            await confirm(row, attempt);
            summary.confirmed++;
            continue;
          }
          await pool.query(`UPDATE alpha_draw_chain_attempts
            SET state = 'FAILED', settled_at = now()
            WHERE result_id = $1 AND leg = 'ERU_CLAIM' AND attempt = $2
              AND state = 'UNKNOWN'`, [row.result_id, attempt.attempt]);
          summary.failed++;
          continue;
        }
        if (status?.err) throw new Error('Draw ERU ambiguous signature status');
        if (await chain.blockHeight() <= Number(attempt.last_valid_block_height) + 32) {
          try { await chain.send(attempt); } catch { /* durable UNKNOWN */ }
          summary.unknown++;
          continue;
        }
        await pool.query(`UPDATE alpha_draw_chain_attempts
          SET state = 'EXPIRED', settled_at = now()
          WHERE result_id = $1 AND leg = 'ERU_CLAIM' AND attempt = $2
            AND state = 'UNKNOWN'`, [row.result_id, attempt.attempt]);
        attempt = await latest(row.result_id);
      }
      if (attempt?.state === 'FAILED') { summary.failed++; continue; }
      const signed = await chain.build({ accountId: row.account_id,
        resultId: row.result_id, wallet: row.wallet_address });
      await pool.query(`INSERT INTO alpha_draw_chain_attempts
        (result_id, leg, attempt, signature, raw_transaction_base64,
         blockhash, last_valid_block_height)
        VALUES ($1,'ERU_CLAIM',$2,$3,$4,$5,$6)`,
      [row.result_id, (attempt?.attempt ?? 0) + 1,
        signed.signature, signed.rawTransactionBase64,
        signed.blockhash, signed.lastValidBlockHeight]);
      const stored = await latest(row.result_id);
      try { await chain.send(stored); } catch { /* durable UNKNOWN */ }
      await pool.query(`UPDATE alpha_draw_fulfillments SET state = 'UNKNOWN', updated_at = now()
        WHERE result_id = $1 AND reward_type = 'ERU' AND state = 'PENDING'`,
      [row.result_id]);
      summary.unknown++;
    }
    return summary;
  } };
}
