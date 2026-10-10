import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from './m2e-ert-decimal.js';
import { M2E_EARNING_RULES_VERSION } from './m2e-balance-config.js';

// Direct Alpha-runtime port of backend/src/m2e/m2e-earning-calculator.ts.
export function calculateM2eEarning(input, config) {
  const validatedDailySteps = nonNegativeSafeInteger(input.validatedDailySteps, 'validatedDailySteps');
  const ringCount = positiveSafeInteger(input.ringCount, 'ringCount');
  const comfort = nonNegativeSafeInteger(input.comfort, 'comfort');
  const extraSteps = config.extraStepsPerRing * (ringCount - 1);
  const stepCap = config.baseSteps + extraSteps;
  if (!Number.isSafeInteger(extraSteps) || !Number.isSafeInteger(stepCap))
    throw new Error('stepCap exceeds the safe integer range');

  const validSteps = Math.min(validatedDailySteps, stepCap);
  const earning = calculateM2eEntitlementForSteps(validSteps, comfort, config);

  return Object.freeze({
    rulesVersion: M2E_EARNING_RULES_VERSION,
    balanceConfigVersion: config.version,
    stepCap, validSteps, ...earning,
  });
}

// A Comfort epoch has its own cumulative step total. The daily cap is enforced
// by the batch transaction, never by this per-epoch entitlement calculation.
export function calculateM2eEntitlementForSteps(validSteps, comfort, config) {
  nonNegativeSafeInteger(validSteps, 'validSteps');
  nonNegativeSafeInteger(comfort, 'comfort');
  const baseRate = decimalFraction(config.baseErtPer1000Steps);
  const comfortValue = BigInt(comfort);
  const comfortCurveK = BigInt(config.comfortCurveK);
  const comfortNumerator = 2n * comfortValue + comfortCurveK;
  const comfortDenominator = comfortValue + comfortCurveK;
  const rawNumerator = BigInt(validSteps) * baseRate.numerator * comfortNumerator;
  const rawDenominator = 1000n * baseRate.denominator * comfortDenominator;
  const divisor = greatestCommonDivisor(rawNumerator, rawDenominator);
  const exactNumerator = rawNumerator / divisor;
  const exactDenominator = rawDenominator / divisor;
  const authoritative = new ErtDecimal(exactNumerator.toString())
    .dividedBy(exactDenominator.toString());
  const multiplier = new ErtDecimal(comfortNumerator.toString())
    .dividedBy(comfortDenominator.toString());
  const authoritativeErt = canonicalErt(authoritative);

  return Object.freeze({
    comfortMultiplier: canonicalErt(multiplier),
    exactNumerator: exactNumerator.toString(),
    exactDenominator: exactDenominator.toString(),
    authoritativeErt,
    displayedErt: displayErt(authoritativeErt),
  });
}

function decimalFraction(value) {
  parseUnsignedErtDecimal(value, 'baseErtPer1000Steps');
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function positiveSafeInteger(value, field) {
  const parsed = nonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function nonNegativeSafeInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}
