import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { silverRingIsListed } from './silver-listed-eligibility.js';
import { recordM2eComfortChange } from './m2e-comfort-epochs.js';

const VERSION = 'alpha-ring-equipment-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const BAD_REQUEST = { status: 400, body: { code: 'RING_EQUIPMENT_REQUEST_INVALID' } };
const UNAUTHORIZED = { status: 401, body: { code: 'AUTH_REQUIRED' } };
const UNBOUND = { status: 409, body: { code: 'WALLET_BINDING_REQUIRED' } };
const STALE = { status: 409, body: { code: 'RING_EQUIPMENT_STALE' } };
const UNAVAILABLE = { status: 503, body: { code: 'RING_EQUIPMENT_CHAIN_UNKNOWN' } };

function mint(value) {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch { return false; }
}

function key(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'id,kind') return null;
  if (input.kind === 'COOPER' && typeof input.id === 'string' && UUID.test(input.id))
    return { kind: 'COOPER', id: input.id };
  if (input.kind === 'SILVER_RING' && mint(input.id))
    return { kind: 'SILVER_RING', id: input.id };
  return null;
}

function requestBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'contractVersion,expectedCurrent,expectedVersion,idempotencyKey,target') return null;
  const target = key(input.target);
  const expectedCurrent = key(input.expectedCurrent);
  if (input.contractVersion !== VERSION || !target || !expectedCurrent ||
      typeof input.idempotencyKey !== 'string' || !UUID.test(input.idempotencyKey) ||
      typeof input.expectedVersion !== 'string' ||
      !/^[1-9][0-9]*$/.test(input.expectedVersion) ||
      BigInt(input.expectedVersion) > 9223372036854775807n) return null;
  return { target, expectedCurrent, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey };
}

function selected(row) {
  return { kind: row.ring_kind, id: row.ring_id };
}

function same(a, b) { return a.kind === b.kind && a.id === b.id; }

function snapshot(row, eligibility) {
  return { selection: selected(row), version: String(row.version),
    equippedAt: row.equipped_at, eligibility,
    effectsEnabled: eligibility === 'ELIGIBLE' };
}

export function createRingEquipment({ pool, chain, marketReader = null, programId, cluster, walletEnvironment,
  now = () => new Date() }) {
  if (!pool || typeof chain?.readEquipmentEligibility !== 'function' || !mint(programId) ||
      !['devnet', 'local-validator'].includes(cluster) ||
      !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? ''))
    throw new Error('Ring equipment requires isolated Alpha account and canonical Silver reader');

  async function account(client, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const digest = createHash('sha256').update(token, 'ascii').digest('hex');
    return (await client.query(`SELECT a.id, b.wallet_address, b.environment
      FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
      LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL
      FOR UPDATE OF a`, [digest, now()])).rows[0] ?? null;
  }

  async function eligibility(walletAddress, ringId) {
    try {
      if (await silverRingIsListed(marketReader, ringId)) return { state: 'LISTED' };
      const result = await chain.readEquipmentEligibility({ programId, cluster,
        walletAddress, mintAddress: ringId });
      if (result?.state === 'TRANSFERRED_AWAY' || result?.state === 'COOLDOWN') return result;
      const ring = result?.ring;
      if (result?.state === 'ELIGIBLE' && ring?.finalized === true &&
          ring.kind === 'SILVER_RING' && ring.programId === programId &&
          ring.cluster === cluster && ring.mintAddress === ringId &&
          ring.tokenOwner === walletAddress) return result;
    } catch { /* An unavailable or disagreeing provider is UNKNOWN, not a transfer. */ }
    return { state: 'UNKNOWN' };
  }

  async function starter(client, accountId) {
    return (await client.query(`SELECT s.ring_id, p.comfort FROM alpha_starter_cooper s
      JOIN alpha_cooper_current_state p ON p.account_id = s.account_id AND p.ring_id = s.ring_id
      WHERE s.account_id = $1`,
      [accountId])).rows[0] ?? null;
  }

  async function ownedCooper(client, accountId, ringId) {
    return (await client.query(`SELECT s.ring_id::text AS ring_id, p.comfort
      FROM alpha_starter_cooper s JOIN alpha_cooper_current_state p
        ON p.account_id = s.account_id AND p.ring_id = s.ring_id
      WHERE s.account_id = $1 AND s.ring_id = $2::uuid
      UNION ALL
      SELECT d.ring_id::text AS ring_id, p.comfort
      FROM alpha_draw_cooper_rings d JOIN alpha_cooper_current_state p
        ON p.account_id = d.account_id AND p.ring_id = d.ring_id
      WHERE d.account_id = $1 AND d.ring_id = $2::uuid
      UNION ALL
      SELECT g.ring_id::text AS ring_id, p.comfort
      FROM alpha_admin_cooper_rings g JOIN alpha_cooper_current_state p
        ON p.account_id = g.account_id AND p.ring_id = g.ring_id
      WHERE g.account_id = $1 AND g.ring_id = $2::uuid`,
    [accountId, ringId])).rows[0] ?? null;
  }

  async function lockedSelection(client, accountId) {
    return (await client.query('SELECT * FROM alpha_ring_selection WHERE account_id = $1 FOR UPDATE',
      [accountId])).rows[0] ?? null;
  }

  async function transaction(token, work, requireWallet = true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await account(client, token);
      if (!user) { await client.query('ROLLBACK'); return UNAUTHORIZED; }
      if (requireWallet && (!user.wallet_address || user.environment !== walletEnvironment)) {
        await client.query('ROLLBACK'); return UNBOUND;
      }
      const result = await work(client, user);
      if (result.status === 200) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function reconcileSelection(client, user) {
    let row = await lockedSelection(client, user.id);
    if (!row) return { status: 409, body: { code: 'RING_SELECTION_MISSING' } };
    if (row.ring_kind !== 'SILVER_RING') {
      const owned = await ownedCooper(client, user.id, row.ring_id);
      if (!owned)
        return { status: 409, body: { code: 'RING_SELECTION_INVALID' } };
      return { status: 200, body: snapshot(row, 'ELIGIBLE') };
    }
    const verified = user.wallet_address && user.environment === walletEnvironment
      ? await eligibility(user.wallet_address, row.ring_id) : { state: 'UNKNOWN' };
    if (verified.state === 'UNKNOWN')
      return { status: 200, body: snapshot(row, 'UNKNOWN') };
    if (verified.state === 'ELIGIBLE')
      return { status: 200, body: snapshot(row, 'ELIGIBLE') };
    const owned = await starter(client, user.id);
    if (!owned) return { status: 409, body: { code: 'STARTER_COOPER_MISSING' } };
    const previous = selected(row);
    const changedAt = now();
    await client.query(`UPDATE alpha_ring_selection
      SET ring_kind = 'COOPER', ring_id = $2, version = version + 1,
          equipped_at = $3, updated_at = $3 WHERE account_id = $1`,
    [user.id, owned.ring_id, changedAt]);
    await client.query(`INSERT INTO alpha_ring_equipment_events
      (id, account_id, operation_key, event_type, previous_kind, previous_id,
       current_kind, current_id, reason)
       VALUES ($1,$2,$3,'FALLBACK',$4,$5,'COOPER',$6,$7)`,
    [randomUUID(), user.id, `fallback:${row.version}`, previous.kind, previous.id,
      owned.ring_id, verified.state]);
    await recordM2eComfortChange(client, { accountId: user.id,
      sourceKey: `fallback:${row.version}`, previous: null,
      current: { kind: 'COOPER', id: owned.ring_id, comfort: owned.comfort },
      effectiveAt: changedAt });
    row = { ...row, ring_kind: 'COOPER', ring_id: owned.ring_id,
      version: (BigInt(row.version) + 1n).toString(), equipped_at: changedAt };
    return { status: 200, body: { ...snapshot(row, 'ELIGIBLE'),
      fallbackReason: verified.state } };
  }

  return {
    // Trusted caller only: the client transaction must already hold this account lock.
    reconcileInTransaction: reconcileSelection,
    async current(token) {
      return transaction(token, reconcileSelection, false);
    },

    async equip(token, body) {
      const input = requestBody(body);
      if (!input) return BAD_REQUEST;
      return transaction(token, async (client, user) => {
        const fingerprint = createHash('sha256').update(JSON.stringify({
          accountId: user.id, contractVersion: VERSION, ...input,
        })).digest('hex');
        const existing = (await client.query(`SELECT request_fingerprint, response_snapshot
          FROM alpha_ring_equipment_operations
          WHERE account_id = $1 AND idempotency_key = $2`,
        [user.id, input.idempotencyKey])).rows[0];
        if (existing) return existing.request_fingerprint === fingerprint ?
          { status: 200, body: { ...existing.response_snapshot, replay: true } } :
          { status: 409, body: { code: 'RING_EQUIPMENT_IDEMPOTENCY_CONFLICT' } };
        const row = await lockedSelection(client, user.id);
        if (!row || !same(selected(row), input.expectedCurrent) ||
            String(row.version) !== input.expectedVersion) return STALE;
        let targetComfort;
        if (input.target.kind === 'COOPER') {
          const owned = await ownedCooper(client, user.id, input.target.id);
          if (!owned)
            return { status: 404, body: { code: 'COOPER_NOT_OWNED' } };
          targetComfort = owned.comfort;
        } else {
          const verified = await eligibility(user.wallet_address, input.target.id);
          if (verified.state === 'UNKNOWN') return UNAVAILABLE;
          if (verified.state === 'LISTED')
            return { status: 409, body: { code: 'SILVER_RING_LISTED' } };
          if (verified.state === 'COOLDOWN' &&
              /^[1-9][0-9]*$/.test(verified.cooldownUntilUnixSeconds ?? ''))
            return { status: 409, body: { code: 'SILVER_RING_COOLDOWN',
              cooldownUntilUnixSeconds: verified.cooldownUntilUnixSeconds } };
          if (verified.state !== 'ELIGIBLE')
            return { status: 409, body: { code: 'SILVER_RING_INELIGIBLE' } };
          targetComfort = verified.ring.comfort;
        }
        const previous = selected(row);
        const noChange = same(previous, input.target);
        const changedAt = now();
        const operationId = randomUUID();
        const nextVersion = noChange ? String(row.version) : (BigInt(row.version) + 1n).toString();
        if (!noChange) {
          await client.query(`UPDATE alpha_ring_selection
            SET ring_kind = $2, ring_id = $3, version = version + 1,
                equipped_at = $4, updated_at = $4 WHERE account_id = $1`,
          [user.id, input.target.kind, input.target.id, changedAt]);
          await client.query(`INSERT INTO alpha_ring_equipment_events
            (id, account_id, operation_key, event_type, previous_kind, previous_id,
             current_kind, current_id, reason)
            VALUES ($1,$2,$3,'EQUIP',$4,$5,$6,$7,'OWNER_COMMAND')`,
          [randomUUID(), user.id, `equip:${operationId}`, previous.kind, previous.id,
            input.target.kind, input.target.id]);
          const oldCooper = previous.kind === 'COOPER' ?
            await ownedCooper(client, user.id, previous.id) : null;
          await recordM2eComfortChange(client, { accountId: user.id,
            sourceKey: `equip:${operationId}`,
            previous: oldCooper ? { kind: 'COOPER', id: previous.id,
              comfort: oldCooper.comfort } : null,
            current: { ...input.target, comfort: targetComfort }, effectiveAt: changedAt });
        }
        const response = { operationId, contractVersion: VERSION, replay: false, noChange,
          previous, current: input.target, version: nextVersion,
          equippedAt: noChange ? row.equipped_at : changedAt };
        await client.query(`INSERT INTO alpha_ring_equipment_operations
          (id, account_id, idempotency_key, request_fingerprint, response_snapshot)
          VALUES ($1,$2,$3,$4,$5)`,
        [operationId, user.id, input.idempotencyKey, fingerprint, response]);
        return { status: 200, body: response };
      });
    }
  };
}
