import { Inject, Injectable } from '@nestjs/common';
import {
  isValidRaffleRandomBound,
  isValidRaffleRandomTicket,
  RAFFLE_V2_RANDOM_ALGORITHM,
  RAFFLE_V2_RANDOM_INTEGER_PORT,
  RaffleV2RandomIntegerPort,
} from './raffle-v2-random-integer.port';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export enum RaffleV2SelectionFailure {
  NoEligibleReward = 'NO_ELIGIBLE_REWARD',
  InvalidState = 'INVALID_STATE',
  InvalidRandomTicket = 'INVALID_RANDOM_TICKET',
}

export class RaffleV2SelectionError extends Error {
  constructor(readonly reason: RaffleV2SelectionFailure) {
    super(`Raffle v2 selection failed: ${reason}`);
    this.name = 'RaffleV2SelectionError';
  }
}

export type RaffleV2EligibleSegment = Readonly<{
  segmentIndex: number;
  rewardId: string;
  weight: number;
  rewardSnapshot: Readonly<Record<string, unknown>>;
}>;

export type RaffleV2SelectionRange = Readonly<{
  segmentIndex: number;
  rewardId: string;
  weight: number;
  startInclusive: number;
  endExclusive: number;
  rewardSnapshot: Readonly<Record<string, unknown>>;
}>;

export type RaffleV2IntegerSelection = Readonly<{
  algorithm: typeof RAFFLE_V2_RANDOM_ALGORITHM;
  ticket: number;
  totalWeight: number;
  selectedSegmentIndex: number;
  selectedRewardId: string;
  selectedRewardSnapshot: Readonly<Record<string, unknown>>;
  ranges: ReadonlyArray<RaffleV2SelectionRange>;
}>;

@Injectable()
export class RaffleV2IntegerSelectionService {
  constructor(
    @Inject(RAFFLE_V2_RANDOM_INTEGER_PORT)
    private readonly random: RaffleV2RandomIntegerPort,
  ) {}

  select(input: ReadonlyArray<RaffleV2EligibleSegment>): RaffleV2IntegerSelection {
    if (!Array.isArray(input) || input.length === 0) {
      throw new RaffleV2SelectionError(RaffleV2SelectionFailure.NoEligibleReward);
    }

    const ordered = [...input].sort((left, right) => left.segmentIndex - right.segmentIndex);
    const segmentIndexes = new Set<number>();
    const rewardIds = new Set<string>();
    const ranges: RaffleV2SelectionRange[] = [];
    let cursor = 0;

    for (const segment of ordered) {
      const normalizedRewardId = typeof segment.rewardId === 'string'
        ? segment.rewardId.toLowerCase()
        : '';
      if (!Number.isSafeInteger(segment.segmentIndex)
        || segment.segmentIndex < 0
        || segmentIndexes.has(segment.segmentIndex)
        || !uuid.test(normalizedRewardId)
        || rewardIds.has(normalizedRewardId)
        || !Number.isSafeInteger(segment.weight)
        || segment.weight <= 0) {
        throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidState);
      }

      const rewardSnapshot = immutableJsonObject(segment.rewardSnapshot);
      const endExclusive = cursor + segment.weight;
      if (!isValidRaffleRandomBound(endExclusive)) {
        throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidState);
      }

      ranges.push(Object.freeze({
        segmentIndex: segment.segmentIndex,
        rewardId: normalizedRewardId,
        weight: segment.weight,
        startInclusive: cursor,
        endExclusive,
        rewardSnapshot,
      }));
      segmentIndexes.add(segment.segmentIndex);
      rewardIds.add(normalizedRewardId);
      cursor = endExclusive;
    }

    const ticket = this.random.nextInt(cursor);
    if (!isValidRaffleRandomTicket(ticket, cursor)) {
      throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidRandomTicket);
    }

    const selected = ranges.find((range) => range.startInclusive <= ticket && ticket < range.endExclusive);
    if (!selected) {
      throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidState);
    }

    return Object.freeze({
      algorithm: RAFFLE_V2_RANDOM_ALGORITHM,
      ticket,
      totalWeight: cursor,
      selectedSegmentIndex: selected.segmentIndex,
      selectedRewardId: selected.rewardId,
      selectedRewardSnapshot: selected.rewardSnapshot,
      ranges: Object.freeze(ranges),
    });
  }
}

function immutableJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidState);
  }

  try {
    const serialized = JSON.stringify(value);
    const clone = JSON.parse(serialized) as unknown;
    if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) throw new Error('not an object');
    return deepFreeze(clone) as Readonly<Record<string, unknown>>;
  } catch {
    throw new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidState);
  }
}

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
