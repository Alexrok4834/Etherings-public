import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COPPER_LEVEL_ALLOCATION_POINTS,
  COPPER_MAX_LEVEL,
  COPPER_LEVEL_TRANSITIONS,
  COPPER_LEVEL_UP_VERSION,
  CopperLevelRuleViolation,
  CopperLevelRuleViolationCode,
  applyCopperAttributeAllocation,
  findCopperLevelTransition,
  parseCopperAttributeAllocation,
} from './copper-level-up.rules';

describe('Copper level-up v2 rules', () => {
  it('encodes every approved sequential transition through level 20', () => {
    assert.deepEqual(
      COPPER_LEVEL_TRANSITIONS.map((rule) => [
        rule.currentLevel,
        rule.targetLevel,
        rule.ertCost,
        rule.eruCost,
      ]),
      [
        [1, 2, 12, 0],
        [2, 3, 16, 0],
        [3, 4, 20, 0],
        [4, 5, 24, 30],
        [5, 6, 28, 0],
        [6, 7, 32, 0],
        [7, 8, 36, 0],
        [8, 9, 40, 0],
        [9, 10, 44, 0],
        [10, 11, 48, 0],
        [11, 12, 52, 0],
        [12, 13, 56, 0],
        [13, 14, 60, 0],
        [14, 15, 64, 0],
        [15, 16, 68, 0],
        [16, 17, 72, 0],
        [17, 18, 76, 0],
        [18, 19, 80, 0],
        [19, 20, 84, 60],
      ],
    );
  });

  it('keeps version, point grant, ERU dependencies, and cumulative totals exact', () => {
    assert.equal(COPPER_LEVEL_TRANSITIONS.length, 19);
    assert.equal(COPPER_LEVEL_UP_VERSION, 'copper-level-up-v2');
    assert.equal(COPPER_MAX_LEVEL, 20);
    assert.equal(COPPER_LEVEL_TRANSITIONS.every((rule) => rule.rulesVersion === COPPER_LEVEL_UP_VERSION), true);
    assert.equal(COPPER_LEVEL_TRANSITIONS.every((rule) => rule.allocationPoints === 4), true);
    assert.deepEqual(
      COPPER_LEVEL_TRANSITIONS.filter((rule) => rule.requiresEruLedger).map((rule) => rule.targetLevel),
      [5, 20],
    );
    assert.equal(COPPER_LEVEL_TRANSITIONS.reduce((sum, rule) => sum + rule.ertCost, 0), 912);
    assert.equal(COPPER_LEVEL_TRANSITIONS.reduce((sum, rule) => sum + rule.eruCost, 0), 90);
    assert.equal(
      COPPER_LEVEL_TRANSITIONS.reduce((sum, rule) => sum + rule.allocationPoints, 0),
      76,
    );
    assert.equal(Object.isFrozen(COPPER_LEVEL_TRANSITIONS), true);
    assert.equal(COPPER_LEVEL_TRANSITIONS.every(Object.isFrozen), true);
  });

  it('adds allocated points permanently without applying the initial-generation limit of 20', () => {
    const result = applyCopperAttributeAllocation(
      { comfort: 2, charm: 20, quality: 7, luck: 11 },
      parseCopperAttributeAllocation({ comfort: 1, charm: 1, quality: 2, luck: 0 }),
    );

    assert.deepEqual(result, { comfort: 3, charm: 21, quality: 9, luck: 11 });
    assert.equal(Object.isFrozen(result), true);
  });

  it('resolves only an exact encoded source and target pair', () => {
    assert.equal(findCopperLevelTransition(1, 2)?.ertCost, 12);
    assert.equal(findCopperLevelTransition(4, 5)?.eruCost, 30);
    assert.equal(findCopperLevelTransition(19, 20)?.eruCost, 60);
    assert.equal(findCopperLevelTransition(1, 3), null);
    assert.equal(findCopperLevelTransition(20, 21), null);
    assert.equal(findCopperLevelTransition(2, 1), null);
  });

  it('accepts exactly four non-negative integer points in all four named fields', () => {
    const valid = [
      { comfort: 4, charm: 0, quality: 0, luck: 0 },
      { comfort: 2, charm: 2, quality: 0, luck: 0 },
      { comfort: 2, charm: 1, quality: 1, luck: 0 },
      { comfort: 1, charm: 1, quality: 1, luck: 1 },
      { comfort: 0, charm: 0, quality: 0, luck: 4 },
    ];

    for (const allocation of valid) {
      const parsed = parseCopperAttributeAllocation(allocation);
      assert.deepEqual(parsed, allocation);
      assert.equal(Object.values(parsed).reduce((sum, points) => sum + points, 0), COPPER_LEVEL_ALLOCATION_POINTS);
      assert.equal(Object.isFrozen(parsed), true);
    }
  });

  it('rejects malformed, partial, fractional, negative, unsafe, and over/under allocations', () => {
    const invalid = [
      null,
      [],
      {},
      { comfort: 4, charm: 0, quality: 0 },
      { comfort: 4, charm: 0, quality: 0, luck: 0, shine: 0 },
      { comfort: 3, charm: 0, quality: 0, luck: 0 },
      { comfort: 5, charm: 0, quality: 0, luck: 0 },
      { comfort: -1, charm: 1, quality: 0, luck: 4 },
      { comfort: 0.5, charm: 0.5, quality: 1, luck: 2 },
      { comfort: '4', charm: 0, quality: 0, luck: 0 },
      { comfort: Number.MAX_SAFE_INTEGER + 1, charm: 0, quality: 0, luck: 0 },
      { comfort: Number.NaN, charm: 0, quality: 0, luck: 4 },
      { comfort: Number.POSITIVE_INFINITY, charm: 0, quality: 0, luck: 4 },
    ];

    for (const allocation of invalid) {
      assert.throws(() => parseCopperAttributeAllocation(allocation), (error) => {
        assert.equal(error instanceof CopperLevelRuleViolation, true);
        assert.equal(
          (error as CopperLevelRuleViolation).code,
          CopperLevelRuleViolationCode.InvalidAllocation,
        );
        return true;
      });
    }
  });
});
