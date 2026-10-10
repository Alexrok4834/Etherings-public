import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RaffleV2EligibleSegment,
  RaffleV2IntegerSelectionService,
  RaffleV2SelectionError,
  RaffleV2SelectionFailure,
} from './raffle-v2-integer-selection.service';
import { RAFFLE_V2_RANDOM_ALGORITHM, RaffleV2RandomIntegerPort } from './raffle-v2-random-integer.port';

const approvedWeights = [30, 20, 12, 6, 15, 9, 5, 2, 1];

class FixedRandom implements RaffleV2RandomIntegerPort {
  readonly calls: number[] = [];

  constructor(private readonly ticket: number) {}

  nextInt(maxExclusive: number) {
    this.calls.push(maxExclusive);
    return this.ticket;
  }
}

function rewardId(index: number) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function segments(weights: number[] = approvedWeights): RaffleV2EligibleSegment[] {
  return weights.map((weight, segmentIndex) => ({
    segmentIndex,
    rewardId: rewardId(segmentIndex),
    weight,
    rewardSnapshot: { code: `reward-${segmentIndex}`, amountExact: String(segmentIndex + 1) },
  }));
}

function select(ticket: number, input = segments()) {
  const random = new FixedRandom(ticket);
  return { result: new RaffleV2IntegerSelectionService(random).select(input), random };
}

function expectSelectionFailure(
  input: RaffleV2EligibleSegment[],
  reason: RaffleV2SelectionFailure,
) {
  const random = new FixedRandom(0);
  assert.throws(
    () => new RaffleV2IntegerSelectionService(random).select(input),
    (error) => error instanceof RaffleV2SelectionError && error.reason === reason,
  );
  assert.deepEqual(random.calls, []);
}

describe('RaffleV2IntegerSelectionService', () => {
  it('maps every approved 100-weight boundary and calls RNG exactly once', () => {
    const cases = [
      [0, 0], [29, 0], [30, 1], [49, 1], [50, 2], [61, 2], [62, 3], [67, 3],
      [68, 4], [82, 4], [83, 5], [91, 5], [92, 6], [96, 6], [97, 7], [98, 7], [99, 8],
    ];

    for (const [ticket, selectedSegmentIndex] of cases) {
      const { result, random } = select(ticket);
      assert.equal(result.algorithm, RAFFLE_V2_RANDOM_ALGORITHM);
      assert.equal(result.totalWeight, 100);
      assert.equal(result.selectedSegmentIndex, selectedSegmentIndex);
      assert.deepEqual(random.calls, [100]);
    }
  });

  it('rebuilds unchanged currency weights contiguously with denominator 99', () => {
    const input = segments().slice(0, -1);
    const { result, random } = select(98, input);

    assert.equal(result.totalWeight, 99);
    assert.equal(result.selectedSegmentIndex, 7);
    assert.equal(result.ranges[0].startInclusive, 0);
    assert.equal(result.ranges.at(-1)?.endExclusive, 99);
    assert.deepEqual(random.calls, [99]);
  });

  it('sorts a copy by original segment index and does not mutate input order', () => {
    const input = [segments()[2], segments()[0], segments()[1]];
    const originalOrder = input.map((segment) => segment.segmentIndex);
    const { result } = select(31, input);

    assert.deepEqual(input.map((segment) => segment.segmentIndex), originalOrder);
    assert.deepEqual(result.ranges.map((range) => range.segmentIndex), [0, 1, 2]);
    assert.equal(result.selectedSegmentIndex, 1);
  });

  it('proves contiguous ranges and exactly one winner for every bounded fixture ticket', () => {
    for (let count = 1; count <= 12; count += 1) {
      const weights = Array.from({ length: count }, (_, index) => index + 1);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      for (let ticket = 0; ticket < total; ticket += 1) {
        const { result } = select(ticket, segments(weights));
        assert.equal(result.totalWeight, total);
        assert.equal(result.ranges[0].startInclusive, 0);
        assert.equal(result.ranges.at(-1)?.endExclusive, total);
        result.ranges.forEach((range, index) => {
          if (index > 0) assert.equal(range.startInclusive, result.ranges[index - 1].endExclusive);
          assert.ok(range.endExclusive > range.startInclusive);
        });
        const matching = result.ranges.filter(
          (range) => range.startInclusive <= ticket && ticket < range.endExclusive,
        );
        assert.equal(matching.length, 1);
        assert.equal(result.selectedSegmentIndex, matching[0].segmentIndex);
        assert.equal(result.selectedRewardId, matching[0].rewardId);
      }
    }
  });

  it('copies and deeply freezes reward evidence before RNG', () => {
    const snapshot = { code: 'reward', nested: { amountExact: '5' } };
    const input = [{ segmentIndex: 0, rewardId: rewardId(0), weight: 1, rewardSnapshot: snapshot }];
    const { result } = select(0, input);
    snapshot.nested.amountExact = '999';

    assert.deepEqual(result.selectedRewardSnapshot, { code: 'reward', nested: { amountExact: '5' } });
    assert.ok(Object.isFrozen(result.selectedRewardSnapshot));
    assert.ok(Object.isFrozen(result.selectedRewardSnapshot.nested));
  });

  it('rejects empty or malformed eligibility without calling RNG', () => {
    expectSelectionFailure([], RaffleV2SelectionFailure.NoEligibleReward);
    expectSelectionFailure([{ ...segments()[0], weight: 0 }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([{ ...segments()[0], weight: 1.5 }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([{ ...segments()[0], rewardId: 'invalid' }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([{
      ...segments()[0],
      rewardSnapshot: [] as unknown as Readonly<Record<string, unknown>>,
    }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([segments()[0], { ...segments()[1], segmentIndex: 0 }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([segments()[0], { ...segments()[1], rewardId: rewardId(0).toUpperCase() }], RaffleV2SelectionFailure.InvalidState);
    expectSelectionFailure([
      { ...segments()[0], weight: (2 ** 48) - 1 },
      { ...segments()[1], weight: 1 },
    ], RaffleV2SelectionFailure.InvalidState);
  });

  it('rejects an invalid injected ticket without falling back to a reward', () => {
    for (const ticket of [-1, 100, 1.5, Number.NaN]) {
      const random = new FixedRandom(ticket);
      assert.throws(
        () => new RaffleV2IntegerSelectionService(random).select(segments()),
        (error) => error instanceof RaffleV2SelectionError
          && error.reason === RaffleV2SelectionFailure.InvalidRandomTicket,
      );
      assert.deepEqual(random.calls, [100]);
    }
  });
});
