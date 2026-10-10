import { createHash, randomUUID } from 'node:crypto';
import { recordM2eComfortChange } from './m2e-comfort-epochs.js';

// Alpha account/persistence adapter for MVP copper-attribute-allocation-v2.
const VERSION = 'copper-attribute-allocation-v2';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMES = Object.freeze(['comfort', 'charm', 'quality', 'luck']);
const MAX_POINTS = 76;
const error = (status, code) => ({ status, body: { code } });

function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'allocation,expectedUnspentPoints,idempotencyKey' ||
      !Number.isSafeInteger(input.expectedUnspentPoints) ||
      input.expectedUnspentPoints < 0 || input.expectedUnspentPoints > MAX_POINTS ||
      typeof input.idempotencyKey !== 'string' || !UUID_V4.test(input.idempotencyKey))
    return { failure: error(400, 'RING_ATTRIBUTE_ALLOCATION_REQUEST_INVALID') };
  if (!input.allocation || typeof input.allocation !== 'object' ||
      Array.isArray(input.allocation) ||
      Object.keys(input.allocation).sort().join(',') !== NAMES.slice().sort().join(','))
    return { failure: error(400, 'RING_ATTRIBUTE_ALLOCATION_INVALID') };
  const allocation = Object.fromEntries(NAMES.map(name => [name, input.allocation[name]]));
  const values = Object.values(allocation);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > MAX_POINTS))
    return { failure: error(400, 'RING_ATTRIBUTE_ALLOCATION_INVALID') };
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total < 1 || total > input.expectedUnspentPoints || total > MAX_POINTS)
    return { failure: error(400, 'RING_ATTRIBUTE_ALLOCATION_INVALID') };
  return { expected: input.expectedUnspentPoints,
    allocation, total, key: input.idempotencyKey.toLowerCase() };
}

function fingerprint(accountId, ringId, input) {
  return createHash('sha256').update(JSON.stringify({
    ownerUserId: accountId, ringId, expectedUnspentPoints: input.expected,
    allocation: input.allocation, rulesVersion: VERSION,
  })).digest('hex');
}

export function createCooperPointAllocation({ pool, auth }) {
  if (!pool || typeof auth?.me !== 'function')
    throw new Error('Cooper point allocation requires Alpha auth and PostgreSQL');
  return { async allocate(token, ringId, body) {
    const session = await auth.me(token);
    if (session.status !== 200) return session;
    const input = parse(body);
    if (input.failure) return input.failure;
    if (typeof ringId !== 'string' || !UUID_V4.test(ringId))
      return error(404, 'RING_NOT_FOUND');
    ringId = ringId.toLowerCase();
    const accountId = session.body.id;
    const digest = fingerprint(accountId, ringId, input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock order as MVP: owner -> operation -> owned Ring.
      const owner = (await client.query(`SELECT id FROM alpha_accounts
        WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
      if (!owner) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
      const operationId = randomUUID();
      await client.query(`INSERT INTO alpha_cooper_point_allocations
        (id, account_id, ring_id, idempotency_key, request_fingerprint, rules_version)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id,idempotency_key) DO NOTHING`,
      [operationId, accountId, ringId, input.key, digest, VERSION]);
      const operation = (await client.query(`SELECT id, ring_id, request_fingerprint,
          rules_version, response_snapshot FROM alpha_cooper_point_allocations
        WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [accountId, input.key])).rows[0];
      if (!operation || operation.rules_version !== VERSION) {
        await client.query('ROLLBACK');
        return error(503, 'RING_ATTRIBUTE_ALLOCATION_WRITE_UNAVAILABLE');
      }
      if (operation.request_fingerprint !== digest || operation.ring_id !== ringId) {
        await client.query('ROLLBACK');
        return error(409, 'RING_ATTRIBUTE_ALLOCATION_IDEMPOTENCY_CONFLICT');
      }
      if (operation.response_snapshot) {
        await client.query('COMMIT');
        return { status: 200, body: operation.response_snapshot };
      }
      const ring = (await client.query(`SELECT comfort, charm, quality, luck,
          unspent_attribute_points FROM alpha_cooper_current_state
        WHERE account_id = $1 AND ring_id = $2 FOR UPDATE`,
      [accountId, ringId])).rows[0];
      if (!ring) { await client.query('ROLLBACK'); return error(404, 'RING_NOT_FOUND'); }
      if (ring.unspent_attribute_points !== input.expected) {
        await client.query('ROLLBACK');
        return error(409, 'RING_ATTRIBUTE_POINTS_STALE');
      }
      if (input.total > ring.unspent_attribute_points) {
        await client.query('ROLLBACK');
        return error(409, 'RING_ATTRIBUTE_POINTS_INSUFFICIENT');
      }
      const before = Object.fromEntries(NAMES.map(name => [name, ring[name]]));
      const after = Object.fromEntries(NAMES.map(name => [name,
        before[name] + input.allocation[name]]));
      const remaining = ring.unspent_attribute_points - input.total;
      await client.query(`UPDATE alpha_cooper_current_state
        SET comfort = $3, charm = $4, quality = $5, luck = $6,
          unspent_attribute_points = $7, updated_at = now()
        WHERE account_id = $1 AND ring_id = $2`,
      [accountId, ringId, after.comfort, after.charm, after.quality, after.luck, remaining]);
      const snapshot = { operationId: operation.id, rulesVersion: VERSION, ringId,
        idempotencyKey: input.key, allocation: input.allocation,
        attributes: { previous: before, current: after },
        unspentAttributePoints: { previous: input.expected, spent: input.total,
          current: remaining } };
      await client.query(`INSERT INTO alpha_cooper_point_events
        (id, account_id, ring_id, allocation_id, event_type, operation_key,
         rules_version, snapshot)
        VALUES ($1,$2,$3,$4,'ATTRIBUTE_POINTS_ALLOCATED',$5,$6,$7::jsonb)`,
      [randomUUID(), accountId, ringId, operation.id,
        `attribute-allocation:${operation.id}`, VERSION, JSON.stringify(snapshot)]);
      if (after.comfort !== before.comfort) {
        const selection = (await client.query(`SELECT ring_kind, ring_id
          FROM alpha_ring_selection WHERE account_id = $1`, [accountId])).rows[0];
        if (selection?.ring_kind === 'COOPER' && selection.ring_id === ringId)
          await recordM2eComfortChange(client, { accountId,
            sourceKey: `cooper-points:${operation.id}`,
            previous: { kind: 'COOPER', id: ringId, comfort: before.comfort },
            current: { kind: 'COOPER', id: ringId, comfort: after.comfort } });
      }
      await client.query(`UPDATE alpha_cooper_point_allocations
        SET response_snapshot = $2::jsonb, completed_at = now() WHERE id = $1`,
      [operation.id, JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return { status: 200, body: snapshot };
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally { client.release(); }
  } };
}
