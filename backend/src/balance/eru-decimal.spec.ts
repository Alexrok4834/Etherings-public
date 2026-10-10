import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalEru,
  displayEru,
  eruCompatibilityNumber,
  hasEnoughEru,
  parseUnsignedEruDecimal,
  quantizeEru,
} from './eru-decimal';

describe('ERU decimal contract', () => {
  it('normalizes exact values and formats only the display with HALF_UP', () => {
    assert.equal(canonicalEru('0'), '0');
    assert.equal(canonicalEru('30.000000000000000000'), '30');
    assert.equal(canonicalEru('1.2300'), '1.23');
    assert.equal(displayEru('1.234'), '1.23');
    assert.equal(displayEru('1.235'), '1.24');
    assert.equal(displayEru('99.999999999999999999'), '100.00');
  });

  it('rejects malformed, signed, excess-scale, and excess-magnitude values', () => {
    for (const value of [1, '', '00', '.1', '1.', '+1', '-1', '1e3', 'NaN',
      '1.1234567890123456789', `${'9'.repeat(31)}.1`]) {
      assert.throws(() => parseUnsignedEruDecimal(value), /canonical ERU decimal/);
    }
    assert.throws(() => parseUnsignedEruDecimal('0', 'amount', false), /positive/);
  });

  it('uses decimals for affordability and emits legacy numbers only for safe integers', () => {
    assert.equal(hasEnoughEru('30.125', '30.124999999999999999'), true);
    assert.equal(hasEnoughEru('30.124999999999999999', '30.125'), false);
    assert.equal(eruCompatibilityNumber('30'), 30);
    assert.equal(eruCompatibilityNumber('30.5'), null);
    assert.equal(eruCompatibilityNumber('9007199254740992'), null);
  });

  it('quantizes approved calculated values only at the 18-place accounting boundary', () => {
    assert.equal(quantizeEru('1.2345678901234567894'), '1.234567890123456789');
    assert.equal(quantizeEru('1.2345678901234567895'), '1.23456789012345679');
  });
});
