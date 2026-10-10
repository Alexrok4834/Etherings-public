import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cooperBreedingPrice } from '../src/cooper-breeding-price.js';

test('approved 2x2 breeding matrix and additive ERU fee are exact', () => {
  for (const [a, b, ert, principal, fee, total, totalUnits] of [
    [0, 0, '150', '30', '0.6', '30.6', 30_600_000_000n],
    [0, 1, '200', '40', '0.8', '40.8', 40_800_000_000n],
    [1, 0, '200', '40', '0.8', '40.8', 40_800_000_000n],
    [1, 1, '250', '50', '1', '51', 51_000_000_000n],
  ]) {
    const price = cooperBreedingPrice(a, b);
    assert.equal(price.ertExact, ert);
    assert.equal(price.eruPrincipalExact, principal);
    assert.equal(price.eruFeeExact, fee);
    assert.equal(price.eruTotalExact, total);
    assert.equal(price.eruPrincipalUnits + price.eruFeeUnits, totalUnits);
  }
  for (const [a, b] of [[2, 0], [0, 2], [-1, 0], [0.5, 0], [0, null]])
    assert.equal(cooperBreedingPrice(a, b), null);
});
