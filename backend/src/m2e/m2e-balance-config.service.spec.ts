import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M2E_BALANCE_CONFIG_VERSION, M2eBalanceConfigService } from './m2e-balance-config.service';

class FakeConfigService {
  constructor(private readonly values: Record<string, string | number | undefined> = {}) {}

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

function service(values: Record<string, string | number | undefined> = {}) {
  return new M2eBalanceConfigService(new FakeConfigService(values) as never);
}

describe('M2eBalanceConfigService', () => {
  it('returns the single immutable approved balance config by default', () => {
    const instance = service();
    const config = instance.getConfig();
    assert.deepEqual(config, {
      version: M2E_BALANCE_CONFIG_VERSION,
      baseSteps: 5000,
      extraStepsPerRing: 1000,
      baseErtPer1000Steps: '0.871',
      comfortCurveK: 20,
    });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(instance.getConfig(), config);
  });

  it('reads canonical validated overrides', () => {
    assert.deepEqual(service({
      M2E_BASE_STEPS: '6000',
      M2E_EXTRA_STEPS_PER_RING: '1200',
      M2E_BASE_ERT_PER_1000_STEPS: '1.2500',
      M2E_COMFORT_CURVE_K: '25',
    }).getConfig(), {
      version: M2E_BALANCE_CONFIG_VERSION,
      baseSteps: 6000,
      extraStepsPerRing: 1200,
      baseErtPer1000Steps: '1.25',
      comfortCurveK: 25,
    });
  });

  it('rejects invalid overrides instead of silently falling back', () => {
    for (const values of [
      { M2E_BASE_STEPS: '0' },
      { M2E_EXTRA_STEPS_PER_RING: '-1' },
      { M2E_COMFORT_CURVE_K: '1.5' },
      { M2E_BASE_ERT_PER_1000_STEPS: '-0.1' },
      { M2E_BASE_ERT_PER_1000_STEPS: '1e-3' },
      { M2E_BASE_ERT_PER_1000_STEPS: 0.871 },
    ]) {
      assert.throws(() => service(values));
    }
  });
});
