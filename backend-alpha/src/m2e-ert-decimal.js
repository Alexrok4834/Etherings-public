import Decimal from 'decimal.js';

// Exact parity with backend/src/m2e/ert-decimal.ts; display never feeds accounting.
export const ERT_ACCOUNTING_SCALE = 18;
export const ERT_DISPLAY_SCALE = 2;
export const ErtDecimal = Decimal.clone({
  precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100,
});

const unsignedDecimalPattern = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/;

export function parseUnsignedErtDecimal(value, field, allowZero = true) {
  if (typeof value !== 'string' || !unsignedDecimalPattern.test(value))
    throw new Error(`${field} must be a canonical decimal string with at most 18 fractional digits`);
  const decimal = new ErtDecimal(value);
  if (!decimal.isFinite() || decimal.isNegative() || (!allowZero && decimal.isZero()))
    throw new Error(`${field} must be ${allowZero ? 'non-negative' : 'positive'}`);
  return decimal;
}

export function canonicalErt(value) {
  const fixed = new ErtDecimal(value).toDecimalPlaces(
    ERT_ACCOUNTING_SCALE, Decimal.ROUND_HALF_UP).toFixed(ERT_ACCOUNTING_SCALE);
  const canonical = fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return canonical === '-0' ? '0' : canonical;
}

export function displayErt(value) {
  return new ErtDecimal(value).toDecimalPlaces(
    ERT_DISPLAY_SCALE, Decimal.ROUND_HALF_UP).toFixed(ERT_DISPLAY_SCALE);
}
