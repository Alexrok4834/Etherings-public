import { canonicalErt, displayErt } from './m2e-ert-decimal.js';
import { createM2eBalanceConfig } from './m2e-balance-config.js';
import { calculateM2eEarning } from './m2e-earning-calculator.js';

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

// Read-only account economy projection. The cap exists only after the immutable
// daily snapshot is created; never infer it from client steps or a prior day.
export function createM2eProfile({ pool, auth, resolveEligibleRingCount,
  config = createM2eBalanceConfig({}) }) {
  return { async today(token, query) {
    if (query.size !== 1 || !validDate(query.get('date')))
      return { status: 400, body: { code: 'INVALID_DATE' } };
    const owner = await auth.me(token);
    if (owner.status !== 200) return owner;
    const date = query.get('date');
    const row = (await pool.query(`SELECT COALESCE(e.available, 0)::text AS ert_balance,
      s.step_cap, s.base_steps, s.extra_steps_per_ring FROM alpha_accounts a
      LEFT JOIN alpha_ert_available e ON e.account_id = a.id
      LEFT JOIN alpha_m2e_daily_snapshots s
        ON s.account_id = a.id AND s.accounting_date = $2
      WHERE a.id = $1`, [owner.body.id, date])).rows[0];
    if (!row) return { status: 401, body: { message: 'Unauthorized.' } };
    const exact = canonicalErt(row.ert_balance);
    let dailyStepCap = null;
    try {
      const ringCount = await resolveEligibleRingCount(owner.body.id);
      const capConfig = row.step_cap === null ? config : { ...config,
        baseSteps: row.base_steps, extraStepsPerRing: row.extra_steps_per_ring };
      dailyStepCap = calculateM2eEarning({ validatedDailySteps: 0,
        ringCount, comfort: 0 }, capConfig).stepCap;
    } catch { /* UNKNOWN must not present the historical snapshot cap as current. */ }
    return { status: 200, body: { date, ertBalanceExact: exact,
      ertBalanceDisplay: displayErt(exact), dailyStepCap } };
  }, async history(token, query) {
    if (query.size !== 2 || !validDate(query.get('from')) || !validDate(query.get('to')))
      return { status: 400, body: { code: 'INVALID_ACTIVITY_RANGE' } };
    const from = query.get('from');
    const to = query.get('to');
    const days = (Date.parse(`${to}T00:00:00.000Z`) -
      Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
    if (days < 1 || days > 31)
      return { status: 400, body: { code: 'INVALID_ACTIVITY_RANGE' } };
    const owner = await auth.me(token);
    if (owner.status !== 200) return owner;
    const rows = (await pool.query(`SELECT d.accounting_date::text AS date,
      d.accepted_steps, d.earned_ert::text AS earned_ert, s.step_cap
      FROM alpha_m2e_daily_stats d
      JOIN alpha_m2e_daily_snapshots s
        ON s.id = d.snapshot_id AND s.account_id = d.account_id
      WHERE d.account_id = $1 AND d.accounting_date BETWEEN $2 AND $3
      ORDER BY d.accounting_date DESC`, [owner.body.id, from, to])).rows;
    return { status: 200, body: { from, to, days: rows.map(row => {
      const exact = canonicalErt(row.earned_ert);
      return { date: row.date, acceptedSteps: row.accepted_steps,
        earnedErtExact: exact, earnedErtDisplay: displayErt(exact),
        raffleAttempts: 0, stepCap: row.step_cap };
    }) } };
  } };
}
