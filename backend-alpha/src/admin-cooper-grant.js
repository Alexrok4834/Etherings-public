import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID = { status: 400, body: { code: 'INVALID_ADMIN_COOPER_GRANT' } };
const DENIED = { status: 403, body: { code: 'ADMIN_REQUIRED' } };
const CONFLICT = { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };

export function createAdminCooperGrant({ pool, auth }) {
  if (!pool?.connect || !auth?.me) throw new Error('Admin Cooper grant requires Alpha database and auth');
  return { async grant(token, body) {
    const session = await auth.me(token);
    if (session.status !== 200) return session;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'idempotencyKey,reason,targetAccountId' ||
        !UUID.test(body.idempotencyKey ?? '') || !UUID.test(body.targetAccountId ?? '') ||
        typeof body.reason !== 'string' || body.reason !== body.reason.trim() ||
        body.reason.length < 1 || body.reason.length > 512 ||
        /[\x00-\x1f\x7f]/.test(body.reason)) return INVALID;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 91824))',
        [body.idempotencyKey]);
      const accounts = (await client.query(`SELECT id, is_admin, verified_at
        FROM alpha_accounts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`,
      [session.body.id, body.targetAccountId])).rows;
      const actor = accounts.find(row => row.id === session.body.id);
      const target = accounts.find(row => row.id === body.targetAccountId);
      if (!actor?.is_admin || !actor.verified_at) {
        await client.query('ROLLBACK'); return DENIED;
      }
      if (!target?.verified_at) {
        await client.query('ROLLBACK');
        return { status: 404, body: { code: 'TARGET_ACCOUNT_NOT_FOUND' } };
      }
      const prior = (await client.query(`SELECT ring_id, account_id, actor_account_id,
        reason FROM alpha_admin_cooper_rings WHERE operation_id = $1`,
      [body.idempotencyKey])).rows[0];
      if (prior) {
        await client.query('COMMIT');
        return prior.account_id === target.id && prior.actor_account_id === actor.id &&
          prior.reason === body.reason ? { status: 200, body: {
            operationId: body.idempotencyKey, ringId: prior.ring_id, replay: true,
          } } : CONFLICT;
      }
      const starter = (await client.query(`SELECT ring_id, visual_variant_code,
        comfort, charm, quality, luck FROM alpha_starter_cooper
        WHERE account_id = $1`, [target.id])).rows[0];
      if (!starter) {
        await client.query('ROLLBACK');
        return { status: 409, body: { code: 'STARTER_COOPER_REQUIRED' } };
      }
      const ringId = randomUUID();
      await client.query(`INSERT INTO alpha_admin_cooper_rings
        (ring_id,account_id,actor_account_id,operation_id,reason,source_ring_id,
         issuance_reason,visual_variant_code,comfort,charm,quality,luck)
        VALUES ($1,$2,$3,$4,$5,$6,'admin-grant',$7,$8,$9,$10,$11)`,
      [ringId, target.id, actor.id, body.idempotencyKey, body.reason,
        starter.ring_id, starter.visual_variant_code, starter.comfort,
        starter.charm, starter.quality, starter.luck]);
      await client.query(`INSERT INTO alpha_cooper_current_state
        (account_id,ring_id,level,shine,comfort,charm,quality,luck)
        VALUES ($1,$2,1,100,$3,$4,$5,$6)`,
      [target.id, ringId, starter.comfort, starter.charm, starter.quality, starter.luck]);
      await client.query('COMMIT');
      return { status: 200, body: { operationId: body.idempotencyKey,
        ringId, replay: false } };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  } };
}
