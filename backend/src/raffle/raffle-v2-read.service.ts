import { Inject, Injectable } from '@nestjs/common';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { canonicalEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import {
  encodeRaffleV2HistoryCursor,
  mapRaffleV2HistoryItem,
  mapRaffleV2Reward,
  parseRaffleV2HistoryQuery,
  RaffleV2ApiContractError,
} from './raffle-v2-api-contract';
import { RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RAFFLE_V2_CONTRACT_VERSION, RaffleV2DrawCoreError, RaffleV2DrawCoreFailure } from './raffle-v2-draw-core.service';
import { RAFFLE_V2_READ_REPOSITORY, RaffleV2CurrentReadSnapshot, RaffleV2ReadPersistence } from './raffle-v2-read.repository';
import { RewardType } from './reward.entity';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const supportedRewardTypes = new Set([RewardType.Ert, RewardType.Eru, RewardType.CopperRing]);

@Injectable()
export class RaffleV2ReadService {
  constructor(
    @Inject(RAFFLE_V2_READ_REPOSITORY)
    private readonly repository: RaffleV2ReadPersistence,
  ) {}

  async getCurrent(ownerUserId: string): Promise<Record<string, unknown>> {
    const ownerId = requireUuid(ownerUserId);
    const now = this.currentTime();
    const utcDate = now.toISOString().slice(0, 10);
    const snapshot = await this.repository.readCurrent(ownerId, utcDate);
    if (!snapshot.ownerExists) return invalidState();
    if (!snapshot.machine || !snapshot.machine.isAvailable || !snapshot.configuration) return unavailable();
    const configuration = snapshot.configuration;
    if (configuration.machineId !== snapshot.machine.id
      || configuration.contractVersion !== RAFFLE_V2_CONTRACT_VERSION
      || configuration.status !== RaffleConfigurationStatus.Active
      || !Number.isSafeInteger(configuration.dailyUserAttemptLimit)
      || configuration.dailyUserAttemptLimit <= 0
      || typeof configuration.title !== 'string'
      || configuration.title.length === 0
      || configuration.title.length > 128
      || (configuration.description !== null && typeof configuration.description !== 'string')) {
      return invalidState();
    }
    if (!Number.isSafeInteger(snapshot.attemptsUsed) || snapshot.attemptsUsed < 0) return invalidState();
    // Legacy draws share DailyUserStats. A pre-activation count above the active limit
    // is a consumed limit, not corrupt state, and must remain read-compatible.
    const costErtExact = requireContractCost(configuration.costErtExact);
    const attemptLimit = configuration.dailyUserAttemptLimit;
    const attemptsUsed = Math.min(snapshot.attemptsUsed, attemptLimit);

    const eligible = snapshot.rewards.filter((mapping) => {
      const reward = mapping.reward;
      assertLiveReward(snapshot, mapping.rewardId, reward?.id, reward?.type, reward?.isActive,
        reward?.stockTotal, reward?.stockRemaining, mapping.configurationId);
      return reward.type !== RewardType.CopperRing || !snapshot.copperAwarded;
    });
    if (eligible.length === 0) return unavailable();
    const totalWeight = eligible.reduce((sum, mapping) => {
      if (!Number.isSafeInteger(mapping.weight) || mapping.weight <= 0) return invalidState();
      const next = sum + mapping.weight;
      if (!Number.isSafeInteger(next)) return invalidState();
      return next;
    }, 0);
    const rewards = eligible.map((mapping) => {
      if (mapping.rewardSnapshot.type !== mapping.reward.type) return invalidState();
      assertLiveAmount(mapping.reward.type, mapping.reward.amount, mapping.reward.amountExactValue,
        mapping.rewardSnapshot.amountExact);
      return mapRaffleV2Reward({
        rewardId: mapping.rewardId,
        segmentIndex: mapping.segmentIndex,
        weight: mapping.weight,
        totalWeight,
        snapshot: mapping.rewardSnapshot,
      });
    });
    const resetsAt = nextUtcMidnight(utcDate);
    return frozenJson({
      contractVersion: RAFFLE_V2_CONTRACT_VERSION,
      serverTime: now.toISOString(),
      draw: {
        drawId: requireUuid(snapshot.machine.id),
        configurationVersion: requireUuid(configuration.id),
        title: configuration.title,
        description: configuration.description,
        cost: {
          currency: 'ERT',
          amountExact: costErtExact,
          amountDisplay: displayErt(costErtExact),
        },
        attempts: {
          limit: attemptLimit,
          used: attemptsUsed,
          remaining: attemptLimit - attemptsUsed,
          day: utcDate,
          resetsAt,
        },
        totalWeight: String(totalWeight),
        rewards,
      },
    });
  }

  async getHistory(ownerUserId: string, input: unknown): Promise<Record<string, unknown>> {
    const ownerId = requireUuid(ownerUserId);
    const query = parseRaffleV2HistoryQuery(input);
    const rows = await this.repository.readHistory(ownerId, query.limit, query.cursor);
    if (rows.length > query.limit + 1) return invalidState();
    const page = rows.slice(0, query.limit);
    const items = page.map((row) => mapRaffleV2HistoryItem(row.responseSnapshot, {
      operationId: row.operationId,
      drawResultId: row.drawResultId,
      createdAt: canonicalDate(row.createdAt),
    }));
    const last = rows.length > query.limit ? page.at(-1) : null;
    return frozenJson({
      contractVersion: RAFFLE_V2_CONTRACT_VERSION,
      items,
      nextCursor: last ? encodeRaffleV2HistoryCursor({
        createdAt: canonicalDate(last.createdAt),
        drawResultId: last.drawResultId,
      }) : null,
    });
  }

  protected currentTime() { return new Date(); }
}

function assertLiveReward(
  snapshot: RaffleV2CurrentReadSnapshot,
  rewardId: string,
  liveRewardId: string | undefined,
  type: RewardType | undefined,
  active: boolean | undefined,
  stockTotal: number | null | undefined,
  stockRemaining: number | null | undefined,
  configurationId: string,
) {
  if (configurationId !== snapshot.configuration?.id
    || rewardId !== liveRewardId
    || !type
    || !supportedRewardTypes.has(type)
    || active !== true
    || stockTotal !== null
    || stockRemaining !== null) invalidState();
}

function assertLiveAmount(type: RewardType, amount: number | null, amountExact: string | null, snapshotAmount: unknown) {
  if (type === RewardType.Ert
    && (!Number.isSafeInteger(amount) || String(amount) !== snapshotAmount)) invalidState();
  if (type === RewardType.Eru) {
    try {
      const live = canonicalEru(amountExact, 'live ERU reward');
      const snapshot = canonicalEru(snapshotAmount, 'snapshot ERU reward');
      parseUnsignedEruDecimal(live, 'live ERU reward', false);
      parseUnsignedEruDecimal(snapshot, 'snapshot ERU reward', false);
      if (live !== snapshot) invalidState();
    } catch {
      invalidState();
    }
  }
  if (type === RewardType.CopperRing
    && (amount !== null || amountExact !== null || snapshotAmount !== null)) invalidState();
}

function requireContractCost(value: string) {
  try {
    return canonicalErt(parseUnsignedErtDecimal(value, 'raffle v2 cost', false));
  } catch {
    return invalidState();
  }
}

function requireUuid(value: unknown) {
  if (typeof value !== 'string' || !uuidV4.test(value)) return invalidState();
  return value;
}

function canonicalDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return invalidState();
  return value.toISOString();
}

function nextUtcMidnight(utcDate: string) {
  const next = new Date(`${utcDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function frozenJson(value: unknown): Record<string, unknown> {
  try {
    const clone = JSON.parse(JSON.stringify(value)) as unknown;
    if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) return invalidState();
    return deepFreeze(clone as Record<string, unknown>);
  } catch (error) {
    if (error instanceof RaffleV2ApiContractError) throw error;
    return invalidState();
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value);
}

function unavailable(): never {
  throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.Unavailable);
}

function invalidState(): never {
  throw new RaffleV2ApiContractError('STATE');
}
