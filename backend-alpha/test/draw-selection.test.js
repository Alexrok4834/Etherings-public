import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDrawReward } from '../src/draw-selection.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const rewards = [90, 6, 3, 1].map((weight, segmentIndex) => ({
  rewardId: ids[segmentIndex], segmentIndex, weight,
  rewardSnapshot: { type: ['ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX'][segmentIndex] },
}));

test('owner-approved weights select exactly one backend outcome at every boundary', () => {
  for (const [ticket, index] of [[0, 0], [89, 0], [90, 1], [95, 1], [96, 2], [98, 2], [99, 3]]) {
    const selection = selectDrawReward(rewards, max => {
      assert.equal(max, 100);
      return ticket;
    });
    assert.equal(selection.algorithm, 'CSPRNG_UNBIASED_INT_V1');
    assert.equal(selection.selectedRewardId, ids[index]);
    assert.equal(selection.ranges.length, 4);
  }
});

test('invalid weights, duplicate rewards and out-of-range RNG fail closed', () => {
  assert.throws(() => selectDrawReward([{ ...rewards[0], weight: 0 }]));
  assert.throws(() => selectDrawReward([rewards[0], { ...rewards[1], rewardId: ids[0] }]));
  assert.throws(() => selectDrawReward(rewards, () => 100));
});
