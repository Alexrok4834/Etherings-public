import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseUnsignedErtDecimal } from './ert-decimal';

export const M2E_BALANCE_CONFIG_VERSION = 'move-to-earn-balance-v1';
export const M2E_EARNING_RULES_VERSION = 'move-to-earn-earning-v1';

export type M2eBalanceConfig = Readonly<{
  version: typeof M2E_BALANCE_CONFIG_VERSION;
  baseSteps: number;
  extraStepsPerRing: number;
  baseErtPer1000Steps: string;
  comfortCurveK: number;
}>;

const defaults = Object.freeze({
  baseSteps: 5000,
  extraStepsPerRing: 1000,
  baseErtPer1000Steps: '0.871',
  comfortCurveK: 20,
});

@Injectable()
export class M2eBalanceConfigService {
  private readonly balanceConfig: M2eBalanceConfig;

  constructor(private readonly config: ConfigService) {
    this.balanceConfig = Object.freeze({
      version: M2E_BALANCE_CONFIG_VERSION,
      baseSteps: this.positiveSafeInteger('M2E_BASE_STEPS', defaults.baseSteps),
      extraStepsPerRing: this.positiveSafeInteger(
        'M2E_EXTRA_STEPS_PER_RING',
        defaults.extraStepsPerRing,
      ),
      baseErtPer1000Steps: this.nonNegativeDecimal(
        'M2E_BASE_ERT_PER_1000_STEPS',
        defaults.baseErtPer1000Steps,
      ),
      comfortCurveK: this.positiveSafeInteger(
        'M2E_COMFORT_CURVE_K',
        defaults.comfortCurveK,
      ),
    });
  }

  getConfig(): M2eBalanceConfig {
    return this.balanceConfig;
  }

  private positiveSafeInteger(key: string, fallback: number) {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;

    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || String(raw).trim() !== String(value)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
    return value;
  }

  private nonNegativeDecimal(key: string, fallback: string) {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw !== 'string') {
      throw new Error(`${key} must be configured as a canonical decimal string`);
    }

    parseUnsignedErtDecimal(raw, key);
    return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }
}
