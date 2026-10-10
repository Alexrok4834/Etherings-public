import { drawBoxIdentity } from './draw-box-identity.js';
import { adminBoxIdentity } from './admin-box-identity.js';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export function createSilverKeeper({ pool, chain, programId, breedingEnabled = false }) {
  if (!pool || !chain || !programId) throw new Error('Silver keeper configuration missing');

  const rows = async () => (await pool.query(`SELECT c.*, e.issuance_id::text AS issuance_id,
      NULL::uuid AS draw_result_id, NULL::uuid AS admin_operation_id,
      NULL::text AS admin_entitlement_digest
    FROM alpha_silver_opening_candidate_intents c
    JOIN alpha_silver_opening_submissions s USING
      (cluster, genesis_hash, program_id, mint_address)
    JOIN alpha_silver_first_entry e ON e.account_id = c.account_id
      AND e.cluster = c.cluster AND e.wallet_address = c.wallet_address
      AND e.mint_address = c.mint_address AND e.status = 'confirmed'
    WHERE c.cluster = 'devnet' AND c.genesis_hash = $1 AND c.program_id = $2
      AND s.status = 'confirmed'
    UNION ALL
    SELECT c.*, NULL::text AS issuance_id, r.id AS draw_result_id,
      NULL::uuid AS admin_operation_id, NULL::text AS admin_entitlement_digest
    FROM alpha_silver_opening_candidate_intents c
    JOIN alpha_silver_opening_submissions s USING
      (cluster, genesis_hash, program_id, mint_address)
    JOIN alpha_draw_fulfillments f ON f.chain_asset_address = c.mint_address
      AND f.state = 'CONFIRMED' AND f.reward_type = 'SILVER_BOX'
    JOIN alpha_draw_results r ON r.id = f.result_id
      AND r.account_id = c.account_id AND r.selected_reward_type = 'SILVER_BOX'
    JOIN alpha_draw_operations o ON o.id = r.operation_id
      AND o.wallet_address = c.wallet_address
    JOIN alpha_ert_ledger l ON l.account_id = c.account_id
      AND l.event_key = 'draw-entry:' || o.id::text AND l.amount = -5
    WHERE c.cluster = 'devnet' AND c.genesis_hash = $1 AND c.program_id = $2
      AND s.status = 'confirmed'
    ${breedingEnabled ? `UNION ALL
    SELECT c.*, o.issuance_id::text, NULL::uuid AS draw_result_id,
      NULL::uuid AS admin_operation_id, NULL::text AS admin_entitlement_digest
    FROM alpha_silver_opening_candidate_intents c
    JOIN alpha_silver_opening_submissions s USING
      (cluster, genesis_hash, program_id, mint_address)
    JOIN alpha_cooper_breeding_settlements b ON b.box_mint = c.mint_address
      AND b.account_id = c.account_id
    JOIN alpha_cooper_breeding_operations o ON o.id = b.operation_id
      AND o.wallet_address = c.wallet_address AND o.cluster = c.cluster
    WHERE c.cluster = 'devnet' AND c.genesis_hash = $1 AND c.program_id = $2
      AND s.status = 'confirmed'` : ''}
    UNION ALL
    SELECT c.*, g.issuance_id::text, NULL::uuid AS draw_result_id,
      g.id AS admin_operation_id, g.entitlement_digest::text AS admin_entitlement_digest
    FROM alpha_silver_opening_candidate_intents c
    JOIN alpha_silver_opening_submissions s USING
      (cluster, genesis_hash, program_id, mint_address)
    JOIN alpha_admin_box_grants g ON g.mint_address = c.mint_address
      AND g.account_id = c.account_id AND g.wallet_address = c.wallet_address
      AND g.state = 'CONFIRMED'
    WHERE c.cluster = 'devnet' AND c.genesis_hash = $1 AND c.program_id = $2
      AND s.status = 'confirmed'
    ORDER BY created_at`, [DEVNET_GENESIS, programId])).rows;

  const stored = async row => (await pool.query(`SELECT * FROM alpha_silver_opening_finalizations
    WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3 AND mint_address = $4`,
  [row.cluster, row.genesis_hash, row.program_id, row.mint_address])).rows[0];

  const reconcile = async (row, finalization) => {
    if (finalization.status !== 'unknown') return finalization.status;
    const status = await chain.signatureStatus(finalization.signature);
    if (status?.confirmationStatus === 'finalized') {
      const tx = await chain.transaction(finalization.signature);
      if (!tx || (status.err === null) !== (tx.meta?.err === null) ||
          !chain.matchesTransaction(finalization, tx)) return 'unknown';
      const state = await chain.inspect(row);
      if (status.err === null &&
          (state.phase !== 'consumed' ||
            !await chain.verifyRing(row, finalization, tx))) return 'unknown';
      if (status.err !== null && state.phase !== 'opening') return 'unknown';
      const next = status.err === null ? 'confirmed' : 'failed';
      await pool.query(`UPDATE alpha_silver_opening_finalizations
        SET status = $5, settled_at = now()
        WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3 AND mint_address = $4
          AND signature = $6 AND status = 'unknown'`,
      [row.cluster, row.genesis_hash, row.program_id, row.mint_address,
        next, finalization.signature]);
      return next;
    }
    if (status?.err || await chain.blockHeight() > Number(finalization.last_valid_block_height) ||
        !await chain.blockhashValid(finalization.blockhash)) return 'unknown';
    try { await chain.send(finalization); } catch { /* Keep the durable signed outcome UNKNOWN. */ }
    return 'unknown';
  };

  return {
    async tick() {
      const summary = { pending: 0, consumed: 0, unknown: 0, confirmed: 0, failed: 0 };
      for (const row of await rows()) {
        if (row.draw_result_id) {
          row.issuance_id = drawBoxIdentity(row.account_id, row.wallet_address,
            row.draw_result_id).issuanceId;
        }
        if (row.admin_operation_id) {
          const expected = adminBoxIdentity(row.account_id, row.wallet_address,
            row.admin_operation_id);
          if (row.issuance_id !== expected.issuanceId ||
              row.admin_entitlement_digest !== expected.entitlementDigest)
            throw new Error('Silver keeper admin Box binding mismatch');
        }
        let finalization = await stored(row);
        // A confirmed Ring may have changed owners since finalization. Its durable
        // proof was checked on settlement; owner-scoped inspection is only valid
        // while an opening is still in progress.
        if (finalization?.status === 'confirmed') {
          if (finalization.account_id !== row.account_id ||
              finalization.wallet_address !== row.wallet_address ||
              finalization.payer_address !== chain.payerAddress)
            throw new Error('Silver keeper durable binding mismatch');
          summary.confirmed++;
          continue;
        }
        const state = await chain.inspect(row);
        if (finalization) {
          if (finalization.account_id !== row.account_id ||
              finalization.wallet_address !== row.wallet_address ||
              finalization.operation_address !== state.operation ||
              finalization.request_address !== state.request ||
              finalization.ring_mint_address !== state.ringMint ||
              finalization.payer_address !== chain.payerAddress)
            throw new Error('Silver keeper durable binding mismatch');
          summary[await reconcile(row, finalization)]++;
          continue;
        }
        if (state.phase === 'consumed') { summary.consumed++; continue; }
        if (state.phase !== 'opening') throw new Error('Silver keeper unexpected chain phase');
        if (!state.fulfilled) { summary.pending++; continue; }
        const signed = await chain.build(row, state);
        if (!signed.simulationPassed || signed.operation !== state.operation ||
            signed.request !== state.request || signed.ringMint !== state.ringMint ||
            signed.payer !== chain.payerAddress)
          throw new Error('Silver keeper unsigned or mismatched transaction');
        await pool.query(`INSERT INTO alpha_silver_opening_finalizations
          (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
           operation_address,request_address,ring_mint_address,payer_address,
           message_base64,blockhash,last_valid_block_height,signature)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (cluster,genesis_hash,program_id,mint_address) DO NOTHING`,
        [row.cluster, row.genesis_hash, row.program_id, row.mint_address,
          row.account_id, row.wallet_address, signed.operation, signed.request,
          signed.ringMint, signed.payer, signed.messageBase64, signed.blockhash,
          signed.lastValidBlockHeight, signed.signature]);
        finalization = await stored(row);
        if (!finalization || finalization.account_id !== row.account_id ||
            finalization.wallet_address !== row.wallet_address ||
            finalization.operation_address !== state.operation ||
            finalization.request_address !== state.request ||
            finalization.ring_mint_address !== state.ringMint ||
            finalization.payer_address !== chain.payerAddress)
          throw new Error('Silver keeper insert race binding mismatch');
        summary[await reconcile(row, finalization)]++;
      }
      return summary;
    },
  };
}
