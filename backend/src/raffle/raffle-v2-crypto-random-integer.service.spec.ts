import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RaffleV2CryptoRandomIntegerService } from './raffle-v2-crypto-random-integer.service';
import { RAFFLE_V2_RANDOM_MAX_EXCLUSIVE } from './raffle-v2-random-integer.port';

describe('RaffleV2CryptoRandomIntegerService', () => {
  it('returns the sole valid ticket for an exclusive upper bound of one', () => {
    assert.equal(new RaffleV2CryptoRandomIntegerService().nextInt(1), 0);
  });

  it('rejects non-positive, fractional, unsafe, and unsupported bounds before crypto', () => {
    const service = new RaffleV2CryptoRandomIntegerService();
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER,
      RAFFLE_V2_RANDOM_MAX_EXCLUSIVE]) {
      assert.throws(() => service.nextInt(invalid), RangeError);
    }
  });
});
