import { createHash, randomUUID } from 'node:crypto';
import { canonicalErt, displayErt, ErtDecimal } from './m2e-ert-decimal.js';
import { createHybridErtFoundation } from './hybrid-ert.js';

// Exact MVP copper-level-up-v2 transition table, adapted to Alpha account/ledger.
const VERSION = 'copper-level-up-v2';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICES = Object.freeze([
  null, null, 12, 16, 20, 24, 28, 32, 36, 40, 44,
  48, 52, 56, 60, 64, 68, 72, 76, 80, 84,
]);
const ERU_PRICES = Object.freeze({ 5: 30, 20: 60 });
const ERU_FEES = Object.freeze({ 5: '0.6', 20: '1.2' });
const GRANTED_POINTS = 4;
const error = (status, code) => ({ status, body: { code } });

function request(input, mutation) {
  const fields = mutation ? 'expectedCurrentLevel,idempotencyKey,targetLevel' :
    'expectedCurrentLevel,targetLevel';
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== fields ||
      !Number.isSafeInteger(input.expectedCurrentLevel) ||
      !Number.isSafeInteger(input.targetLevel) ||
      (mutation && (typeof input.idempotencyKey !== 'string' ||
        !UUID_V4.test(input.idempotencyKey))))
    return null;
  return { expected: input.expectedCurrentLevel, target: input.targetLevel,
    key: mutation ? input.idempotencyKey.toLowerCase() : null };
}

function transition(current, target) {
  if (target !== current + 1 || target < 2 || target > 20) return null;
  return { ert: PRICES[target], eru: ERU_PRICES[target] ?? 0 };
}

function attributes(ring) {
  return { comfort: ring.comfort, charm: ring.charm,
    quality: ring.quality, luck: ring.luck };
}

function milestone(level) {
  const utilities = level === 5 ? ['BREEDING', 'GEM_SLOT'] :
    level === 10 ? ['RING_SHOW_STAKING'] :
      level === 20 ? ['TRANSFORMATION'] : null;
  return utilities ? { level, utilities: utilities.map(code => ({ code, available: false })) } : null;
}

function fingerprint(accountId, ringId, input) {
  return createHash('sha256').update(JSON.stringify({ ownerUserId: accountId,
    ringId, expectedCurrentLevel: input.expected, targetLevel: input.target,
    rulesVersion: VERSION })).digest('hex');
}

async function ownedRing(client, accountId, ringId, lock) {
  return (await client.query(`SELECT level, comfort, charm, quality, luck,
      unspent_attribute_points FROM alpha_cooper_current_state
    WHERE account_id = $1 AND ring_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
  [accountId, ringId])).rows[0] ?? null;
}

async function ertBalance(client, accountId) {
  const row = (await client.query(`SELECT balance::text AS balance,
      available::text AS available FROM alpha_ert_available WHERE account_id = $1`,
  [accountId])).rows[0];
  return { balance: canonicalErt(row?.balance ?? '0'),
    available: canonicalErt(row?.available ?? '0') };
}

export function createCooperLevelUp({ pool, auth, eruEnabled = false }) {
  if (!pool || typeof auth?.me !== 'function')
    throw new Error('Cooper Level-Up requires Alpha auth and PostgreSQL');
  const hybrid = createHybridErtFoundation({ pool });

  async function identity(token, ringId, body, mutation) {
    const session = await auth.me(token);
    if (session.status !== 200) return { failure: session };
    const input = request(body, mutation);
    if (!input) return { failure: error(400, mutation ?
      'RING_LEVEL_UP_REQUEST_INVALID' : 'RING_LEVEL_UP_PREVIEW_REQUEST_INVALID') };
    if (typeof ringId !== 'string' || !UUID_V4.test(ringId))
      return { failure: error(404, 'RING_NOT_FOUND') };
    return { accountId: session.body.id, ringId: ringId.toLowerCase(), input };
  }

  return {
    // Internal preparation only. No HTTP route or signable candidate exists until
    // chain intent/finality/reconciliation are implemented and verified.
    async prepareEru(token, ringId, body) {
      const bound = await identity(token, ringId, body, true);
      if (bound.failure) return bound.failure;
      const { accountId, input } = bound;
      const digest = fingerprint(accountId, bound.ringId, input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
        await client.query(`INSERT INTO alpha_cooper_level_up_operations
          (id,account_id,ring_id,idempotency_key,request_fingerprint,rules_version)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (account_id,idempotency_key) DO NOTHING`,
        [randomUUID(), accountId, bound.ringId, input.key, digest, VERSION]);
        const operation = (await client.query(`SELECT id, ring_id, request_fingerprint,
            response_snapshot FROM alpha_cooper_level_up_operations
          WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [accountId, input.key])).rows[0];
        if (operation.request_fingerprint !== digest || operation.ring_id !== bound.ringId ||
            operation.response_snapshot) {
          await client.query('ROLLBACK');
          return error(409, 'RING_LEVEL_IDEMPOTENCY_CONFLICT');
        }
        const prior = (await client.query(`SELECT p.*, r.state AS reservation_state
          FROM alpha_cooper_level_eru_preparations p
          JOIN alpha_ert_reservations r ON r.id = p.reservation_id
          WHERE p.operation_id = $1`, [operation.id])).rows[0];
        if (prior) {
          const wallet = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
            WHERE account_id = $1`, [accountId])).rows[0];
          if (wallet?.wallet_address !== prior.wallet_address) {
            await client.query('ROLLBACK'); return error(409, 'BOUND_WALLET_CHANGED');
          }
          await client.query('COMMIT');
          return { status: 200, body: { operationId: operation.id,
            hybridOperationId: prior.hybrid_operation_id,
            reservationId: prior.reservation_id, requestDigest: prior.request_digest,
            ringId: bound.ringId, expectedCurrentLevel: prior.expected_level,
            targetLevel: prior.target_level, walletAddress: prior.wallet_address,
            cost: { ertExact: canonicalErt(prior.ert_cost),
              eruPrincipalExact: canonicalErt(prior.eru_principal),
              eruFeeExact: canonicalErt(prior.eru_fee) },
            status: prior.status, reservationState: prior.reservation_state } };
        }
        const ring = await ownedRing(client, accountId, bound.ringId, true);
        if (!ring) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
        if (ring.level !== input.expected) {
          await client.query('ROLLBACK'); return error(409, 'RING_LEVEL_STALE');
        }
        const price = transition(ring.level, input.target);
        if (!price || !price.eru) {
          await client.query('ROLLBACK'); return error(400, 'RING_ERU_TRANSITION_INVALID');
        }
        if (ring.unspent_attribute_points + GRANTED_POINTS > 76) {
          await client.query('ROLLBACK'); return error(503, 'RING_LEVEL_STATE_UNAVAILABLE');
        }
        const active = (await client.query(`SELECT operation_id
          FROM alpha_cooper_level_eru_preparations
          WHERE account_id = $1 AND ring_id = $2 AND status IN ('prepared','unknown')`,
        [accountId, bound.ringId])).rows[0];
        if (active) {
          await client.query('ROLLBACK'); return error(409, 'RING_ERU_TRANSITION_PENDING');
        }
        const wallet = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
          WHERE account_id = $1`, [accountId])).rows[0];
        if (!wallet) { await client.query('ROLLBACK'); return error(409, 'BOUND_WALLET_REQUIRED'); }
        const hybridOperationId = randomUUID();
        const cluster = 'devnet';
        const fee = ERU_FEES[input.target];
        const cost = canonicalErt(String(price.ert));
        const requestDigest = createHash('sha256').update(JSON.stringify({
          rulesVersion: VERSION, operationId: operation.id, hybridOperationId,
          accountId, ringId: bound.ringId, walletAddress: wallet.wallet_address,
          cluster, expectedLevel: ring.level, targetLevel: input.target,
          unspentPointsBefore: ring.unspent_attribute_points,
          attributes: attributes(ring), ertCost: cost,
          eruPrincipal: String(price.eru), eruFee: fee,
        })).digest('hex');
        const hold = await hybrid.reserveInTransaction(client, {
          operationId: hybridOperationId, accountId,
          walletAddress: wallet.wallet_address, cluster,
          operationType: 'cooper_level_up', requestDigest, ertAmount: cost,
        });
        await client.query(`INSERT INTO alpha_cooper_level_eru_preparations
          (operation_id,hybrid_operation_id,reservation_id,account_id,ring_id,
           wallet_address,cluster,expected_level,target_level,unspent_points_before,
           ert_cost,eru_principal,eru_fee,request_digest)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [operation.id, hybridOperationId, hold.reservationId, accountId, bound.ringId,
          wallet.wallet_address, cluster, ring.level, input.target,
          ring.unspent_attribute_points, cost, String(price.eru), fee, requestDigest]);
        await client.query('COMMIT');
        return { status: 200, body: { operationId: operation.id,
          hybridOperationId, reservationId: hold.reservationId, requestDigest,
          ringId: bound.ringId, expectedCurrentLevel: ring.level,
          targetLevel: input.target, walletAddress: wallet.wallet_address,
          cost: { ertExact: cost, eruPrincipalExact: String(price.eru), eruFeeExact: fee },
          status: 'prepared', reservationState: 'held' } };
      } catch (cause) {
        await client.query('ROLLBACK');
        if (cause.code === 'INSUFFICIENT_ERT') return error(409, 'INSUFFICIENT_ERT');
        throw cause;
      } finally { client.release(); }
    },
    async preview(token, ringId, body) {
      const bound = await identity(token, ringId, body, false);
      if (bound.failure) return bound.failure;
      const { accountId, input } = bound;
      const ring = await ownedRing(pool, accountId, bound.ringId, false);
      if (!ring) return error(404, 'RING_NOT_FOUND');
      if (ring.level !== input.expected) return error(409, 'RING_LEVEL_STALE');
      const price = transition(ring.level, input.target);
      if (!price) return error(400, 'RING_LEVEL_TRANSITION_INVALID');
      const resultingPoints = ring.unspent_attribute_points + GRANTED_POINTS;
      if (resultingPoints > 76) return error(503, 'RING_LEVEL_STATE_UNAVAILABLE');
      const balance = await ertBalance(pool, accountId);
      const affordableErt = new ErtDecimal(balance.available).greaterThanOrEqualTo(price.ert);
      const blockers = [];
      if (!affordableErt) blockers.push('INSUFFICIENT_ERT');
      if (price.eru && !eruEnabled) blockers.push('ERU_SETTLEMENT_UNAVAILABLE');
      const currentAttributes = attributes(ring);
      return { status: 200, body: { rulesVersion: VERSION, ringId: bound.ringId,
        current: { level: ring.level, attributes: currentAttributes,
          unspentAttributePoints: ring.unspent_attribute_points },
        target: { level: input.target, attributes: currentAttributes,
          unspentAttributePoints: resultingPoints },
        grantedAttributePoints: GRANTED_POINTS,
        cost: { ert: price.ert, ertExact: canonicalErt(String(price.ert)),
          ertDisplay: displayErt(String(price.ert)), eru: price.eru,
          eruExact: String(price.eru) },
        balances: { ertExact: balance.balance, ertAvailableExact: balance.available,
          eruExact: null },
        affordability: { ert: affordableErt, eru: price.eru ? null : true },
        dependencies: { ertLedger: { required: true, available: true },
          eruSettlement: { required: !!price.eru, available: price.eru ? eruEnabled : null } },
        available: blockers.length === 0, blockers,
        milestone: milestone(input.target) } };
    },

    async levelUp(token, ringId, body) {
      const bound = await identity(token, ringId, body, true);
      if (bound.failure) return bound.failure;
      const { accountId, input } = bound;
      const digest = fingerprint(accountId, bound.ringId, input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Preserve MVP lock order: account -> operation -> ring -> ERT account.
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
        const operationId = randomUUID();
        await client.query(`INSERT INTO alpha_cooper_level_up_operations
          (id,account_id,ring_id,idempotency_key,request_fingerprint,rules_version)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (account_id,idempotency_key) DO NOTHING`,
        [operationId, accountId, bound.ringId, input.key, digest, VERSION]);
        const operation = (await client.query(`SELECT id, ring_id, request_fingerprint,
            rules_version, response_snapshot FROM alpha_cooper_level_up_operations
          WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [accountId, input.key])).rows[0];
        if (!operation || operation.rules_version !== VERSION) {
          await client.query('ROLLBACK');
          return error(503, 'RING_LEVEL_WRITE_UNAVAILABLE');
        }
        if (operation.request_fingerprint !== digest || operation.ring_id !== bound.ringId) {
          await client.query('ROLLBACK');
          return error(409, 'RING_LEVEL_IDEMPOTENCY_CONFLICT');
        }
        if (operation.response_snapshot) {
          await client.query('COMMIT');
          return { status: 200, body: operation.response_snapshot };
        }
        const ring = await ownedRing(client, accountId, bound.ringId, true);
        if (!ring) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
        if (ring.level !== input.expected) {
          await client.query('ROLLBACK'); return error(409, 'RING_LEVEL_STALE');
        }
        const price = transition(ring.level, input.target);
        if (!price) {
          await client.query('ROLLBACK'); return error(400, 'RING_LEVEL_TRANSITION_INVALID');
        }
        // Hybrid ERU steps must not partially debit ERT or grant Points.
        if (price.eru) {
          await client.query('ROLLBACK'); return error(409, 'ERU_SETTLEMENT_UNAVAILABLE');
        }
        const resultingPoints = ring.unspent_attribute_points + GRANTED_POINTS;
        if (resultingPoints > 76) {
          await client.query('ROLLBACK'); return error(503, 'RING_LEVEL_STATE_UNAVAILABLE');
        }
        await client.query(`INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)
          ON CONFLICT DO NOTHING`, [accountId]);
        await client.query(`SELECT account_id FROM alpha_ert_accounts
          WHERE account_id = $1 FOR UPDATE`, [accountId]);
        const before = await ertBalance(client, accountId);
        if (new ErtDecimal(before.available).lessThan(price.ert)) {
          await client.query('ROLLBACK'); return error(409, 'INSUFFICIENT_ERT');
        }
        const ledgerId = randomUUID();
        const cost = canonicalErt(String(price.ert));
        await client.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
          VALUES ($1,$2,$3,$4::numeric)`,
        [ledgerId, accountId, `cooper-level-up:${operation.id}`, `-${cost}`]);
        await client.query(`UPDATE alpha_cooper_current_state
          SET level = $3, unspent_attribute_points = $4, updated_at = now()
          WHERE account_id = $1 AND ring_id = $2`,
        [accountId, bound.ringId, input.target, resultingPoints]);
        const after = await ertBalance(client, accountId);
        const snapshot = { operationId: operation.id, rulesVersion: VERSION,
          ringId: bound.ringId, idempotencyKey: input.key,
          level: { previous: ring.level, current: input.target },
          unspentAttributePoints: { previous: ring.unspent_attribute_points,
            granted: GRANTED_POINTS, current: resultingPoints },
          attributes: attributes(ring),
          cost: { ert: price.ert, ertExact: cost,
            ertDisplay: displayErt(cost), eru: 0, eruExact: '0' },
          balances: { ertBeforeExact: before.balance, ertAfterExact: after.balance,
            ertAvailableBeforeExact: before.available,
            ertAvailableAfterExact: after.available,
            eruBeforeExact: null, eruAfterExact: null },
          ledgerTransactionId: ledgerId,
          ledgerTransactionIds: { ert: ledgerId, eru: null } };
        await client.query(`INSERT INTO alpha_cooper_level_up_events
          (id,account_id,ring_id,operation_id,ledger_id,event_type,operation_key,
           rules_version,snapshot)
          VALUES ($1,$2,$3,$4,$5,'LEVEL_UP',$6,$7,$8::jsonb)`,
        [randomUUID(), accountId, bound.ringId, operation.id, ledgerId,
          `level-up:${operation.id}`, VERSION, JSON.stringify(snapshot)]);
        await client.query(`UPDATE alpha_cooper_level_up_operations
          SET response_snapshot = $2::jsonb, completed_at = now() WHERE id = $1`,
        [operation.id, JSON.stringify(snapshot)]);
        await client.query('COMMIT');
        return { status: 200, body: snapshot };
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally { client.release(); }
    },
  };
}
