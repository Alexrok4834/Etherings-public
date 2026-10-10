import { createHash, randomUUID } from 'node:crypto';
import { canonicalErt } from './m2e-ert-decimal.js';
import { createHybridErtFoundation } from './hybrid-ert.js';
import { cooperBreedingPrice } from './cooper-breeding-price.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/i;
const VERSION = 'cooper-breeding-v1';
const failure = (status, code) => ({ status, body: { code } });
const sha = value => createHash('sha256').update(value, 'ascii').digest('hex');
const exactFields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');

export function breedingBoxIdentity(accountId, walletAddress, operationId,
  firstRingId, secondRingId, firstUses, secondUses, cluster = 'devnet') {
  if (![accountId, operationId, firstRingId, secondRingId].every(value =>
    typeof value === 'string' && UUID.test(value)) || firstRingId === secondRingId ||
      ![firstUses, secondUses].every(value => Number.isInteger(value) &&
        value >= 0 && value <= 1) ||
      typeof walletAddress !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress) || cluster !== 'devnet')
    throw new TypeError('Invalid breeding Box identity');
  const issuanceId = sha(`EtheRings:cooper-breeding:issuance:v1\n${cluster}\n${operationId}\n`);
  const entitlementDigest = sha(`EtheRings:cooper-breeding:binding:v1\n${cluster}\n` +
    `${accountId}\n${walletAddress}\n${operationId}\n${firstRingId}\n${secondRingId}\n` +
    `${firstUses}\n${secondUses}\n${issuanceId}\n`);
  return { issuanceId, entitlementDigest };
}

function receipt(row) {
  return { operationId: row.id, reservationId: row.reservation_id,
    firstRingId: row.first_ring_id, secondRingId: row.second_ring_id,
    firstUses: row.first_uses, secondUses: row.second_uses,
    walletAddress: row.wallet_address, issuanceId: row.issuance_id,
    cost: { ertExact: canonicalErt(row.ert_cost),
      eruPrincipalExact: canonicalErt(row.eru_principal),
      eruFeeExact: canonicalErt(row.eru_fee) },
    status: row.settled_at ? 'confirmed' : 'prepared' };
}

export function createCooperBreeding({ pool, auth, cluster = 'devnet' }) {
  if (!pool || typeof pool.connect !== 'function' || typeof auth?.me !== 'function' ||
      cluster !== 'devnet') throw new Error('Cooper breeding requires Alpha auth and Devnet DB');
  const hybrid = createHybridErtFoundation({ pool });
  const identify = async (token, firstRingId, body, mutation) => {
    const session = await auth.me(token);
    if (session.status !== 200) return { failure: session };
    if (!exactFields(body, mutation ? ['secondRingId', 'idempotencyKey'] : ['secondRingId']) ||
        typeof firstRingId !== 'string' || !UUID.test(firstRingId) ||
        typeof body.secondRingId !== 'string' || !UUID.test(body.secondRingId) ||
        (mutation && (typeof body.idempotencyKey !== 'string' ||
          !UUID.test(body.idempotencyKey))))
      return { failure: failure(400, 'COOPER_BREEDING_REQUEST_INVALID') };
    const first = firstRingId.toLowerCase();
    const second = body.secondRingId.toLowerCase();
    if (first === second) return { failure: failure(400, 'COOPER_BREEDING_SAME_PARENT') };
    return { accountId: session.body.id, first, second,
      key: mutation ? body.idempotencyKey.toLowerCase() : null };
  };
  const owned = async (client, accountId, first, second, lock) => {
    const rows = (await client.query(`SELECT ring_id::text, level, breeding_uses
      FROM alpha_cooper_current_state WHERE account_id = $1
        AND ring_id = ANY($2::uuid[]) ORDER BY ring_id ${lock ? 'FOR UPDATE' : ''}`,
    [accountId, [first, second]])).rows;
    if (rows.length !== 2) return null;
    return [first, second].map(id => rows.find(row => row.ring_id === id));
  };
  const eligibility = rows => {
    if (!rows || rows.some(row => !row)) return failure(404, 'COOPER_PARENT_NOT_OWNED');
    if (rows.some(row => row.level !== 20)) return failure(409, 'COOPER_PARENT_LEVEL_REQUIRED');
    if (rows.some(row => row.breeding_uses > 1))
      return failure(409, 'COOPER_PARENT_EXHAUSTED');
    return null;
  };
  return {
    async preview(token, firstRingId, body) {
      const request = await identify(token, firstRingId, body, false);
      if (request.failure) return request.failure;
      const client = await pool.connect();
      try {
        const rows = await owned(client, request.accountId,
          request.first, request.second, false);
        const invalid = eligibility(rows);
        if (invalid) return invalid;
        const active = (await client.query(`SELECT ring_id FROM
          alpha_cooper_breeding_parent_holds WHERE account_id = $1
            AND ring_id = ANY($2::uuid[]) AND released_at IS NULL LIMIT 1`,
        [request.accountId, [request.first, request.second]])).rowCount;
        if (active) return failure(409, 'COOPER_PARENT_RESERVED');
        const price = cooperBreedingPrice(rows[0].breeding_uses, rows[1].breeding_uses);
        if (!price) return failure(409, 'COOPER_PARENT_EXHAUSTED');
        return { status: 200, body: { firstRingId: request.first,
          secondRingId: request.second, firstUses: price.firstUses,
          secondUses: price.secondUses, cost: { ertExact: price.ertExact,
            eruPrincipalExact: price.eruPrincipalExact, eruFeeExact: price.eruFeeExact,
            eruTotalExact: price.eruTotalExact }, rulesVersion: VERSION } };
      } finally { client.release(); }
    },
    async prepare(token, firstRingId, body) {
      const request = await identify(token, firstRingId, body, true);
      if (request.failure) return request.failure;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`,
        [request.accountId])).rows[0];
        if (!owner) { await client.query('ROLLBACK');
          return failure(401, 'AUTH_REQUIRED'); }
        const fingerprint = sha(JSON.stringify({ accountId: request.accountId,
          firstRingId: request.first, secondRingId: request.second,
          rulesVersion: VERSION }));
        const prior = (await client.query(`SELECT o.*, s.settled_at FROM
          alpha_cooper_breeding_operations o LEFT JOIN
          alpha_cooper_breeding_settlements s ON s.operation_id = o.id
          WHERE o.account_id = $1 AND o.idempotency_key = $2`,
        [request.accountId, request.key])).rows[0];
        if (prior) {
          const current = (await client.query(`SELECT wallet_address FROM
            alpha_wallet_bindings WHERE account_id = $1`, [request.accountId])).rows[0];
          if (prior.request_fingerprint !== fingerprint ||
              current?.wallet_address !== prior.wallet_address) {
            await client.query('ROLLBACK');
            return failure(409, 'COOPER_BREEDING_IDEMPOTENCY_CONFLICT');
          }
          await client.query('COMMIT');
          return { status: 200, body: receipt(prior) };
        }
        const rows = await owned(client, request.accountId,
          request.first, request.second, true);
        const invalid = eligibility(rows);
        if (invalid) { await client.query('ROLLBACK'); return invalid; }
        const price = cooperBreedingPrice(rows[0].breeding_uses, rows[1].breeding_uses);
        if (!price) { await client.query('ROLLBACK');
          return failure(409, 'COOPER_PARENT_EXHAUSTED'); }
        const wallet = (await client.query(`SELECT wallet_address FROM
          alpha_wallet_bindings WHERE account_id = $1`, [request.accountId])).rows[0];
        if (!wallet) { await client.query('ROLLBACK');
          return failure(409, 'BOUND_WALLET_REQUIRED'); }
        const operationId = randomUUID();
        const hybridOperationId = randomUUID();
        const identity = breedingBoxIdentity(request.accountId,
          wallet.wallet_address, operationId, request.first, request.second,
          price.firstUses, price.secondUses, cluster);
        const requestDigest = sha(JSON.stringify({ rulesVersion: VERSION, operationId,
          hybridOperationId, accountId: request.accountId,
          walletAddress: wallet.wallet_address, cluster,
          firstRingId: request.first, secondRingId: request.second,
          firstLevel: 20, secondLevel: 20,
          firstUses: price.firstUses, secondUses: price.secondUses,
          ertExact: price.ertExact, eruPrincipalExact: price.eruPrincipalExact,
          eruFeeExact: price.eruFeeExact, issuanceId: identity.issuanceId,
          entitlementDigest: identity.entitlementDigest }));
        const hold = await hybrid.reserveInTransaction(client, {
          operationId: hybridOperationId, accountId: request.accountId,
          walletAddress: wallet.wallet_address, cluster,
          operationType: 'cooper_breeding', requestDigest,
          ertAmount: price.ertExact,
        });
        await client.query(`INSERT INTO alpha_cooper_breeding_operations
          (id,account_id,hybrid_operation_id,reservation_id,wallet_address,cluster,
           idempotency_key,request_fingerprint,first_ring_id,second_ring_id,
           first_uses,second_uses,ert_cost,eru_principal,eru_fee,request_digest,
           issuance_id,entitlement_digest)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [operationId, request.accountId, hybridOperationId, hold.reservationId,
          wallet.wallet_address, cluster, request.key, fingerprint,
          request.first, request.second, price.firstUses, price.secondUses,
          price.ertExact, price.eruPrincipalExact, price.eruFeeExact, requestDigest,
          identity.issuanceId, identity.entitlementDigest]);
        for (const row of rows) await client.query(`INSERT INTO
          alpha_cooper_breeding_parent_holds
          (operation_id,account_id,ring_id,uses_before) VALUES ($1,$2,$3,$4)`,
        [operationId, request.accountId, row.ring_id, row.breeding_uses]);
        await client.query('COMMIT');
        return { status: 200, body: { operationId,
          reservationId: hold.reservationId, firstRingId: request.first,
          secondRingId: request.second, firstUses: price.firstUses,
          secondUses: price.secondUses, walletAddress: wallet.wallet_address,
          issuanceId: identity.issuanceId, cost: { ertExact: price.ertExact,
            eruPrincipalExact: price.eruPrincipalExact,
            eruFeeExact: price.eruFeeExact }, status: 'prepared' } };
      } catch (cause) {
        await client.query('ROLLBACK');
        if (cause.code === '23505' || cause.code === '23514')
          return failure(409, 'COOPER_PARENT_RESERVED');
        throw cause;
      } finally { client.release(); }
    },
  };
}
