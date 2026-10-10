import { createHash, randomUUID } from 'node:crypto';
import { createHybridErtFoundation } from './hybrid-ert.js';
import { silverRingIsListed } from './silver-listed-eligibility.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const response = (status, code) => ({ status, body: { code } });
const fields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');

const silverPrice = target => target === 5 ? { principal: '38', fee: '0.76', total: '38.76' } :
  target === 20 ? { principal: '75', fee: '1.50', total: '76.50' } :
    { principal: '0', fee: '0', total: '0' };

// Every Silver level transition is signed and chain-authoritative, including
// those without an ERU principal. The ERT reservation is always off-chain.
export async function readOwnedSilver({ pool, chain, programId, mint, wallet }) {
  const cluster = 'devnet';
  const owned = await chain.listOwnedRings({ programId, cluster, walletAddress: wallet });
  const matches = owned.filter(ring => ring.mintAddress === mint &&
    ring.tokenOwner === wallet && ring.kind === 'SILVER_RING' &&
    ring.cluster === cluster && ring.programId === programId &&
    /^[a-f0-9]{64}$/.test(ring.issuanceId ?? ''));
  if (matches.length !== 1) return null;
  const ring = matches[0];
  const source = (await pool.query(`SELECT 1 FROM alpha_silver_opening_finalizations
    WHERE ring_mint_address = $1 AND program_id = $2 AND cluster = $3
      AND mint_address = $4 AND status = 'confirmed'`,
  [mint, programId, cluster, ring.boxMint])).rows;
  return source.length === 1 ? ring : null;
}

export function createSilverProgression({ pool, auth, chain, marketReader = null, programId }) {
  if (typeof pool?.connect !== 'function' || typeof auth?.me !== 'function' ||
      typeof chain?.listOwnedRings !== 'function' || !MINT.test(programId ?? ''))
    throw new Error('Silver progression unavailable');
  const hybrid = createHybridErtFoundation({ pool });
  const cluster = 'devnet';
  return {
    async prepare(token, mint, body) {
      const session = await auth.me(token);
      if (session.status !== 200) return session;
      if (!MINT.test(mint ?? '') || !fields(body,
        ['expectedCurrentLevel', 'targetLevel', 'idempotencyKey']) ||
          !UUID.test(body.idempotencyKey ?? '') ||
          !Number.isInteger(body.expectedCurrentLevel) ||
          body.targetLevel !== body.expectedCurrentLevel + 1 ||
          body.expectedCurrentLevel < 1 || body.targetLevel > 20)
        return response(400, 'SILVER_PROGRESSION_REQUEST_INVALID');
      const accountId = session.body.id;
      const wallet = (await pool.query(`SELECT wallet_address FROM alpha_wallet_bindings
        WHERE account_id = $1`, [accountId])).rows[0]?.wallet_address;
      if (!wallet) return response(409, 'BOUND_WALLET_REQUIRED');
      const cost = String(5 * (body.targetLevel + 1));
      const price = silverPrice(body.targetLevel);
      const idempotencyKey = body.idempotencyKey.toLowerCase();
      const request = { accountId, mint, expectedLevel: body.expectedCurrentLevel,
        targetLevel: body.targetLevel, cost };
      const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const existing = (await pool.query(`SELECT * FROM alpha_silver_progression_operations
        WHERE account_id = $1 AND idempotency_key = $2`,
      [accountId, idempotencyKey])).rows[0];
      if (existing) return existing.mint_address === mint &&
          existing.request_digest === requestDigest && existing.wallet_address === wallet ?
        { status: 200, body: { operationId: existing.id,
          reservationId: existing.reservation_id, status: existing.status,
          ...(existing.response_snapshot ? { snapshot: existing.response_snapshot } : {}) } } :
        response(409, 'SILVER_PROGRESSION_IDEMPOTENCY_CONFLICT');
      const ring = await readOwnedSilver({ pool, chain, programId, mint, wallet });
      if (!ring) return response(404, 'SILVER_RING_NOT_OWNED');
      const cooldown = BigInt(ring.cooldownUntilUnixSeconds);
      if (cooldown > BigInt(Math.floor(Date.now() / 1000)))
        return { status: 409, body: { code: 'SILVER_RING_COOLDOWN',
          cooldownUntilUnixSeconds: cooldown.toString() } };
      if (await silverRingIsListed(marketReader, mint))
        return response(409, 'SILVER_RING_LISTED');
      if (ring.level !== body.expectedCurrentLevel)
        return response(409, 'SILVER_LEVEL_STALE');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) { await client.query('ROLLBACK'); return response(404, 'ACCOUNT_NOT_FOUND'); }
        const binding = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
          WHERE account_id = $1`, [accountId])).rows[0];
        if (binding?.wallet_address !== wallet) {
          await client.query('ROLLBACK'); return response(409, 'BOUND_WALLET_CHANGED');
        }
        const prior = (await client.query(`SELECT * FROM alpha_silver_progression_operations
          WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [accountId, idempotencyKey])).rows[0];
        if (prior) {
          if (prior.mint_address !== mint || prior.expected_level !== body.expectedCurrentLevel ||
              prior.target_level !== body.targetLevel || prior.wallet_address !== wallet ||
              prior.request_digest !== requestDigest) {
            await client.query('ROLLBACK');
            return response(409, 'SILVER_PROGRESSION_IDEMPOTENCY_CONFLICT');
          }
          await client.query('COMMIT');
          return { status: 200, body: { operationId: prior.id,
            reservationId: prior.reservation_id, status: prior.status,
            ...(prior.response_snapshot ? { snapshot: prior.response_snapshot } : {}) } };
        }
        const pending = (await client.query(`SELECT * FROM alpha_silver_progression_operations
          WHERE mint_address = $1 AND status = 'prepared'`, [mint])).rows[0];
        if (pending) {
          await client.query('COMMIT');
          return pending.account_id === accountId &&
              pending.wallet_address === wallet &&
              pending.request_digest === requestDigest ?
            { status: 200, body: { operationId: pending.id,
              reservationId: pending.reservation_id, status: pending.status } } :
            response(409, 'SILVER_PROGRESSION_PENDING');
        }
        const operationId = randomUUID();
        const hybridOperationId = randomUUID();
        const hold = await hybrid.reserveInTransaction(client, { operationId: hybridOperationId,
          accountId, walletAddress: wallet, cluster, operationType: 'silver_progression',
          requestDigest, ertAmount: cost });
        await client.query(`INSERT INTO alpha_silver_progression_operations
          (id,account_id,idempotency_key,mint_address,issuance_id,wallet_address,cluster,
           expected_level,target_level,ert_cost,hybrid_operation_id,reservation_id,request_digest,
           eru_principal,eru_fee)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [operationId, accountId, idempotencyKey, mint, ring.issuanceId, wallet, cluster,
          body.expectedCurrentLevel, body.targetLevel, cost, hybridOperationId,
          hold.reservationId, requestDigest, price.principal, price.fee]);
        await client.query('COMMIT');
        return { status: 200, body: { operationId, reservationId: hold.reservationId,
          mintAddress: mint, expectedCurrentLevel: body.expectedCurrentLevel,
          targetLevel: body.targetLevel, cost: { ertExact: cost, eruExact: price.total },
          status: 'prepared' } };
      } catch (cause) {
        await client.query('ROLLBACK');
        if (cause.code === 'INSUFFICIENT_ERT') return response(409, 'INSUFFICIENT_ERT');
        if (cause.code === '23505') return response(409, 'SILVER_PROGRESSION_PENDING');
        throw cause;
      } finally { client.release(); }
    },
  };
}
