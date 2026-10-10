const DENIED = { status: 403, body: { code: 'ADMIN_REQUIRED' } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createAdminDashboard({ pool, auth,
  adminEruEnabled = false, adminBoxEnabled = false,
  adminCooperEnabled = false }) {
  if (!pool?.query || !auth?.me) throw new Error('Admin dashboard requires Alpha database and auth');
  async function check(token) {
    const session = await auth.me(token);
    if (session.status !== 200) return { error: session };
    const row = (await pool.query(`SELECT is_admin, verified_at FROM alpha_accounts
      WHERE id = $1`, [session.body.id])).rows[0];
    return row?.is_admin && row.verified_at ? { id: session.body.id } : { error: DENIED };
  }
  return {
    async overview(token) {
      const actor = await check(token);
      if (actor.error) return actor.error;
      const queries = {
        accounts: `SELECT count(*)::text AS registered,
          count(*) FILTER (WHERE verified_at IS NOT NULL)::text AS verified
          FROM alpha_accounts`,
        wallets: `SELECT count(*)::text AS bound FROM alpha_wallet_bindings`,
        movement: `SELECT coalesce(sum(accepted_steps),0)::text AS accepted_steps,
          coalesce(sum(earned_ert),0)::text AS earned_ert,
          count(DISTINCT account_id)::text AS participants
          FROM alpha_m2e_daily_stats`,
        economy: `SELECT coalesce(sum(amount) FILTER (WHERE amount > 0),0)::text AS credited_ert,
          coalesce(-sum(amount) FILTER (WHERE amount < 0),0)::text AS spent_ert
          FROM alpha_ert_ledger`,
        draw: `SELECT count(*)::text AS attempts FROM alpha_draw_operations`,
        drawRewards: `SELECT selected_reward_type AS type, count(*)::text AS count
          FROM alpha_draw_results GROUP BY selected_reward_type ORDER BY selected_reward_type`,
        cooper: `SELECT count(*)::text AS rings FROM (
          SELECT ring_id FROM alpha_starter_cooper
          UNION SELECT ring_id FROM alpha_draw_cooper_rings
          UNION SELECT ring_id FROM alpha_admin_cooper_rings) owned`,
        boxes: `SELECT
          (SELECT count(*) FROM alpha_silver_first_entry WHERE status = 'confirmed')::text
            AS first_entry,
          (SELECT count(*) FROM alpha_draw_fulfillments
            WHERE reward_type = 'SILVER_BOX' AND state = 'CONFIRMED')::text AS draw,
          (SELECT count(*) FROM alpha_cooper_breeding_settlements)::text AS breeding`,
        openings: `SELECT count(*)::text AS finalized
          FROM alpha_silver_opening_finalizations WHERE status = 'confirmed'`,
        marketplace: `SELECT count(*)::text AS submissions
          FROM alpha_silver_marketplace_submissions`,
        marketplaceActions: `SELECT action, count(*)::text AS count
          FROM alpha_silver_marketplace_submissions GROUP BY action ORDER BY action`,
        transfers: `SELECT count(*)::text AS submissions
          FROM alpha_silver_direct_transfer_submissions`,
        progression: `SELECT
          (SELECT count(*) FROM alpha_cooper_level_up_events)::text AS cooper_level_events,
          (SELECT count(*) FROM alpha_cooper_point_allocations)::text AS cooper_point_allocations,
          (SELECT count(*) FROM alpha_silver_progression_operations)::text AS silver_progression_operations,
          (SELECT count(*) FROM alpha_silver_allocation_submissions)::text AS silver_point_submissions,
          (SELECT count(*) FROM alpha_cooper_breeding_settlements)::text AS breeding_settlements`,
        supportGrants: `SELECT
          (SELECT count(*) FROM alpha_ert_admin_credits)::text AS ert_credits,
          (SELECT count(*) FROM alpha_admin_cooper_rings)::text AS cooper_rings`,
      };
      if (adminEruEnabled) queries.adminEru = `SELECT state, count(*)::text AS count
        FROM alpha_admin_eru_transfers GROUP BY state ORDER BY state`;
      if (adminBoxEnabled) queries.adminBoxes = `SELECT state, count(*)::text AS count
        FROM alpha_admin_box_grants GROUP BY state ORDER BY state`;
      if (adminBoxEnabled) queries.adminBoxCount = `SELECT count(*)::text AS confirmed
        FROM alpha_admin_box_grants WHERE state = 'CONFIRMED'`;
      const entries = await Promise.all(Object.entries(queries).map(async ([name, sql]) =>
        [name, (await pool.query(sql)).rows]));
      const body = Object.fromEntries(entries.map(([name, rows]) =>
        [name, ['drawRewards', 'adminEru', 'adminBoxes', 'marketplaceActions']
          .includes(name) ? rows : rows[0]]));
      body.adminEru = body.adminEru ?? [];
      body.adminBoxes = body.adminBoxes ?? [];
      body.adminEruEnabled = adminEruEnabled;
      body.adminBoxEnabled = adminBoxEnabled;
      body.adminCooperEnabled = adminCooperEnabled;
      return { status: 200, body };
    },
    async users(token, search = '') {
      const actor = await check(token);
      if (actor.error) return actor.error;
      if (typeof search !== 'string' || search.length > 128)
        return { status: 400, body: { code: 'INVALID_USER_SEARCH' } };
      const rows = (await pool.query(`SELECT a.id, a.email_normalized,
          a.verified_at, a.created_at, b.wallet_address,
          coalesce(e.balance,0)::text AS ert_balance,
          coalesce(e.available,0)::text AS ert_available,
          coalesce(s.steps,0)::text AS accepted_steps
        FROM alpha_accounts a
        LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
        LEFT JOIN alpha_ert_available e ON e.account_id = a.id
        LEFT JOIN (SELECT account_id, sum(accepted_steps) AS steps
          FROM alpha_m2e_daily_stats GROUP BY account_id) s ON s.account_id = a.id
        WHERE $1 = '' OR a.email_normalized ILIKE '%' || $1 || '%'
        ORDER BY a.created_at DESC LIMIT 50`, [search.trim()])).rows;
      return { status: 200, body: { users: rows.map(row => ({
        id: row.id, email: row.email_normalized,
        verified: Boolean(row.verified_at), walletAddress: row.wallet_address,
        ertBalanceExact: row.ert_balance, ertAvailableExact: row.ert_available,
        acceptedSteps: row.accepted_steps,
        createdAt: new Date(row.created_at).toISOString(),
      })) } };
    },
    async user(token, id) {
      const actor = await check(token);
      if (actor.error) return actor.error;
      if (!UUID.test(id ?? '')) return { status: 400, body: { code: 'INVALID_ACCOUNT_ID' } };
      const row = (await pool.query(`SELECT a.id, a.email_normalized, a.verified_at,
          a.created_at, b.wallet_address FROM alpha_accounts a
        LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
        WHERE a.id = $1`, [id])).rows[0];
      if (!row) return { status: 404, body: { code: 'ACCOUNT_NOT_FOUND' } };
      const [movement, draws, ert] = await Promise.all([
        pool.query(`SELECT coalesce(sum(accepted_steps),0)::text AS accepted_steps,
          coalesce(sum(earned_ert),0)::text AS earned_ert
          FROM alpha_m2e_daily_stats WHERE account_id = $1`, [id]),
        pool.query(`SELECT count(*)::text AS attempts FROM alpha_draw_operations
          WHERE account_id = $1`, [id]),
        pool.query(`SELECT balance::text, available::text
          FROM alpha_ert_available WHERE account_id = $1`, [id]),
      ]);
      return { status: 200, body: {
        id: row.id, email: row.email_normalized,
        verified: Boolean(row.verified_at), walletAddress: row.wallet_address,
        createdAt: new Date(row.created_at).toISOString(),
        movement: movement.rows[0], draw: draws.rows[0],
        ert: ert.rows[0] ?? { balance: '0', available: '0' },
      } };
    },
  };
}
