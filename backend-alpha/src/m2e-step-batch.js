import { createHash } from 'node:crypto';

// Direct Alpha port of the input, canonical replay and time-policy
// boundary in backend/src/step-sync/step-sync.service.ts.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALGORITHM_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const FIELDS = new Set(['installationId', 'batchId', 'sequence', 'localDate',
  'timezoneOffsetMinutes', 'observedStartedAt', 'observedEndedAt', 'stepDelta',
  'sensorEventCount', 'source', 'algorithmVersion', 'clientMetadata']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_STEP_BATCH';
  return error;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function realCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function offsetDate(value, field) {
  if (typeof value !== 'string' || !OFFSET_DATE_TIME.test(value))
    throw invalid(`${field} must be an ISO 8601 date-time with an explicit offset`);
  if (!realCalendarDate(value.slice(0, 10)))
    throw invalid(`${field} must contain a real calendar date`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(`${field} must be a valid date-time`);
  return parsed;
}

function normalizeJson(value, depth) {
  if (depth > 8) throw invalid('clientMetadata must not exceed 8 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJson(item, depth + 1)]));
  throw invalid('clientMetadata must contain only JSON values');
}

export function validateM2eStepBatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('Batch body must be an object');
  const unknown = Object.keys(input).filter(key => !FIELDS.has(key));
  if (unknown.length) throw invalid(`Unknown batch fields: ${unknown.sort().join(', ')}`);
  for (const field of ['installationId', 'batchId']) {
    if (typeof input[field] !== 'string' || !UUID_V4.test(input[field]))
      throw invalid(`${field} must be an RFC 4122 UUID v4`);
  }
  const sequence = boundedInteger(input.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER);
  if (typeof input.localDate !== 'string' || !LOCAL_DATE.test(input.localDate))
    throw invalid('localDate must use YYYY-MM-DD');
  if (!realCalendarDate(input.localDate)) throw invalid('localDate must be a real calendar date');
  const timezoneOffsetMinutes = boundedInteger(input.timezoneOffsetMinutes,
    'timezoneOffsetMinutes', -1080, 1080);
  const observedStartedAt = offsetDate(input.observedStartedAt, 'observedStartedAt');
  const observedEndedAt = offsetDate(input.observedEndedAt, 'observedEndedAt');
  const durationMs = observedEndedAt.getTime() - observedStartedAt.getTime();
  if (durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000)
    throw invalid('Batch observation interval must be positive and no longer than 24 hours');
  const stepDelta = boundedInteger(input.stepDelta, 'stepDelta', 1, 100_000);
  const sensorEventCount = boundedInteger(input.sensorEventCount,
    'sensorEventCount', 1, 1_000_000);
  if (input.source !== 'android_step_counter') throw invalid('source must be android_step_counter');
  if (typeof input.algorithmVersion !== 'string' || !ALGORITHM_VERSION.test(input.algorithmVersion))
    throw invalid('algorithmVersion must contain 1-64 safe identifier characters');
  const clientMetadata = input.clientMetadata === undefined ? null : normalizeJson(input.clientMetadata, 0);
  if (input.clientMetadata !== undefined &&
      (!clientMetadata || Array.isArray(clientMetadata) || typeof clientMetadata !== 'object'))
    throw invalid('clientMetadata must be a JSON object');
  if (clientMetadata !== null && Buffer.byteLength(JSON.stringify(clientMetadata), 'utf8') > 4096)
    throw invalid('clientMetadata must not exceed 4096 bytes');
  return { installationId: input.installationId.toLowerCase(),
    batchId: input.batchId.toLowerCase(), sequence, localDate: input.localDate,
    timezoneOffsetMinutes, observedStartedAt, observedEndedAt, stepDelta,
    sensorEventCount, source: input.source, algorithmVersion: input.algorithmVersion,
    clientMetadata };
}

export function hashM2eStepBatch(input) {
  const canonical = { algorithmVersion: input.algorithmVersion, batchId: input.batchId,
    clientMetadata: input.clientMetadata, installationId: input.installationId,
    localDate: input.localDate, observedEndedAt: input.observedEndedAt.toISOString(),
    observedStartedAt: input.observedStartedAt.toISOString(),
    sensorEventCount: input.sensorEventCount, sequence: input.sequence,
    source: input.source, stepDelta: input.stepDelta,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function terminalM2eStepBatchCode(input, now = new Date(), policy = {
  retentionSeconds: 7 * 24 * 60 * 60, maxFutureSkewSeconds: 10 * 60 }) {
  if (input.observedEndedAt.getTime() > now.getTime() + policy.maxFutureSkewSeconds * 1000)
    return 'FUTURE_TIMESTAMP';
  if (input.observedStartedAt.getTime() < now.getTime() - policy.retentionSeconds * 1000)
    return 'EXPIRED_BATCH';
  const offsetMs = input.timezoneOffsetMinutes * 60 * 1000;
  const startedLocal = new Date(input.observedStartedAt.getTime() + offsetMs).toISOString();
  const endedLocal = new Date(input.observedEndedAt.getTime() + offsetMs).toISOString();
  if (startedLocal.slice(0, 10) !== input.localDate) return 'LOCAL_DATE_MISMATCH';
  if (endedLocal.slice(0, 10) === input.localDate) return null;
  const nextDate = new Date(`${input.localDate}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return endedLocal === `${nextDate.toISOString().slice(0, 10)}T00:00:00.000Z`
    ? null : 'LOCAL_DATE_MISMATCH';
}
