import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createM2eBalanceConfig } from '../src/m2e-balance-config.js';
import { calculateM2eEarning } from '../src/m2e-earning-calculator.js';
import { canonicalErt, ErtDecimal } from '../src/m2e-ert-decimal.js';

const config = createM2eBalanceConfig({});
const calculate = input => calculateM2eEarning(input, config);

test('Alpha matches all approved MVP formula examples and exact evidence', () => {
  assert.deepEqual(calculate({ validatedDailySteps: 5000, ringCount: 1, comfort: 20 }), {
    rulesVersion: 'move-to-earn-earning-v1',
    balanceConfigVersion: 'move-to-earn-balance-v1',
    stepCap: 5000, validSteps: 5000, comfortMultiplier: '1.5',
    exactNumerator: '2613', exactDenominator: '400',
    authoritativeErt: '6.5325', displayedErt: '6.53',
  });
  assert.equal(calculate({ validatedDailySteps: 8000, ringCount: 4, comfort: 45 }).authoritativeErt,
    '11.792');
  assert.equal(calculate({ validatedDailySteps: 8000, ringCount: 4, comfort: 45 }).displayedErt,
    '11.79');
  assert.equal(calculate({ validatedDailySteps: 9000, ringCount: 1, comfort: 20 }).authoritativeErt,
    '6.5325');
});

test('Alpha matches MVP caps, non-terminating precision and partition-independent cumulative total', () => {
  for (const [ringCount, stepCap] of [[1, 5000], [2, 6000], [3, 7000],
    [4, 8000], [10, 14000]]) {
    const result = calculate({ validatedDailySteps: 99_999, ringCount, comfort: 0 });
    assert.equal(result.stepCap, stepCap);
    assert.equal(result.validSteps, stepCap);
  }
  const repeating = calculate({ validatedDailySteps: 1, ringCount: 1, comfort: 2 });
  assert.equal(repeating.exactNumerator, '2613');
  assert.equal(repeating.exactDenominator, '2750000');
  assert.equal(repeating.authoritativeErt, '0.000950181818181818');
  let credited = new ErtDecimal(0);
  for (const steps of [197, 293, 2467, 5000, 8000]) {
    const target = new ErtDecimal(calculate({ validatedDailySteps: steps, ringCount: 4,
      comfort: 45 }).authoritativeErt);
    const delta = target.minus(credited);
    assert.equal(delta.isNegative(), false);
    credited = credited.plus(delta);
  }
  assert.equal(canonicalErt(credited), '11.792');
});

test('invalid economic inputs and configuration fail closed', () => {
  assert.deepEqual(createM2eBalanceConfig({ M2E_BASE_STEPS: '6000',
    M2E_EXTRA_STEPS_PER_RING: '1200', M2E_BASE_ERT_PER_1000_STEPS: '1.2500',
    M2E_COMFORT_CURVE_K: '25' }), {
    version: 'move-to-earn-balance-v1', baseSteps: 6000,
    extraStepsPerRing: 1200, baseErtPer1000Steps: '1.25', comfortCurveK: 25,
  });
  assert.deepEqual(calculate({ validatedDailySteps: 0, ringCount: 1, comfort: 20 }), {
    rulesVersion: 'move-to-earn-earning-v1',
    balanceConfigVersion: 'move-to-earn-balance-v1', stepCap: 5000, validSteps: 0,
    comfortMultiplier: '1.5', exactNumerator: '0', exactDenominator: '1',
    authoritativeErt: '0', displayedErt: '0.00',
  });
  for (const input of [
    { validatedDailySteps: -1, ringCount: 1, comfort: 1 },
    { validatedDailySteps: 1.5, ringCount: 1, comfort: 1 },
    { validatedDailySteps: 1, ringCount: 0, comfort: 1 },
    { validatedDailySteps: 1, ringCount: 1, comfort: -1 },
    { validatedDailySteps: Number.MAX_SAFE_INTEGER,
      ringCount: Number.MAX_SAFE_INTEGER, comfort: 1 },
  ]) assert.throws(() => calculate(input));
  assert.throws(() => createM2eBalanceConfig({ M2E_BASE_STEPS: '0' }));
  assert.throws(() => createM2eBalanceConfig({ M2E_BASE_ERT_PER_1000_STEPS: '1e3' }));
});
