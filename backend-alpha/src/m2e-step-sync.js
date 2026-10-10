import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { createM2eBalanceConfig } from './m2e-balance-config.js';
import { calculateM2eEarning } from './m2e-earning-calculator.js';
import { settleM2eDailyInTransaction } from './m2e-daily-accounting.js';
import { resolveM2eRingInputsInTransaction } from './m2e-ring-inputs.js';
import { resolveM2eComfortEpoch } from './m2e-comfort-epochs.js';
import { createRingEquipment } from './ring-equipment.js';
import { hashM2eStepBatch, terminalM2eStepBatchCode,
  validateM2eStepBatch } from './m2e-step-batch.js';

function conflict(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const HTTP_STATUS_BY_CODE = new Map([
  ['INVALID_STEP_BATCH', 400],
  ['AUTH_REQUIRED', 401],
  ['WALLET_BINDING_REQUIRED', 409],
  ['M2E_INSTALLATION_REVOKED', 409],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['SEQUENCE_CONFLICT', 409],
  ['M2E_RING_SELECTION_UNAVAILABLE', 503],
  ['RING_EQUIPMENT_CHAIN_UNKNOWN', 503],
  ['M2E_COMFORT_EPOCH_UNAVAILABLE', 503],
]);

function canonicalMint(value) {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch { return false; }
}

// Alpha adaptation of MVP StepSyncService. The optional HTTP route is gated;
// the owner is resolved from the live Alpha session inside the transaction.
export async function receiveM2eStepBatch({ pool, token, body, chain, programId,
  cluster, walletEnvironment, marketReader = null, config = createM2eBalanceConfig({}),
  now = () => new Date() }) {
  const input = validateM2eStepBatch(body);
  const payloadHash = hashM2eStepBatch(input);
  if (!pool || typeof chain?.listOwnedRings !== 'function' ||
      typeof chain?.readEquipmentEligibility !== 'function' ||
      !canonicalMint(programId) || !['devnet', 'local-validator'].includes(cluster) ||
      !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? ''))
    throw new Error('M2E step sync requires isolated Alpha chain/account configuration');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw conflict('AUTH_REQUIRED');
  const equipment = createRingEquipment({ pool, chain, marketReader, programId, cluster,
    walletEnvironment, now });
  const client = await pool.connect();
  let fallbackOnlyCommitted = false;
  let createdInstallationId = null;
  try {
    await client.query('BEGIN');
    const digest = createHash('sha256').update(token, 'ascii').digest('hex');
    const user = (await client.query(`SELECT a.id, b.wallet_address, b.environment
      FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
      LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL
      FOR UPDATE OF a`, [digest, now()])).rows[0];
    if (!user) throw conflict('AUTH_REQUIRED');
    if (!user.wallet_address || user.environment !== walletEnvironment)
      throw conflict('WALLET_BINDING_REQUIRED');
    const accountId = user.id;

    const candidateInstallationId = randomUUID();
    const insertedInstallation = await client.query(`INSERT INTO alpha_m2e_installations
      (id, account_id, installation_id) VALUES ($1,$2,$3)
      ON CONFLICT (account_id, installation_id) DO NOTHING`,
    [candidateInstallationId, accountId, input.installationId]);
    if (insertedInstallation.rowCount === 1) createdInstallationId = candidateInstallationId;
    const installation = (await client.query(`SELECT id, status FROM alpha_m2e_installations
      WHERE account_id = $1 AND installation_id = $2 FOR UPDATE`,
    [accountId, input.installationId])).rows[0];
    if (installation.status === 'REVOKED') throw conflict('M2E_INSTALLATION_REVOKED');

    const previous = (await client.query(`SELECT payload_hash, result_snapshot
      FROM alpha_m2e_batches WHERE installation_record_id = $1 AND batch_id = $2`,
    [installation.id, input.batchId])).rows[0];
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw conflict('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return previous.result_snapshot;
    }
    const sameSequence = (await client.query(`SELECT 1 FROM alpha_m2e_batches
      WHERE installation_record_id = $1 AND sequence = $2`,
    [installation.id, input.sequence])).rowCount > 0;
    if (sameSequence) throw conflict('SEQUENCE_CONFLICT');

    const receivedAt = now();
    let resultCode = terminalM2eStepBatchCode(input, receivedAt);
    if (!resultCode) {
      const later = (await client.query(`SELECT 1 FROM alpha_m2e_batches
        WHERE installation_record_id = $1 AND sequence > $2 LIMIT 1`,
      [installation.id, input.sequence])).rowCount > 0;
      if (later) resultCode = 'SEQUENCE_OUT_OF_ORDER';
    }
    if (!resultCode) {
      const overlap = (await client.query(`SELECT 1 FROM alpha_m2e_batches
        WHERE account_id = $1 AND status IN ('ACCEPTED', 'PARTIALLY_ACCEPTED')
          AND observed_started_at < $2 AND observed_ended_at > $3 LIMIT 1`,
      [accountId, input.observedEndedAt, input.observedStartedAt])).rowCount > 0;
      if (overlap) resultCode = 'OVERLAPPING_INTERVAL';
    }
    const durationMs = input.observedEndedAt.getTime() - input.observedStartedAt.getTime();
    const rateAcceptedSteps = Math.min(input.stepDelta, Math.floor(durationMs * 3 / 1000));
    if (!resultCode && rateAcceptedSteps === 0) resultCode = 'RATE_CAP_ZERO';

    let acceptedStepDelta = 0;
    let settlement = null;
    let dailyStepCap = null;
    const batchRecordId = randomUUID();
    if (!resultCode) {
      const snapshot = (await client.query(`SELECT step_cap, base_steps, extra_steps_per_ring,
          selected_ring_kind, selected_ring_id, selected_ring_comfort
        FROM alpha_m2e_daily_snapshots
        WHERE account_id = $1 AND accounting_date = $2`,
      [accountId, input.localDate])).rows[0];
      const current = await equipment.reconcileInTransaction(client, user);
      if (current.status !== 200) throw conflict(current.body.code);
      if (current.body.eligibility !== 'ELIGIBLE')
        throw conflict('M2E_RING_SELECTION_UNAVAILABLE');
      let ring;
      try {
        ring = await resolveM2eRingInputsInTransaction({ client, accountId,
          chain, marketReader, programId, cluster, walletAddress: user.wallet_address });
      } catch (error) {
        // A confirmed fallback is independent of an unrelated Silver provider
        // UNKNOWN. Keep its audited selection event, but no batch or ERT.
        if (current.body.fallbackReason &&
            error?.code === 'M2E_RING_SELECTION_UNAVAILABLE') {
          if (createdInstallationId) await client.query(
            'DELETE FROM alpha_m2e_installations WHERE id = $1', [createdInstallationId]);
          await client.query('COMMIT');
          fallbackOnlyCommitted = true;
        }
        throw error;
      }
      const currentRingCount = ring.ringCount;
      const earningSegment = await resolveM2eComfortEpoch(client, { accountId,
        observedStartedAt: input.observedStartedAt,
        observedEndedAt: input.observedEndedAt,
        current: { ...ring.selectedRing, comfort: ring.selectedRingComfort },
        dailySnapshot: snapshot });
      const capConfig = snapshot ? { ...config, baseSteps: snapshot.base_steps,
        extraStepsPerRing: snapshot.extra_steps_per_ring } : config;
      const stepCap = calculateM2eEarning({ validatedDailySteps: 0,
        ringCount: currentRingCount, comfort: 0 }, capConfig).stepCap;
      dailyStepCap = stepCap;
      const stats = (await client.query(`SELECT accepted_steps FROM alpha_m2e_daily_stats
        WHERE account_id = $1 AND accounting_date = $2`,
      [accountId, input.localDate])).rows[0];
      const remaining = Math.max(0, stepCap - (stats?.accepted_steps ?? 0));
      if (remaining === 0) resultCode = 'DAILY_CAP_REACHED';
      else {
        acceptedStepDelta = Math.min(rateAcceptedSteps, remaining);
        settlement = await settleM2eDailyInTransaction(client, { accountId,
          accountingDate: input.localDate, batchId: batchRecordId, payloadHash,
          acceptedStepDelta, config, effectiveRingCount: currentRingCount,
          earningSegment,
          resolveRingInputs: async () => ({ ...ring,
            selectedRing: { kind: earningSegment.ring.kind, id: earningSegment.ring.id },
            selectedRingComfort: earningSegment.ring.comfort }) });
        resultCode = acceptedStepDelta === input.stepDelta ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED';
      }
    }

    const status = resultCode === 'ACCEPTED' || resultCode === 'PARTIALLY_ACCEPTED'
      ? resultCode : 'REJECTED';
    const response = { batchId: input.batchId, installationId: input.installationId,
      sequence: input.sequence, status, acceptedStepDelta,
      earnedErtDelta: settlement ? Number(settlement.deltaAuthoritativeErt) : 0,
      earnedErtDeltaExact: settlement?.deltaAuthoritativeErt ?? '0',
      earnedErtDeltaDisplay: settlement?.deltaDisplayedErt ?? '0.00',
      dailyStepCap,
      accountingDate: settlement?.accountingDate ?? null, resultCode,
      receivedAt: receivedAt.toISOString(), processedAt: now().toISOString(),
      rulesVersion: settlement?.rulesVersion ?? null,
      balanceConfigVersion: settlement?.balanceConfigVersion ?? null,
      m2eSettlement: settlement };
    await client.query(`INSERT INTO alpha_m2e_batches
      (id, account_id, installation_record_id, batch_id, sequence, payload_hash,
       local_date, timezone_offset_minutes, observed_started_at, observed_ended_at,
       claimed_step_count, sensor_event_count, source, algorithm_version,
       client_metadata, status, accepted_step_delta, earned_ert_delta,
       accounting_date, result_code, result_snapshot, created_at, processed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::numeric,
        $19,$20,$21::jsonb,$22,$23)`,
    [batchRecordId, accountId, installation.id, input.batchId, input.sequence,
      payloadHash, input.localDate, input.timezoneOffsetMinutes,
      input.observedStartedAt, input.observedEndedAt, input.stepDelta,
      input.sensorEventCount, input.source, input.algorithmVersion,
      input.clientMetadata === null ? null : JSON.stringify(input.clientMetadata),
      status, acceptedStepDelta, settlement?.deltaAuthoritativeErt ?? '0',
      settlement?.accountingDate ?? null, resultCode, JSON.stringify(response),
      receivedAt, new Date(response.processedAt)]);
    await client.query(`UPDATE alpha_m2e_installations SET last_seen_at = $2 WHERE id = $1`,
      [installation.id, receivedAt]);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    if (!fallbackOnlyCommitted) await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createM2eStepSync(options) {
  return { async receive(token, body) {
    try {
      return { status: 200, body: await receiveM2eStepBatch({ ...options, token, body }) };
    } catch (error) {
      const status = HTTP_STATUS_BY_CODE.get(error?.code);
      if (!status) throw error;
      return { status, body: { code: error.code } };
    }
  } };
}
