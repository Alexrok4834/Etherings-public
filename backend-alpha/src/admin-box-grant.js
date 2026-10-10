import { adminBoxIdentity } from './admin-box-identity.js';
import { BOX_HASH, BOX_URI } from './silver-issuer-chain.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DENIED = { status: 403, body: { code: 'ADMIN_REQUIRED' } };
const BAD = { status: 400, body: { code: 'INVALID_ADMIN_BOX_GRANT' } };
const CONFLICT = { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };
const view = row => ({ operationId: row.id, accountId: row.account_id,
  walletAddress: row.wallet_address, state: row.state,
  mintAddress: row.mint_address, signature: row.confirmed_signature,
  createdAt: new Date(row.created_at).toISOString(),
  settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null });

export function createAdminBoxGrant({ pool, auth, chain, reader, programId }) {
  if (!pool?.connect || !auth?.me || !chain?.build || !chain?.send ||
      !chain?.status || !reader?.readFinalized || !programId)
    throw new Error('Admin Box requires canonical Silver runtime');
  async function admin(token) {
    const session = await auth.me(token);
    if (session.status !== 200) return { error: session };
    const row = (await pool.query(`SELECT is_admin, verified_at FROM alpha_accounts
      WHERE id = $1`, [session.body.id])).rows[0];
    return row?.is_admin && row.verified_at ? { id: session.body.id } : { error: DENIED };
  }
  async function latest(client, id) {
    return (await client.query(`SELECT * FROM alpha_admin_box_attempts
      WHERE grant_id = $1 ORDER BY attempt DESC LIMIT 1`, [id])).rows[0] ?? null;
  }
  async function finalized(row, attempt) {
    const asset = await reader.readFinalized({ programId, cluster: 'devnet',
      issuanceId: row.issuance_id, walletAddress: row.wallet_address,
      expectedIssuanceSource: 'admin-grant', expectedAdminOperationId: row.id,
      expectedFinalizedSignature: attempt.signature });
    return asset?.finalized && asset.kind === 'SILVER_BOX' &&
      asset.issuanceSource === 'admin-grant' && asset.adminOperationId === row.id &&
      asset.accountId === row.account_id && asset.originalRecipient === row.wallet_address &&
      asset.tokenOwner === row.wallet_address && asset.lifecycle === 'SEALED' &&
      asset.issuanceId === row.issuance_id &&
      asset.entitlementDigest === row.entitlement_digest &&
      asset.mintAddress === attempt.mint_address && asset.uri === BOX_URI &&
      asset.contentHash === BOX_HASH && asset.supply === '1' &&
      asset.tokenAmount === '1' && asset.mintAuthority === null &&
      asset.freezeAuthority === null ? asset : null;
  }
  async function process(client, row) {
    const identity = adminBoxIdentity(row.account_id, row.wallet_address, row.id);
    if (row.issuance_id !== identity.issuanceId ||
        row.entitlement_digest !== identity.entitlementDigest)
      throw new Error('Admin Box grant binding mismatch');
    let attempt = await latest(client, row.id);
    if (attempt?.state === 'UNKNOWN') {
      const status = await chain.status(attempt.signature);
      if (status?.confirmationStatus === 'finalized') {
        if (status.err === null) {
          const asset = await finalized(row, attempt);
          if (!asset) throw new Error('Finalized admin Box state mismatch');
          await client.query('BEGIN');
          try {
            await client.query(`UPDATE alpha_admin_box_attempts SET state = 'CONFIRMED',
              settled_at = now() WHERE grant_id = $1 AND attempt = $2
              AND state = 'UNKNOWN'`, [row.id, attempt.attempt]);
            await client.query(`UPDATE alpha_admin_box_grants SET state = 'CONFIRMED',
              mint_address = $2, confirmed_signature = $3, settled_at = now()
              WHERE id = $1 AND state = 'UNKNOWN'`,
            [row.id, asset.mintAddress, attempt.signature]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          return 'CONFIRMED';
        }
        await client.query('BEGIN');
        try {
          await client.query(`UPDATE alpha_admin_box_attempts SET state = 'FAILED',
            settled_at = now() WHERE grant_id = $1 AND attempt = $2
            AND state = 'UNKNOWN'`, [row.id, attempt.attempt]);
          await client.query(`UPDATE alpha_admin_box_grants SET state = 'FAILED',
            settled_at = now() WHERE id = $1 AND state = 'UNKNOWN'`, [row.id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        return 'FAILED';
      }
      if (status?.err) throw new Error('Ambiguous admin Box signature');
      if (await chain.blockHeight() <= Number(attempt.last_valid_block_height) + 32) {
        try { await chain.send(attempt); } catch { /* Persisted UNKNOWN; retry later. */ }
        return 'UNKNOWN';
      }
      // Never construct a second issuance while an old attempt might have landed.
      const live = await finalized(row, attempt);
      if (live) throw new Error('Admin Box on-chain result needs signature reconciliation');
      await client.query(`UPDATE alpha_admin_box_attempts SET state = 'EXPIRED',
        settled_at = now() WHERE grant_id = $1 AND attempt = $2
        AND state = 'UNKNOWN'`, [row.id, attempt.attempt]);
    }
    const signed = await chain.build({ account_id: row.account_id,
      wallet_address: row.wallet_address, admin_operation_id: row.id,
      issuance_source: 'admin-grant', issuance_id: row.issuance_id,
      entitlement_digest: row.entitlement_digest, cluster: 'devnet', status: 'pending' });
    await client.query(`INSERT INTO alpha_admin_box_attempts
      (grant_id,attempt,signature,raw_transaction_base64,blockhash,
       last_valid_block_height,mint_address) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.id, (attempt?.attempt ?? 0) + 1, signed.signature,
      signed.rawTransactionBase64, signed.blockhash,
      signed.lastValidBlockHeight, signed.mintAddress]);
    await client.query(`UPDATE alpha_admin_box_grants SET state = 'UNKNOWN'
      WHERE id = $1 AND state = 'PENDING'`, [row.id]);
    attempt = await latest(client, row.id);
    try { await chain.send(attempt); } catch { /* Persisted UNKNOWN; retry later. */ }
    return 'UNKNOWN';
  }
  return {
    async create(token, body) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'idempotencyKey,reason,targetAccountId' ||
          !UUID.test(body.idempotencyKey ?? '') || !UUID.test(body.targetAccountId ?? '') ||
          typeof body.reason !== 'string' || body.reason !== body.reason.trim() ||
          body.reason.length < 1 || body.reason.length > 512 ||
          /[\x00-\x1f\x7f]/.test(body.reason)) return BAD;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 91825))',
          [body.idempotencyKey]);
        const target = (await client.query(`SELECT a.verified_at,
          b.wallet_address, b.environment FROM alpha_accounts a
          LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
          WHERE a.id = $1`, [body.targetAccountId])).rows[0];
        if (!target?.verified_at || !target.wallet_address ||
            target.environment !== 'alpha-public') {
          await client.query('ROLLBACK');
          return { status: 409, body: { code: 'PUBLIC_WALLET_BINDING_REQUIRED' } };
        }
        const identity = adminBoxIdentity(body.targetAccountId,
          target.wallet_address, body.idempotencyKey);
        await client.query(`INSERT INTO alpha_admin_box_grants
          (id,actor_account_id,account_id,wallet_address,issuance_id,
           entitlement_digest,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
        [body.idempotencyKey, actor.id, body.targetAccountId,
          target.wallet_address, identity.issuanceId,
          identity.entitlementDigest, body.reason]);
        const row = (await client.query(`SELECT * FROM alpha_admin_box_grants
          WHERE id = $1 FOR UPDATE`, [body.idempotencyKey])).rows[0];
        await client.query('COMMIT');
        return row.actor_account_id === actor.id && row.account_id === body.targetAccountId &&
          row.wallet_address === target.wallet_address && row.reason === body.reason ?
          { status: 202, body: view(row) } : CONFLICT;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async list(token) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      const rows = (await pool.query(`SELECT * FROM alpha_admin_box_grants
        ORDER BY created_at DESC LIMIT 100`)).rows;
      return { status: 200, body: { grants: rows.map(view) } };
    },
    async tick() {
      const client = await pool.connect();
      try {
        const lock = (await client.query(
          'SELECT pg_try_advisory_lock(815203902) AS locked')).rows[0]?.locked;
        if (!lock) return { state: 'BUSY' };
        try {
          const row = (await client.query(`SELECT * FROM alpha_admin_box_grants
            WHERE state IN ('PENDING','UNKNOWN') ORDER BY created_at LIMIT 1`)).rows[0];
          return row ? { operationId: row.id, state: await process(client, row) } :
            { state: 'IDLE' };
        } finally { await client.query('SELECT pg_advisory_unlock(815203902)'); }
      } finally { client.release(); }
    },
  };
}
