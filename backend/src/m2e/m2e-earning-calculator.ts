import { Injectable } from '@nestjs/common';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from './ert-decimal';
import {
  M2E_EARNING_RULES_VERSION,
  M2eBalanceConfig,
  M2eBalanceConfigService,
} from './m2e-balance-config.service';

export type M2eEarningInput = Readonly<{
  validatedDailySteps: number;
  ringCount: number;
  comfort: number;
}>;

export type M2eEarningResult = Readonly<{
  rulesVersion: typeof M2E_EARNING_RULES_VERSION;
  balanceConfigVersion: M2eBalanceConfig['version'];
  stepCap: number;
  validSteps: number;
  comfortMultiplier: string;
  exactNumerator: string;
  exactDenominator: string;
  authoritativeErt: string;
  displayedErt: string;
}>;

@Injectable()
export class M2eEarningCalculator {
  constructor(private readonly balanceConfig: M2eBalanceConfigService) {}

  calculate(input: M2eEarningInput): M2eEarningResult {
    return this.calculateWithConfig(input, this.balanceConfig.getConfig());
  }

  calculateWithConfig(input: M2eEarningInput, config: M2eBalanceConfig): M2eEarningResult {
    const validatedDailySteps = nonNegativeSafeInteger(
      input.validatedDailySteps,
      'validatedDailySteps',
    );
    const ringCount = positiveSafeInteger(input.ringCount, 'ringCount');
    const comfort = nonNegativeSafeInteger(input.comfort, 'comfort');
    const extraSteps = config.extraStepsPerRing * (ringCount - 1);
    const stepCap = config.baseSteps + extraSteps;
    if (!Number.isSafeInteger(extraSteps) || !Number.isSafeInteger(stepCap)) {
      throw new Error('stepCap exceeds the safe integer range');
    }

    const validSteps = Math.min(validatedDailySteps, stepCap);
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
    const authoritative = new ErtDecimal(exactNumerator.toString()).dividedBy(
      exactDenominator.toString(),
    );
    const multiplier = new ErtDecimal(comfortNumerator.toString()).dividedBy(
      comfortDenominator.toString(),
    );
    const authoritativeErt = canonicalErt(authoritative);

    return Object.freeze({
      rulesVersion: M2E_EARNING_RULES_VERSION,
      balanceConfigVersion: config.version,
      stepCap,
      validSteps,
      comfortMultiplier: canonicalErt(multiplier),
      exactNumerator: exactNumerator.toString(),
      exactDenominator: exactDenominator.toString(),
      authoritativeErt,
      displayedErt: displayErt(authoritativeErt),
    });
  }
}

function decimalFraction(value: string) {
  parseUnsignedErtDecimal(value, 'baseErtPer1000Steps');
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function positiveSafeInteger(value: unknown, field: string) {
  const parsed = nonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}
