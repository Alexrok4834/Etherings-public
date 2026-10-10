import Decimal from 'decimal.js';
import { canonicalErt, ErtDecimal, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { canonicalEru, parseUnsignedEruDecimal, quantizeEru } from '../balance/eru-decimal';

const positiveInteger = /^[1-9][0-9]{0,29}$/;
const supportedTypes = new Set(['ERT', 'ERU', 'COPPER_RING']);

export type RaffleV2ValidationReward = Readonly<{
  rewardId: string;
  segmentIndex: number;
  weight: number;
  snapshot: Readonly<Record<string, unknown>>;
  live: Readonly<{
    id: string;
    type: string;
    active: boolean;
    amount: string | number | null;
    amountExact: string | null;
    stockTotal: number | null;
    stockRemaining: number | null;
    perUserLimit: number | null;
    dailyGlobalLimit: number | null;
  }>;
}>;

export type RaffleV2ValidationCandidate = Readonly<{
  costErtExact: string;
  dailyUserAttemptLimit: number;
  rewards: ReadonlyArray<RaffleV2ValidationReward>;
}>;

export type RaffleV2ValidationIssue = Readonly<{
  severity: 'ERROR' | 'WARNING';
  code: string;
  path: string;
  message: string;
}>;

export function validateRaffleV2Configuration(candidate: RaffleV2ValidationCandidate) {
  const issues: RaffleV2ValidationIssue[] = [];
  let cost: Decimal | null = null;
  try {
    cost = parseUnsignedErtDecimal(candidate.costErtExact, 'costErtExact', false);
  } catch {
    error(issues, 'COST_INVALID', 'costErtExact', 'Entry price must be a canonical positive ERT decimal');
  }
  if (!Number.isSafeInteger(candidate.dailyUserAttemptLimit) || candidate.dailyUserAttemptLimit <= 0
    || candidate.dailyUserAttemptLimit > 32767) {
    error(issues, 'ATTEMPT_LIMIT_INVALID', 'dailyUserAttemptLimit', 'Daily attempt limit is outside the supported range');
  }
  if (candidate.rewards.length === 0) {
    error(issues, 'OUTCOMES_EMPTY', 'rewards', 'At least one reward outcome is required');
  }
  if (candidate.rewards.length > 100) {
    error(issues, 'OUTCOMES_EXCESSIVE', 'rewards', 'At most 100 reward outcomes are supported');
  }

  const rewardIds = new Set<string>();
  let totalWeight = 0;
  let expectedErt = new ErtDecimal(0);
  let expectedEru = new ErtDecimal(0);
  let expectedRings = new ErtDecimal(0);
  const normalized: Array<{ reward: RaffleV2ValidationReward; amount: Decimal | null }> = [];

  for (const [index, reward] of candidate.rewards.entries()) {
    const path = `rewards[${index}]`;
    if (rewardIds.has(reward.rewardId)) error(issues, 'REWARD_DUPLICATE', `${path}.rewardId`, 'A reward may appear only once');
    rewardIds.add(reward.rewardId);
    if (reward.segmentIndex !== index) error(issues, 'SEGMENTS_NOT_CONTIGUOUS', `${path}.segmentIndex`, 'Segment indices must be contiguous and ordered');
    if (!Number.isSafeInteger(reward.weight) || reward.weight <= 0) {
      error(issues, 'WEIGHT_INVALID', `${path}.weight`, 'Weight must be a positive safe integer');
    } else {
      totalWeight += reward.weight;
      if (!Number.isSafeInteger(totalWeight) || totalWeight > 2_147_483_647) {
        error(issues, 'TOTAL_WEIGHT_UNSUPPORTED', 'rewards', 'Total weight exceeds the signed 32-bit runtime range');
      }
    }
    if (reward.live.id !== reward.rewardId || reward.snapshot.rewardId !== reward.rewardId) {
      error(issues, 'REWARD_IDENTITY_MISMATCH', path, 'Catalog and snapshot reward identities must match the mapping');
    }
    if (!reward.live.active) error(issues, 'REWARD_INACTIVE', path, 'Inactive rewards cannot be activated');
    if (!supportedTypes.has(reward.live.type) || reward.snapshot.type !== reward.live.type) {
      error(issues, 'REWARD_TYPE_UNSUPPORTED', path, 'Reward type has no Raffle v2 fulfillment handler');
    }
    if ([reward.live.stockTotal, reward.live.stockRemaining, reward.live.perUserLimit, reward.live.dailyGlobalLimit]
      .some((value) => value !== null)) {
      error(issues, 'REWARD_LIMIT_UNSUPPORTED', path, 'Configured stock and eligibility limits are not enforced by the current fulfillment runtime');
    }

    let amount: Decimal | null = null;
    if (reward.live.type === 'COPPER_RING') {
      if (reward.live.amount !== null || reward.live.amountExact !== null || reward.snapshot.amountExact !== null) {
        error(issues, 'COPPER_REWARD_SHAPE_INVALID', path, 'Cooper Ring rewards must issue exactly one Ring without a currency amount');
      }
    } else {
      const snapshotAmount = reward.snapshot.amountExact;
      try {
        if (reward.live.type === 'ERU') {
          const exact = canonicalEru(snapshotAmount, `${path}.snapshot.amountExact`);
          parseUnsignedEruDecimal(exact, `${path}.snapshot.amountExact`, false);
          const liveAmount = canonicalEru(reward.live.amountExact, `${path}.live.amountExact`);
          parseUnsignedEruDecimal(liveAmount, `${path}.live.amountExact`, false);
          if (exact !== liveAmount) error(issues, 'REWARD_AMOUNT_MISMATCH', path, 'Catalog and snapshot amounts must match');
          amount = new ErtDecimal(exact);
        } else {
          if (typeof snapshotAmount !== 'string' || !positiveInteger.test(snapshotAmount)) throw new Error('invalid ERT reward');
          const liveAmount = String(reward.live.amount);
          if (snapshotAmount !== liveAmount) error(issues, 'REWARD_AMOUNT_MISMATCH', path, 'Catalog and snapshot amounts must match');
          amount = new ErtDecimal(snapshotAmount);
        }
      } catch {
        error(issues, 'REWARD_AMOUNT_INVALID', `${path}.snapshot.amountExact`,
          reward.live.type === 'ERU'
            ? 'ERU reward amount must be a positive decimal with at most 30 integer and 18 fractional digits'
            : 'ERT reward amount must be a canonical positive integer');
      }
    }
    normalized.push({ reward, amount });
  }

  if (totalWeight > 0 && totalWeight <= 2_147_483_647) {
    for (const item of normalized) {
      if (!Number.isSafeInteger(item.reward.weight) || item.reward.weight <= 0) continue;
      const probability = new ErtDecimal(item.reward.weight).div(totalWeight);
      if (item.reward.live.type === 'ERT' && item.amount) expectedErt = expectedErt.plus(probability.mul(item.amount));
      if (item.reward.live.type === 'ERU' && item.amount) expectedEru = expectedEru.plus(probability.mul(item.amount));
      if (item.reward.live.type === 'COPPER_RING') expectedRings = expectedRings.plus(probability);
    }
  }
  if (cost && expectedErt.greaterThanOrEqualTo(cost)) {
    warning(issues, 'ERT_EXPECTED_RETURN_NOT_BELOW_COST', 'economy.expectedErtPerDraw', 'Expected ERT reward is not below the ERT entry price');
  }

  const attempts = Number.isSafeInteger(candidate.dailyUserAttemptLimit) && candidate.dailyUserAttemptLimit > 0
    ? candidate.dailyUserAttemptLimit : 0;
  return {
    valid: !issues.some((issue) => issue.severity === 'ERROR'),
    issues,
    totalWeight: String(totalWeight),
    outcomes: candidate.rewards.map((reward) => ({
      rewardId: reward.rewardId,
      segmentIndex: reward.segmentIndex,
      weight: String(reward.weight),
      probability: { numerator: String(reward.weight), denominator: String(totalWeight) },
    })),
    economy: {
      entryCostErtExact: cost ? canonicalErt(cost) : null,
      expectedPerDraw: expectation(expectedErt, expectedEru, expectedRings),
      expectedPerUserDayAtLimit: expectation(
        expectedErt.mul(attempts), expectedEru.mul(attempts), expectedRings.mul(attempts),
      ),
    },
  };
}

function expectation(ert: Decimal, eru: Decimal, rings: Decimal) {
  return {
    ertExact: canonicalErt(ert),
    eruExact: quantizeEru(eru, 'expected ERU'),
    ringsExact: canonicalErt(rings),
  };
}

function error(issues: RaffleV2ValidationIssue[], code: string, path: string, message: string) {
  issues.push({ severity: 'ERROR', code, path, message });
}

function warning(issues: RaffleV2ValidationIssue[], code: string, path: string, message: string) {
  issues.push({ severity: 'WARNING', code, path, message });
}
