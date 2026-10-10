import { getAddressEncoder, address } from '@solana/kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/;
const MAX = 50_000_000_000n;
const BAD = { status: 400, body: { code: 'INVALID_ADMIN_ERU_TRANSFER' } };
const DENIED = { status: 403, body: { code: 'ADMIN_REQUIRED' } };
const CONFLICT = { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };

function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !==
        'amountExact,idempotencyKey,reason,walletAddress' ||
      !UUID.test(body.idempotencyKey) ||
      typeof body.walletAddress !== 'string' ||
      typeof body.amountExact !== 'string' ||
      typeof body.reason !== 'string' || body.reason.trim() !== body.reason ||
      body.reason.length < 1 || body.reason.length > 512 ||
      /[\x00-\x1f\x7f]/.test(body.reason)) return null;
  const match = AMOUNT.exec(body.amountExact ?? '');
  if (!match) return null;
  const amount = BigInt(match[1]) * 1_000_000_000n +
    BigInt((match[2] ?? '').padEnd(9, '0'));
  if (amount < 1n || amount > MAX ||
      (match[2]?.endsWith('0') && match[2] !== '0')) return null;
  try {
    getAddressEncoder().encode(address(body.walletAddress));
  } catch { return null; }
  return { id: body.idempotencyKey, wallet: body.walletAddress,
    amount: amount.toString(), reason: body.reason };
}

function view(row) {
  return { operationId: row.id, walletAddress: row.wallet_address,
    amountBaseUnits: String(row.amount_base_units), state: row.state,
    signature: row.confirmed_signature ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null };
}

export function createAdminEruTransfer({ pool, auth, chain }) {
  if (!pool?.connect || !auth?.me || !chain?.buildAdmin ||
      !chain?.readAdminFinalized || !chain?.send || !chain?.status ||
      !chain?.adminRemaining)
    throw new Error('Admin ERU requires canonical Alpha database, auth and chain');

  async function admin(token) {
    const session = await auth.me(token);
    if (session.status !== 200) return { error: session };
    const actor = (await pool.query(
      'SELECT is_admin, verified_at FROM alpha_accounts WHERE id = $1',
      [session.body.id])).rows[0];
    return actor?.is_admin && actor.verified_at ?
      { id: session.body.id } : { error: DENIED };
  }
  async function latest(client, id) {
    return (await client.query(`SELECT * FROM alpha_admin_eru_attempts
      WHERE transfer_id = $1 ORDER BY attempt DESC LIMIT 1`, [id])).rows[0] ?? null;
  }
  async function processOne(client, row) {
    let attempt = await latest(client, row.id);
    if (attempt?.state === 'UNKNOWN') {
      const status = await chain.status(attempt.signature);
      if (status?.confirmationStatus === 'finalized') {
        if (status.err === null) {
          const result = await chain.readAdminFinalized(row.id, row.wallet_address,
            String(row.amount_base_units), attempt.signature);
          if (!result || result.signature !== attempt.signature ||
              result.amountBaseUnits !== String(row.amount_base_units))
            throw new Error('Admin ERU finalized payout not verified');
          await client.query('BEGIN');
          try {
            await client.query(`UPDATE alpha_admin_eru_attempts
              SET state = 'CONFIRMED', settled_at = now()
              WHERE transfer_id = $1 AND attempt = $2 AND state = 'UNKNOWN'`,
            [row.id, attempt.attempt]);
            await client.query(`UPDATE alpha_admin_eru_transfers
              SET state = 'CONFIRMED', confirmed_signature = $2, settled_at = now()
              WHERE id = $1 AND state = 'UNKNOWN'`, [row.id, attempt.signature]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          return 'CONFIRMED';
        }
        await client.query('BEGIN');
        try {
          await client.query(`UPDATE alpha_admin_eru_attempts
            SET state = 'FAILED', settled_at = now()
            WHERE transfer_id = $1 AND attempt = $2 AND state = 'UNKNOWN'`,
          [row.id, attempt.attempt]);
          await client.query(`UPDATE alpha_admin_eru_transfers
            SET state = 'FAILED', settled_at = now()
            WHERE id = $1 AND state = 'UNKNOWN'`, [row.id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        return 'FAILED';
      }
      if (status?.err) throw new Error('Admin ERU ambiguous signature status');
      if (await chain.blockHeight() <= Number(attempt.last_valid_block_height) + 32) {
        try { await chain.send(attempt); } catch { /* Durable UNKNOWN, reconcile later. */ }
        return 'UNKNOWN';
      }
      await client.query(`UPDATE alpha_admin_eru_attempts
        SET state = 'EXPIRED', settled_at = now()
        WHERE transfer_id = $1 AND attempt = $2 AND state = 'UNKNOWN'`,
      [row.id, attempt.attempt]);
      attempt = await latest(client, row.id);
    }
    if (attempt?.state === 'FAILED') return 'FAILED';
    const signed = await chain.buildAdmin({ operationId: row.id,
      wallet: row.wallet_address, amountBaseUnits: String(row.amount_base_units) });
    await client.query(`INSERT INTO alpha_admin_eru_attempts
      (transfer_id, attempt, signature, raw_transaction_base64,
       blockhash, last_valid_block_height)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.id, (attempt?.attempt ?? 0) + 1, signed.signature,
      signed.rawTransactionBase64, signed.blockhash, signed.lastValidBlockHeight]);
    await client.query(`UPDATE alpha_admin_eru_transfers
      SET state = 'UNKNOWN' WHERE id = $1 AND state = 'PENDING'`, [row.id]);
    const stored = await latest(client, row.id);
    try { await chain.send(stored); } catch { /* Durable UNKNOWN, reconcile later. */ }
    return 'UNKNOWN';
  }

  return {
    async budget(token) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      return { status: 200, body: {
        maxTransferBaseUnits: MAX.toString(),
        totalDelegatedBaseUnits: '20000000000000',
        remainingBaseUnits: String(await chain.adminRemaining()),
      } };
    },
    async create(token, body) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      const input = parse(body);
      if (!input) return BAD;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO alpha_admin_eru_transfers
          (id, actor_account_id, wallet_address, amount_base_units, reason)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [input.id, actor.id, input.wallet, input.amount, input.reason]);
        const row = (await client.query(`SELECT * FROM alpha_admin_eru_transfers
          WHERE id = $1 FOR UPDATE`, [input.id])).rows[0];
        await client.query('COMMIT');
        if (row.actor_account_id !== actor.id ||
            row.wallet_address !== input.wallet ||
            String(row.amount_base_units) !== input.amount ||
            row.reason !== input.reason) return CONFLICT;
        return { status: 202, body: view(row) };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async get(token, id) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      if (!UUID.test(id ?? '')) return BAD;
      const row = (await pool.query(`SELECT * FROM alpha_admin_eru_transfers
        WHERE id = $1`, [id])).rows[0];
      return row ? { status: 200, body: view(row) } :
        { status: 404, body: { code: 'ADMIN_ERU_TRANSFER_NOT_FOUND' } };
    },
    async list(token) {
      const actor = await admin(token);
      if (actor.error) return actor.error;
      const rows = (await pool.query(`SELECT * FROM alpha_admin_eru_transfers
        ORDER BY created_at DESC LIMIT 100`)).rows;
      return { status: 200, body: { transfers: rows.map(view) } };
    },
    async tick() {
      const client = await pool.connect();
      try {
        const lock = (await client.query(
          'SELECT pg_try_advisory_lock(815203901) AS locked')).rows[0]?.locked;
        if (!lock) return { state: 'BUSY' };
        try {
          const row = (await client.query(`SELECT * FROM alpha_admin_eru_transfers
            WHERE state IN ('PENDING', 'UNKNOWN') ORDER BY created_at LIMIT 1`)).rows[0];
          return row ? { state: await processOne(client, row), operationId: row.id } :
            { state: 'IDLE' };
        } finally { await client.query('SELECT pg_advisory_unlock(815203901)'); }
      } finally { client.release(); }
    }
  };
}
