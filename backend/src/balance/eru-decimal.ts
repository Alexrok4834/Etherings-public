import Decimal from 'decimal.js';

export const ERU_ACCOUNTING_SCALE = 18;
export const ERU_DISPLAY_SCALE = 2;

export const EruDecimal = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});

const unsignedDecimalPattern = /^(0|[1-9]\d{0,29})(?:\.(\d{1,18}))?$/;
const maxSafeInteger = new EruDecimal(Number.MAX_SAFE_INTEGER);

export function parseUnsignedEruDecimal(value: unknown, field = 'ERU value', allowZero = true) {
  if (typeof value !== 'string' || !unsignedDecimalPattern.test(value)) {
    throw new Error(`${field} must be a canonical ERU decimal with at most 30 integer and 18 fractional digits`);
  }
  const decimal = new EruDecimal(value);
  if (!decimal.isFinite() || decimal.isNegative() || (!allowZero && decimal.isZero())) {
    throw new Error(`${field} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return decimal;
}

export function canonicalEru(value: unknown, field = 'ERU value') {
  const decimal = parseUnsignedEruDecimal(value, field);
  return quantizeEru(decimal, field);
}

export function quantizeEru(value: Decimal.Value, field = 'ERU value') {
  const decimal = new EruDecimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) throw new Error(`${field} must be non-negative`);
  const fixed = decimal.toFixed(ERU_ACCOUNTING_SCALE);
  const canonical = fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (canonical.split('.')[0].length > 30) throw new Error(`${field} exceeds the ERU accounting range`);
  return canonical === '-0' ? '0' : canonical;
}

export function displayEru(value: unknown, field = 'ERU value') {
  return parseUnsignedEruDecimal(value, field).toDecimalPlaces(
    ERU_DISPLAY_SCALE,
    Decimal.ROUND_HALF_UP,
  ).toFixed(ERU_DISPLAY_SCALE);
}

export function eruCompatibilityNumber(value: string) {
  const decimal = parseUnsignedEruDecimal(value);
  return decimal.isInteger() && decimal.lte(maxSafeInteger) ? decimal.toNumber() : null;
}

export function hasEnoughEru(balance: string, cost: string) {
  return parseUnsignedEruDecimal(balance, 'eruBalance')
    .gte(parseUnsignedEruDecimal(cost, 'eruCost'));
}
