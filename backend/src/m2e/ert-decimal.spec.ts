import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from './ert-decimal';

describe('ERT decimal contract', () => {
  it('formats authoritative and display values without binary floating point', () => {
    assert.equal(canonicalErt('6.532500000000000000'), '6.5325');
    assert.equal(displayErt('6.5325'), '6.53');
    assert.equal(displayErt('11.792'), '11.79');
    assert.equal(displayErt('2'), '2.00');
    assert.equal(displayErt('1.005'), '1.01');
  });

  it('accepts canonical strings through scale 18', () => {
    assert.equal(parseUnsignedErtDecimal('0', 'amount').toString(), '0');
    assert.equal(
      parseUnsignedErtDecimal('123.123456789012345678', 'amount').toFixed(18),
      '123.123456789012345678',
    );
  });

  it('rejects numbers and non-canonical decimal strings', () => {
    for (const value of [1.5, -1, '', '.5', '01', '+1', '-1', '1.', '1e-3', '1.1234567890123456789']) {
      assert.throws(() => parseUnsignedErtDecimal(value, 'amount'));
    }
    assert.throws(() => parseUnsignedErtDecimal('0', 'amount', false));
  });
});
