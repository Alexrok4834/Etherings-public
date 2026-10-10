import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COOPER_VISUAL_CODES, generateCooperInitial } from '../src/cooper-generation.js';

test('starter and Draw Cooper share MVP initial attributes and visual set', () => {
  const calls = [];
  const initial = generateCooperInitial((min, max) => {
    calls.push([min, max]);
    return min;
  });
  assert.deepEqual(calls, [[2, 21], [2, 21], [2, 21], [2, 21], [0, 9]]);
  assert.deepEqual(initial, { comfort: 2, charm: 2, quality: 2, luck: 2,
    visualVariantCode: COOPER_VISUAL_CODES[0] });
  assert.equal(COOPER_VISUAL_CODES.length, 9);
  assert.throws(() => generateCooperInitial((min, max) => max));
});
