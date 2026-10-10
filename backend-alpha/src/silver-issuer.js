import { firstEntryIdentity } from './silver-first-entry.js';

const BOX_URI = 'ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png';
const BOX_HASH = 'e86589ee25bcaa5c2a5dc8a708adecce7955955a2529310796d5a0fe3db67d37';

export function createSilverIssuer({ pool, chain, reader, programId }) {
  if (!pool || !chain || typeof reader?.readFinalized !== 'function' || !programId)
    throw new Error('Silver issuer requires isolated Alpha DB and finalized chain reader');

  const rows = async () => (await pool.query(`SELECT e.* FROM alpha_silver_first_entry e
    JOIN alpha_accounts a ON a.id = e.account_id
    JOIN alpha_wallet_bindings b ON b.account_id = e.account_id
      AND b.wallet_address = e.wallet_address
    WHERE e.cluster = 'devnet' AND e.status IN ('pending', 'unknown')
      AND a.verified_at IS NOT NULL
    ORDER BY e.created_at LIMIT 20`)).rows;
  const latest = async row => (await pool.query(`SELECT * FROM alpha_silver_issuance_attempts
    WHERE account_id = $1 AND cluster = $2 ORDER BY attempt DESC LIMIT 1`,
  [row.account_id, row.cluster])).rows[0];
  const state = row => reader.readFinalized({ programId, cluster: 'devnet',
    issuanceId: row.issuance_id, walletAddress: row.wallet_address });

  function assertBinding(row, attempt) {
    const expected = firstEntryIdentity(row.account_id, row.wallet_address, 'devnet');
    if (row.cluster !== 'devnet' || row.issuance_id !== expected.issuanceId ||
        row.entitlement_digest !== expected.entitlementDigest ||
        (attempt && (attempt.wallet_address !== row.wallet_address ||
          attempt.issuance_id !== row.issuance_id ||
          attempt.entitlement_digest !== row.entitlement_digest ||
          attempt.issuer_address !== chain.issuerAddress)))
      throw new Error('Silver issuer durable binding mismatch');
  }

  async function confirm(row, attempt) {
    const result = await state(row);
    if (!result || result.finalized !== true || result.programId !== programId ||
        result.cluster !== 'devnet' || result.kind !== 'SILVER_BOX' ||
        result.issuanceId !== row.issuance_id ||
        result.entitlementDigest !== row.entitlement_digest ||
        result.accountId !== row.account_id ||
        result.issuanceSource !== 'first-entry' ||
        result.originalRecipient !== row.wallet_address ||
        result.tokenOwner !== row.wallet_address || result.lifecycle !== 'SEALED' ||
        result.mintAddress !== attempt.mint_address ||
        result.supply !== '1' || result.decimals !== 0 ||
        result.tokenAmount !== '1' || result.mintAuthority !== null ||
        result.freezeAuthority !== null ||
        result.uri !== BOX_URI || result.contentHash !== BOX_HASH)
      return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE alpha_silver_issuance_attempts
        SET status = 'confirmed', settled_at = now()
        WHERE account_id = $1 AND cluster = $2 AND attempt = $3
          AND signature = $4 AND status = 'unknown'`,
      [row.account_id, row.cluster, attempt.attempt, attempt.signature]);
      await client.query(`UPDATE alpha_silver_first_entry
        SET status = 'confirmed', mint_address = $3, confirmation_slot = $4,
          finalized_signature = $5, confirmed_at = now()
        WHERE account_id = $1 AND cluster = $2 AND status IN ('pending', 'unknown')
          AND issuance_id = $6 AND entitlement_digest = $7`,
      [row.account_id, row.cluster, result.mintAddress, result.issuanceSlot,
        attempt.signature, row.issuance_id, row.entitlement_digest]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  return {
    async tick() {
      const summary = { pending: 0, unknown: 0, confirmed: 0, failed: 0 };
      for (const row of await rows()) {
        let attempt = await latest(row);
        assertBinding(row, attempt);
        if (attempt?.status === 'unknown') {
          const status = await chain.status(attempt.signature);
          if (status?.confirmationStatus === 'finalized') {
            if (status.err === null && await confirm(row, attempt)) {
              summary.confirmed++;
              continue;
            }
            if (status.err === null) throw new Error('Finalized Silver issuance state mismatch');
            await pool.query(`UPDATE alpha_silver_issuance_attempts
              SET status = 'failed', settled_at = now()
              WHERE account_id = $1 AND cluster = $2 AND attempt = $3 AND status = 'unknown'`,
            [row.account_id, row.cluster, attempt.attempt]);
            summary.failed++;
            continue;
          }
          if (status?.err) throw new Error('Silver issuer ambiguous signature status');
          if (await chain.blockHeight() <= Number(attempt.last_valid_block_height) + 32) {
            try { await chain.send(attempt); } catch { /* Signed attempt remains durable UNKNOWN. */ }
            summary.unknown++;
            continue;
          }
          if (await state(row)) throw new Error('Silver state exists without finalized attempt status');
          await pool.query(`UPDATE alpha_silver_issuance_attempts
            SET status = 'expired', settled_at = now()
            WHERE account_id = $1 AND cluster = $2 AND attempt = $3 AND status = 'unknown'`,
          [row.account_id, row.cluster, attempt.attempt]);
          attempt = await latest(row);
        }
        if (await state(row)) throw new Error('Silver state exists without a confirmed attempt');
        if (attempt?.status === 'failed') { summary.failed++; continue; }
        const signed = await chain.build(row);
        if (signed.issuerAddress !== chain.issuerAddress)
          throw new Error('Silver issuer signed transaction mismatch');
        await pool.query(`INSERT INTO alpha_silver_issuance_attempts
          (account_id, cluster, attempt, wallet_address, issuance_id, entitlement_digest,
           mint_address, token_address, issuer_address, raw_transaction_base64,
           blockhash, last_valid_block_height, signature)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (account_id, cluster, attempt) DO NOTHING`,
        [row.account_id, row.cluster, (attempt?.attempt ?? 0) + 1,
          row.wallet_address, row.issuance_id, row.entitlement_digest,
          signed.mintAddress, signed.tokenAddress, signed.issuerAddress,
          signed.rawTransactionBase64, signed.blockhash,
          signed.lastValidBlockHeight, signed.signature]);
        const stored = await latest(row);
        assertBinding(row, stored);
        try { await chain.send(stored); } catch { /* Signed attempt remains durable UNKNOWN. */ }
        summary.unknown++;
      }
      return summary;
    }
  };
}
