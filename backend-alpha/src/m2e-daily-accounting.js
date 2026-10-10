import { randomUUID } from 'node:crypto';
import { createM2eBalanceConfig, M2E_EARNING_RULES_VERSION } from './m2e-balance-config.js';
import { calculateM2eEarning, calculateM2eEntitlementForSteps } from './m2e-earning-calculator.js';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from './m2e-ert-decimal.js';

// Called inside the step-batch transaction. batchId is the server-assigned batch
// record UUID; the installation-scoped client batch ID is checked by the caller.
// The account row is the same serialization boundary used by Alpha Equip.
export async function settleM2eDailyInTransaction(client, { accountId, accountingDate,
  batchId, payloadHash, acceptedStepDelta, resolveRingInputs, effectiveRingCount = null,
  earningSegment = null,
  config = createM2eBalanceConfig({}) }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(batchId) ||
      !/^[a-f0-9]{64}$/.test(payloadHash) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(accountingDate) ||
      !Number.isSafeInteger(acceptedStepDelta) || acceptedStepDelta <= 0 ||
      typeof resolveRingInputs !== 'function') throw new Error('Invalid M2E settlement input');

  const owner = await client.query('SELECT id FROM alpha_accounts WHERE id = $1 FOR UPDATE',
    [accountId]);
  if (owner.rowCount !== 1) throw new Error('M2E account missing');

  const prior = (await client.query(`SELECT payload_hash, result_snapshot
    FROM alpha_m2e_settlements WHERE account_id = $1 AND batch_id = $2`,
  [accountId, batchId])).rows[0];
  if (prior) {
    if (prior.payload_hash !== payloadHash) {
      const error = new Error('Batch identity already exists with a different payload');
      error.code = 'IDEMPOTENCY_CONFLICT';
      throw error;
    }
    return prior.result_snapshot;
  }

  let snapshot = (await client.query(`SELECT * FROM alpha_m2e_daily_snapshots
    WHERE account_id = $1 AND accounting_date = $2 FOR UPDATE`,
  [accountId, accountingDate])).rows[0];
  if (!snapshot) {
    // The caller must resolve the approved C1 inputs from canonical owner/chain
    // state under this lock. UNKNOWN aborts the whole batch transaction.
    const ring = await resolveRingInputs(client, accountId);
    if (!ring || !Number.isSafeInteger(ring.ringCount) || ring.ringCount < 1 ||
        !Number.isSafeInteger(ring.selectedRingComfort) || ring.selectedRingComfort < 0 ||
        !['COOPER', 'SILVER_RING'].includes(ring.selectedRing?.kind) ||
        typeof ring.selectedRing?.id !== 'string' || !ring.selectedRing.id)
      throw new Error('M2E_RING_SELECTION_UNAVAILABLE');
    const zero = calculateM2eEarning({ validatedDailySteps: 0,
      ringCount: ring.ringCount, comfort: ring.selectedRingComfort }, config);
    snapshot = (await client.query(`INSERT INTO alpha_m2e_daily_snapshots
      (id, account_id, accounting_date, selected_ring_kind, selected_ring_id,
       ring_count, selected_ring_comfort, step_cap, rules_version,
       balance_config_version, base_steps, extra_steps_per_ring,
       base_ert_per_1000_steps, comfort_curve_k)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(), accountId, accountingDate, ring.selectedRing.kind, ring.selectedRing.id,
      ring.ringCount, ring.selectedRingComfort, zero.stepCap, zero.rulesVersion,
      zero.balanceConfigVersion, config.baseSteps, config.extraStepsPerRing,
      config.baseErtPer1000Steps, config.comfortCurveK])).rows[0];
  }
  if (snapshot.rules_version !== M2E_EARNING_RULES_VERSION ||
      snapshot.balance_config_version !== config.version)
    throw new Error('Unsupported M2E snapshot version');
  const ringCount = effectiveRingCount ?? snapshot.ring_count;
  if (!Number.isSafeInteger(ringCount) || ringCount < 1)
    throw new Error('Invalid current M2E Ring count');

  await client.query(`INSERT INTO alpha_m2e_daily_stats
    (account_id, accounting_date, snapshot_id) VALUES ($1,$2,$3)
    ON CONFLICT (account_id, accounting_date) DO NOTHING`,
  [accountId, accountingDate, snapshot.id]);
  const stats = (await client.query(`SELECT accepted_steps, earned_ert::text AS earned_ert,
    snapshot_id FROM alpha_m2e_daily_stats
    WHERE account_id = $1 AND accounting_date = $2 FOR UPDATE`,
  [accountId, accountingDate])).rows[0];
  if (stats.snapshot_id !== snapshot.id) throw new Error('M2E daily snapshot mismatch');
  const cumulativeAcceptedSteps = stats.accepted_steps + acceptedStepDelta;
  if (!Number.isSafeInteger(cumulativeAcceptedSteps))
    throw new Error('Invalid cumulative M2E steps');

  const calculation = calculateM2eEarning({ validatedDailySteps: cumulativeAcceptedSteps,
    ringCount, comfort: snapshot.selected_ring_comfort }, {
    version: snapshot.balance_config_version, baseSteps: snapshot.base_steps,
    extraStepsPerRing: snapshot.extra_steps_per_ring,
    baseErtPer1000Steps: canonicalErt(snapshot.base_ert_per_1000_steps),
    comfortCurveK: snapshot.comfort_curve_k });
  if (cumulativeAcceptedSteps > calculation.stepCap)
    throw new Error(effectiveRingCount === null ?
      'M2E accepted steps exceed frozen daily cap' :
      'M2E accepted steps exceed current daily cap');
  if (effectiveRingCount === null && calculation.stepCap !== snapshot.step_cap)
    throw new Error('M2E frozen step cap mismatch');
  const alreadyCredited = parseUnsignedErtDecimal(stats.earned_ert, 'alreadyCreditedErt');
  let targetErt = calculation.authoritativeErt;
  let economicEvidence = calculation;
  if (earningSegment) {
    if (typeof earningSegment.segmentKey !== 'string' || !earningSegment.segmentKey ||
        !['COOPER', 'SILVER_RING'].includes(earningSegment.ring?.kind) ||
        typeof earningSegment.ring.id !== 'string' || !earningSegment.ring.id ||
        !Number.isSafeInteger(earningSegment.ring.comfort) ||
        earningSegment.ring.comfort < 0) throw new Error('Invalid M2E Comfort segment');
    let segment = (await client.query(`SELECT * FROM alpha_m2e_comfort_segments
      WHERE account_id = $1 AND accounting_date = $2 AND segment_key = $3 FOR UPDATE`,
    [accountId, accountingDate, earningSegment.segmentKey])).rows[0];
    if (!segment) {
      let seededSteps = 0;
      let seededErt = '0';
      if (earningSegment.segmentKey === 'legacy') {
        const other = (await client.query(`SELECT
          COALESCE(sum(accepted_steps),0)::int AS steps,
          COALESCE(sum(earned_ert),0)::text AS earned
          FROM alpha_m2e_comfort_segments
          WHERE account_id = $1 AND accounting_date = $2`,
        [accountId, accountingDate])).rows[0];
        seededSteps = stats.accepted_steps - other.steps;
        seededErt = canonicalErt(alreadyCredited.minus(other.earned));
        if (seededSteps < 0 || new ErtDecimal(seededErt).isNegative())
          throw new Error('M2E legacy Comfort segment mismatch');
      }
      segment = (await client.query(`INSERT INTO alpha_m2e_comfort_segments
        (account_id,accounting_date,segment_key,selected_ring_kind,
         selected_ring_id,comfort,accepted_steps,earned_ert)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric) RETURNING *`,
      [accountId, accountingDate, earningSegment.segmentKey,
        earningSegment.ring.kind, earningSegment.ring.id,
        earningSegment.ring.comfort, seededSteps, seededErt])).rows[0];
    }
    if (segment.selected_ring_kind !== earningSegment.ring.kind ||
        segment.selected_ring_id !== earningSegment.ring.id ||
        segment.comfort !== earningSegment.ring.comfort)
      throw new Error('M2E Comfort segment identity mismatch');
    const segmentSteps = segment.accepted_steps + acceptedStepDelta;
    const segmentResult = calculateM2eEntitlementForSteps(segmentSteps,
      earningSegment.ring.comfort, {
        baseErtPer1000Steps: canonicalErt(snapshot.base_ert_per_1000_steps),
        comfortCurveK: snapshot.comfort_curve_k });
    const segmentDelta = new ErtDecimal(segmentResult.authoritativeErt)
      .minus(segment.earned_ert);
    if (segmentDelta.isNegative()) throw new Error('M2E Comfort entitlement decreased');
    await client.query(`UPDATE alpha_m2e_comfort_segments SET
      accepted_steps = $4, earned_ert = $5::numeric
      WHERE account_id = $1 AND accounting_date = $2 AND segment_key = $3`,
    [accountId, accountingDate, earningSegment.segmentKey, segmentSteps,
      segmentResult.authoritativeErt]);
    targetErt = canonicalErt(alreadyCredited.plus(segmentDelta));
    economicEvidence = { ...segmentResult,
      segmentKey: earningSegment.segmentKey,
      segmentAcceptedSteps: segmentSteps,
      segmentAuthoritativeErt: segmentResult.authoritativeErt };
  }
  const delta = new ErtDecimal(targetErt).minus(alreadyCredited);
  if (delta.isNegative()) throw new Error('M2E cumulative entitlement below already credited amount');
  const deltaAuthoritativeErt = canonicalErt(delta);

  await client.query(`INSERT INTO alpha_ert_accounts (account_id) VALUES ($1)
    ON CONFLICT (account_id) DO NOTHING`, [accountId]);
  if (!delta.isZero()) await client.query(`INSERT INTO alpha_ert_ledger
    (id, account_id, event_key, amount) VALUES ($1,$2,$3,$4::numeric)`,
  [randomUUID(), accountId, `m2e-step-batch:${accountId}:${batchId}`, deltaAuthoritativeErt]);
  await client.query(`UPDATE alpha_m2e_daily_stats SET accepted_steps = $3,
    earned_ert = $4::numeric, updated_at = now()
    WHERE account_id = $1 AND accounting_date = $2`,
  [accountId, accountingDate, cumulativeAcceptedSteps, targetErt]);

  const result = {
    snapshotId: snapshot.id, accountingDate, rulesVersion: snapshot.rules_version,
    balanceConfigVersion: snapshot.balance_config_version,
    ringCount,
    selectedRing: earningSegment ? { kind: earningSegment.ring.kind,
      id: earningSegment.ring.id } :
      { kind: snapshot.selected_ring_kind, id: snapshot.selected_ring_id },
    selectedRingComfort: earningSegment?.ring.comfort ?? snapshot.selected_ring_comfort,
    stepCap: calculation.stepCap,
    acceptedStepDelta, cumulativeAcceptedSteps, validSteps: calculation.validSteps,
    exactNumerator: economicEvidence.exactNumerator,
    exactDenominator: economicEvidence.exactDenominator,
    exactFractionScope: earningSegment ? 'SEGMENT_CUMULATIVE' : 'DAILY_CUMULATIVE',
    comfortMultiplier: economicEvidence.comfortMultiplier,
    earningSegmentKey: economicEvidence.segmentKey ?? null,
    segmentAcceptedSteps: economicEvidence.segmentAcceptedSteps ?? null,
    segmentAuthoritativeErt: economicEvidence.segmentAuthoritativeErt ?? null,
    cumulativeAuthoritativeErt: targetErt,
    cumulativeDisplayedErt: displayErt(targetErt),
    deltaAuthoritativeErt, deltaDisplayedErt: displayErt(deltaAuthoritativeErt),
  };
  await client.query(`INSERT INTO alpha_m2e_settlements
    (account_id, batch_id, payload_hash, snapshot_id, accepted_step_delta,
     earned_ert_delta, result_snapshot) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::jsonb)`,
  [accountId, batchId, payloadHash, snapshot.id, acceptedStepDelta,
    deltaAuthoritativeErt, JSON.stringify(result)]);
  return result;
}
