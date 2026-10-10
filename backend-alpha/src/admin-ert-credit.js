import { randomUUID } from 'node:crypto';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from './m2e-ert-decimal.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BAD = { status: 400, body: { code: 'INVALID_ADMIN_CREDIT' } };
const DENIED = { status: 403, body: { code: 'ADMIN_REQUIRED' } };
const MISSING = { status: 404, body: { code: 'TARGET_ACCOUNT_NOT_FOUND' } };
const CONFLICT = { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };

function requestInput(body) {
  if (!body || Object.keys(body).sort().join(',') !==
      'amountExact,idempotencyKey,reason,targetAccountId' ||
      !UUID_V4.test(body.idempotencyKey) || !UUID_V4.test(body.targetAccountId) ||
      typeof body.reason !== 'string' || body.reason.length < 1 ||
      body.reason.length > 512 || body.reason !== body.reason.trim() ||
      /[\x00-\x1f\x7f]/.test(body.reason)) return null;
  try {
    const amount = parseUnsignedErtDecimal(body.amountExact, 'amountExact', false);
    if (amount.greaterThanOrEqualTo(new ErtDecimal('1e30')) ||
        canonicalErt(amount) !== body.amountExact) return null;
    return { id: body.idempotencyKey, targetAccountId: body.targetAccountId,
      amountExact: body.amountExact, reason: body.reason };
  } catch { return null; }
}

export function createAdminErtCredit({ pool, auth }) {
  return { async credit(token, body) {
    const session = await auth.me(token);
    if (session.status !== 200) return session;
    const input = requestInput(body);
    if (!input) return BAD;
    const actorId = session.body.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One operation key serializes retries even if they name different targets.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 91823))', [input.id]);
      const accounts = (await client.query(
        `SELECT id, is_admin, verified_at FROM alpha_accounts
         WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
        [actorId, input.targetAccountId])).rows;
      const actor = accounts.find(row => row.id === actorId);
      const target = accounts.find(row => row.id === input.targetAccountId);
      if (!actor?.verified_at || !actor.is_admin) {
        await client.query('ROLLBACK');
        return DENIED;
      }
      if (!target?.verified_at) {
        await client.query('ROLLBACK');
        return MISSING;
      }
      const prior = (await client.query(
        `SELECT actor_account_id, target_account_id, amount::text AS amount,
                reason, result_snapshot FROM alpha_ert_admin_credits WHERE id = $1`,
        [input.id])).rows[0];
      if (prior) {
        await client.query('COMMIT');
        if (prior.actor_account_id !== actorId ||
            prior.target_account_id !== input.targetAccountId ||
            canonicalErt(prior.amount) !== input.amountExact ||
            prior.reason !== input.reason) return CONFLICT;
        return { status: 200, body: { ...prior.result_snapshot, replay: true } };
      }
      await client.query(
        `INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)
         ON CONFLICT DO NOTHING`, [input.targetAccountId]);
      const ledgerId = randomUUID();
      await client.query(
        `INSERT INTO alpha_ert_ledger(id, account_id, event_key, amount)
         VALUES ($1, $2, $3, $4::numeric)`,
        [ledgerId, input.targetAccountId, `admin-credit:${input.id}`, input.amountExact]);
      const current = (await client.query(
        `SELECT balance::text AS balance, available::text AS available
         FROM alpha_ert_available WHERE account_id = $1`,
        [input.targetAccountId])).rows[0];
      const snapshot = { operationId: input.id, targetAccountId: input.targetAccountId,
        ledgerId, amountExact: input.amountExact,
        amountDisplay: displayErt(input.amountExact),
        balanceAfterExact: canonicalErt(current.balance),
        availableAfterExact: canonicalErt(current.available) };
      await client.query(
        `INSERT INTO alpha_ert_admin_credits
         (id, actor_account_id, target_account_id, amount, reason, ledger_id, result_snapshot)
         VALUES ($1, $2, $3, $4::numeric, $5, $6, $7::jsonb)`,
        [input.id, actorId, input.targetAccountId, input.amountExact,
          input.reason, ledgerId, JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return { status: 200, body: { ...snapshot, replay: false } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } };
}
