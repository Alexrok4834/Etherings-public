import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateM2eStepBatch, hashM2eStepBatch,
  terminalM2eStepBatchCode } from '../src/m2e-step-batch.js';

const base = Object.freeze({
  installationId: 'B27AFD4E-1140-4E58-8611-596287C8C802',
  batchId: '9A771602-1B42-4A8B-8C72-CC59C3292222', sequence: 0,
  localDate: '2026-09-27', timezoneOffsetMinutes: 180,
  observedStartedAt: '2026-09-27T12:00:00+03:00',
  observedEndedAt: '2026-09-27T12:10:00+03:00',
  stepDelta: 1000, sensorEventCount: 1200, source: 'android_step_counter',
  algorithmVersion: 'step-counter-v1', clientMetadata: { z: 2, a: { y: 1, b: true } },
});

test('canonical MVP batch identity normalizes UUID, dates and metadata for replay', () => {
  const normalized = validateM2eStepBatch(base);
  assert.equal(normalized.installationId, base.installationId.toLowerCase());
  assert.equal(normalized.observedStartedAt.toISOString(), '2026-09-27T09:00:00.000Z');
  const equivalent = validateM2eStepBatch({ ...base,
    installationId: base.installationId.toLowerCase(), batchId: base.batchId.toLowerCase(),
    observedStartedAt: '2026-09-27T09:00:00.000Z',
    observedEndedAt: '2026-09-27T09:10:00Z',
    clientMetadata: { a: { b: true, y: 1 }, z: 2 } });
  assert.equal(hashM2eStepBatch(normalized), hashM2eStepBatch(equivalent));
  assert.match(hashM2eStepBatch(normalized), /^[a-f0-9]{64}$/);
  assert.notEqual(hashM2eStepBatch(normalized),
    hashM2eStepBatch(validateM2eStepBatch({ ...base, stepDelta: 999 })));
});

test('MVP input bounds and unknown-field rejection stay fail-closed', () => {
  for (const change of [null, [], { ...base, unexpected: 1 },
    { ...base, batchId: 'wrong' }, { ...base, sequence: -1 },
    { ...base, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, localDate: '2026-02-30' },
    { ...base, timezoneOffsetMinutes: 1081 },
    { ...base, observedStartedAt: '2026-09-27T12:00:00' },
    { ...base, observedEndedAt: base.observedStartedAt },
    { ...base, observedEndedAt: '2026-09-28T12:10:00+03:00' },
    { ...base, stepDelta: 0 }, { ...base, stepDelta: 100_001 },
    { ...base, sensorEventCount: 0 },
    { ...base, source: 'manual' }, { ...base, algorithmVersion: 'bad version' },
    { ...base, clientMetadata: null }, { ...base, clientMetadata: [] },
    { ...base, clientMetadata: { payload: 'x'.repeat(4097) } },
    { ...base, clientMetadata: { nested: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } } },
  ]) assert.throws(() => validateM2eStepBatch(change), { code: 'INVALID_STEP_BATCH' });
});

test('MVP terminal policy uses future skew, retention and claimed local date', () => {
  const now = new Date('2026-09-27T10:00:00.000Z');
  assert.equal(terminalM2eStepBatchCode(validateM2eStepBatch(base), now), null);
  assert.equal(terminalM2eStepBatchCode(validateM2eStepBatch({ ...base,
    observedStartedAt: '2026-09-27T13:00:00+03:00',
    observedEndedAt: '2026-09-27T13:11:00+03:00' }), now), 'FUTURE_TIMESTAMP');
  assert.equal(terminalM2eStepBatchCode(validateM2eStepBatch({ ...base,
    localDate: '2026-09-19', observedStartedAt: '2026-09-19T12:00:00+03:00',
    observedEndedAt: '2026-09-19T12:10:00+03:00' }), now), 'EXPIRED_BATCH');
  assert.equal(terminalM2eStepBatchCode(validateM2eStepBatch({ ...base,
    localDate: '2026-09-26' }), now), 'LOCAL_DATE_MISMATCH');
  assert.equal(terminalM2eStepBatchCode(validateM2eStepBatch({ ...base,
    observedStartedAt: '2026-09-27T23:50:00+03:00',
    observedEndedAt: '2026-09-28T00:00:00+03:00' }),
    new Date('2026-09-28T00:00:00.000Z')), null);
});
