import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { M2eBalanceConfigService } from './m2e-balance-config.service';
import { M2eEarningCalculator } from './m2e-earning-calculator';
import { canonicalErt, ErtDecimal } from './ert-decimal';

function calculator() {
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  return new M2eEarningCalculator(config);
}

describe('M2eEarningCalculator', () => {
  it('matches approved examples and two-decimal display values', () => {
    const calculate = calculator();
    assert.deepEqual(calculate.calculate({ validatedDailySteps: 5000, ringCount: 1, comfort: 20 }), {
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
      stepCap: 5000,
      validSteps: 5000,
      comfortMultiplier: '1.5',
      exactNumerator: '2613',
      exactDenominator: '400',
      authoritativeErt: '6.5325',
      displayedErt: '6.53',
    });
    assert.equal(calculate.calculate({ validatedDailySteps: 8000, ringCount: 4, comfort: 45 }).authoritativeErt, '11.792');
    assert.equal(calculate.calculate({ validatedDailySteps: 8000, ringCount: 4, comfort: 45 }).displayedErt, '11.79');
    assert.equal(calculate.calculate({ validatedDailySteps: 9000, ringCount: 1, comfort: 20 }).authoritativeErt, '6.5325');
  });

  it('applies all documented caps and excludes above-cap steps', () => {
    const calculate = calculator();
    const expected = [[1, 5000], [2, 6000], [3, 7000], [4, 8000], [10, 14000]];
    for (const [ringCount, stepCap] of expected) {
      const result = calculate.calculate({ validatedDailySteps: 99_999, ringCount, comfort: 0 });
      assert.equal(result.stepCap, stepCap);
      assert.equal(result.validSteps, stepCap);
    }
  });

  it('retains exact rational evidence for a non-terminating result', () => {
    const result = calculator().calculate({ validatedDailySteps: 1, ringCount: 1, comfort: 2 });
    assert.equal(result.exactNumerator, '2613');
    assert.equal(result.exactDenominator, '2750000');
    assert.equal(result.authoritativeErt, '0.000950181818181818');
    assert.equal(result.displayedErt, '0.00');
  });

  it('returns canonical zero without fabricating earnings', () => {
    const result = calculator().calculate({ validatedDailySteps: 0, ringCount: 1, comfort: 20 });
    assert.equal(result.exactNumerator, '0');
    assert.equal(result.exactDenominator, '1');
    assert.equal(result.authoritativeErt, '0');
    assert.equal(result.displayedErt, '0.00');
  });

  it('produces the same cumulative result for every batch partition', () => {
    const calculate = calculator();
    const cumulativeSteps = [197, 293, 2467, 5000, 8000];
    let credited = new ErtDecimal(0);

    for (const steps of cumulativeSteps) {
      const target = new ErtDecimal(calculate.calculate({
        validatedDailySteps: steps,
        ringCount: 4,
        comfort: 45,
      }).authoritativeErt);
      const delta = target.minus(credited);
      assert.equal(delta.isNegative(), false);
      credited = credited.plus(delta);
    }

    assert.equal(canonicalErt(credited), '11.792');
    assert.equal(
      canonicalErt(credited),
      calculate.calculate({ validatedDailySteps: 8000, ringCount: 4, comfort: 45 }).authoritativeErt,
    );
  });

  it('rejects invalid or unsafe integer economic inputs', () => {
    const calculate = calculator();
    for (const input of [
      { validatedDailySteps: -1, ringCount: 1, comfort: 1 },
      { validatedDailySteps: 1.5, ringCount: 1, comfort: 1 },
      { validatedDailySteps: 1, ringCount: 0, comfort: 1 },
      { validatedDailySteps: 1, ringCount: 1, comfort: -1 },
      { validatedDailySteps: Number.MAX_SAFE_INTEGER, ringCount: Number.MAX_SAFE_INTEGER, comfort: 1 },
    ]) {
      assert.throws(() => calculate.calculate(input));
    }
  });
});
