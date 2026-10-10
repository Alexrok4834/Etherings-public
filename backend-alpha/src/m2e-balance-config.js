import { parseUnsignedErtDecimal } from './m2e-ert-decimal.js';

// Values and validation mirror backend/src/m2e/m2e-balance-config.service.ts.
export const M2E_BALANCE_CONFIG_VERSION = 'move-to-earn-balance-v1';
export const M2E_EARNING_RULES_VERSION = 'move-to-earn-earning-v1';

const defaults = Object.freeze({
  baseSteps: 5000,
  extraStepsPerRing: 1000,
  baseErtPer1000Steps: '0.871',
  comfortCurveK: 20,
});

function positiveSafeInteger(raw, key, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(raw).trim() !== String(value))
    throw new Error(`${key} must be a positive safe integer`);
  return value;
}

function nonNegativeDecimal(raw, key, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string')
    throw new Error(`${key} must be configured as a canonical decimal string`);
  parseUnsignedErtDecimal(raw, key);
  return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function createM2eBalanceConfig(env = process.env) {
  return Object.freeze({
    version: M2E_BALANCE_CONFIG_VERSION,
    baseSteps: positiveSafeInteger(env.M2E_BASE_STEPS, 'M2E_BASE_STEPS', defaults.baseSteps),
    extraStepsPerRing: positiveSafeInteger(env.M2E_EXTRA_STEPS_PER_RING,
      'M2E_EXTRA_STEPS_PER_RING', defaults.extraStepsPerRing),
    baseErtPer1000Steps: nonNegativeDecimal(env.M2E_BASE_ERT_PER_1000_STEPS,
      'M2E_BASE_ERT_PER_1000_STEPS', defaults.baseErtPer1000Steps),
    comfortCurveK: positiveSafeInteger(env.M2E_COMFORT_CURVE_K,
      'M2E_COMFORT_CURVE_K', defaults.comfortCurveK),
  });
}
