import { Inject, Injectable } from '@nestjs/common';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { canonicalEru, displayEru, eruCompatibilityNumber } from '../balance/eru-decimal';
import { User } from '../auth/user.entity';
import { mapRaffleV2Reward, RaffleV2ApiContractError } from './raffle-v2-api-contract';
import { RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RAFFLE_V2_CONTRACT_VERSION } from './raffle-v2-draw-core.service';
import { RAFFLE_V2_READ_REPOSITORY, RaffleV2ReadPersistence } from './raffle-v2-read.repository';
import { RaffleV2ReadService } from './raffle-v2-read.service';
import { PublicRafflePool, RaffleHistoryItem, RaffleService } from './raffle.service';
import { RewardType } from './reward.entity';
import { UserReward } from './user-reward.entity';

@Injectable()
export class RaffleV2LegacyCompatibilityService {
  constructor(
    @Inject(RAFFLE_V2_READ_REPOSITORY)
    private readonly repository: RaffleV2ReadPersistence,
    private readonly reads: RaffleV2ReadService,
    private readonly legacy: RaffleService,
  ) {}

  async listPools(): Promise<PublicRafflePool[]> {
    const current = await this.repository.readLegacyCurrent();
    if (!current.machine || !current.configuration) return this.legacy.listPublicPools();
    return [mapLegacyPool(current)];
  }

  async listHistory(user: User): Promise<RaffleHistoryItem[]> {
    const [legacyItems, v2Response] = await Promise.all([
      this.legacy.listHistory(user),
      this.reads.getHistory(user.id, { limit: '50' }),
    ]);
    const v2Items = requireArray(v2Response.items);
    const resultIds = v2Items.map((item) => requireString(requireObject(requireObject(item).draw).drawResultId));
    const rewards = await this.repository.readUserRewardsForResults(user.id, resultIds);
    const byResult = new Map(rewards.map((reward) => [reward.raffleDrawResultV2Id, reward]));
    const adapted = v2Items.map((item) => {
      const record = requireObject(item);
      const resultId = requireString(requireObject(record.draw).drawResultId);
      const reward = byResult.get(resultId);
      if (!reward) return invalidState();
      return mapLegacyHistoryItem(record, reward);
    });
    return [...legacyItems, ...adapted]
      .sort((left, right) => historyTime(right) - historyTime(left))
      .slice(0, 50);
  }
}

function mapLegacyPool(current: Awaited<ReturnType<RaffleV2ReadPersistence['readLegacyCurrent']>>): PublicRafflePool {
  const { machine, configuration } = current;
  if (!machine || !configuration
    || configuration.machineId !== machine.id
    || configuration.contractVersion !== RAFFLE_V2_CONTRACT_VERSION
    || configuration.status !== RaffleConfigurationStatus.Active
    || !Number.isSafeInteger(configuration.dailyUserAttemptLimit)
    || configuration.dailyUserAttemptLimit <= 0) return invalidState();
  const costErtExact = contractCost(configuration.costErtExact);
  const totalWeight = current.rewards.reduce((sum, mapping) => {
    if (!mapping.reward || mapping.reward.id !== mapping.rewardId || !mapping.reward.isActive
      || ![RewardType.Ert, RewardType.Eru, RewardType.CopperRing].includes(mapping.reward.type)
      || mapping.reward.stockTotal !== null || mapping.reward.stockRemaining !== null
      || !Number.isSafeInteger(mapping.weight) || mapping.weight <= 0) return invalidState();
    const next = sum + mapping.weight;
    return Number.isSafeInteger(next) ? next : invalidState();
  }, 0);
  if (totalWeight <= 0) return invalidState();
  return {
    id: machine.id,
    code: machine.code,
    title: configuration.title,
    description: configuration.description,
    costErt: safeRequiredDecimal(costErtExact),
    costErtExact,
    costErtDisplay: displayErt(costErtExact),
    dailyUserAttemptLimit: configuration.dailyUserAttemptLimit,
    rewards: current.rewards.map((mapping) => {
      if (mapping.rewardSnapshot.type !== mapping.reward.type) return invalidState();
      const mapped = mapRaffleV2Reward({
        rewardId: mapping.rewardId,
        segmentIndex: mapping.segmentIndex,
        weight: mapping.weight,
        totalWeight,
        snapshot: mapping.rewardSnapshot,
      }) as Record<string, unknown>;
      const amountExact = mapped.amountExact === undefined ? null : requireString(mapped.amountExact);
      if (mapping.reward.type === RewardType.Ert
        && (!Number.isSafeInteger(mapping.reward.amount) || String(mapping.reward.amount) !== amountExact)) {
        return invalidState();
      }
      if (mapping.reward.type === RewardType.Eru
        && requireEru(mapping.reward.amountExactValue) !== requireEru(amountExact)) {
        return invalidState();
      }
      if (mapping.reward.type === RewardType.CopperRing
        && (mapping.reward.amount !== null || mapping.reward.amountExactValue !== null || amountExact !== null)) {
        return invalidState();
      }
      return {
        id: requireString(mapped.rewardId),
        code: requireString(mapped.code),
        title: requireString(mapped.title),
        description: null,
        type: mapped.type as RewardType,
        amount: mapping.reward.type === RewardType.Eru
          ? eruCompatibilityNumber(requireEru(amountExact))
          : safeCompatibilityInteger(amountExact),
        amountExact,
        amountDisplay: amountExact === null ? null : requireString(mapped.amountDisplay),
        metadata: mapped.asset ? { asset: mapped.asset } : null,
        imageUrl: mapped.imageUrl === null ? null : requireString(mapped.imageUrl),
        stockRemaining: null,
        weight: mapping.weight,
        probability: mapping.weight / totalWeight,
      };
    }),
  };
}

function mapLegacyHistoryItem(item: Record<string, unknown>, userReward: UserReward): RaffleHistoryItem {
  return {
    draw: legacyDraw(requireObject(item.draw), requireObject(item.selection), requireObject(item.reward)) as never,
    userReward: legacyUserReward(
      userReward,
      requireObject(item.reward),
      requireString(requireObject(item.draw).drawResultId),
    ) as never,
  };
}

function legacyDraw(draw: Record<string, unknown>, selection: Record<string, unknown>, reward: Record<string, unknown>) {
  const cost = requireObject(draw.cost);
  const amountExact = requireString(cost.amountExact);
  if (cost.currency !== 'ERT') return invalidState();
  contractCost(amountExact);
  const ticket = safeNonNegativeInteger(selection.ticket);
  const totalWeight = safePositiveInteger(selection.totalWeight);
  if (ticket >= totalWeight) return invalidState();
  return {
    id: requireString(draw.drawResultId),
    poolId: requireString(draw.drawId),
    rewardId: requireString(reward.rewardId),
    costErt: safeRequiredDecimal(amountExact),
    randomRoll: ticket / totalWeight,
    weightsSnapshot: {
      algorithm: selection.algorithm,
      ticket: String(ticket),
      totalWeight: String(totalWeight),
      ranges: selection.ranges,
    },
    rewardSnapshot: legacyRewardSnapshot(reward),
    createdAt: canonicalTimestamp(draw.createdAt),
    costErtExact: amountExact,
    costErtDisplay: requireString(cost.amountDisplay),
  };
}

function legacyRewardSnapshot(reward: Record<string, unknown>) {
  const amountExact = reward.amountExact === undefined ? null : requireString(reward.amountExact);
  return {
    id: requireString(reward.rewardId),
    code: requireString(reward.code),
    title: requireString(reward.title),
    description: null,
    type: requireString(reward.type),
    amount: safeCompatibilityInteger(amountExact),
    amountExact,
    amountDisplay: amountExact === null ? null : requireString(reward.amountDisplay),
    metadata: reward.asset ? { asset: reward.asset } : null,
    imageUrl: reward.imageUrl ?? null,
  };
}

function legacyUserReward(reward: UserReward, snapshot: Record<string, unknown>, drawResultId: string) {
  const amountExact = reward.type === RewardType.Ert
    ? (reward.amount === null ? null : String(reward.amount))
    : reward.type === RewardType.Eru ? requireEru(reward.amountExactValue) : reward.amountExactValue;
  const snapshotAmount = snapshot.amountExact === undefined ? null : requireString(snapshot.amountExact);
  const canonicalSnapshotAmount = reward.type === RewardType.Eru && snapshotAmount !== null
    ? requireEru(snapshotAmount)
    : snapshotAmount;
  if (reward.raffleDrawId !== null
    || reward.raffleDrawResultV2Id !== drawResultId
    || reward.rewardId !== snapshot.rewardId
    || reward.type !== snapshot.type
    || reward.title !== snapshot.title
    || amountExact !== canonicalSnapshotAmount) return invalidState();
  return {
    id: reward.id,
    userId: reward.userId,
    rewardId: reward.rewardId,
    raffleDrawId: null,
    raffleDrawResultV2Id: reward.raffleDrawResultV2Id,
    title: reward.title,
    type: reward.type,
    amount: reward.type === RewardType.Eru && amountExact !== null
      ? eruCompatibilityNumber(amountExact)
      : reward.amount,
    amountExact,
    amountDisplay: amountExact === null
      ? null
      : reward.type === RewardType.Ert ? displayErt(amountExact) : displayEru(requireEru(amountExact)),
    eruBalanceAfterExact: reward.eruBalanceAfterExact === null
      ? null : requireEru(reward.eruBalanceAfterExact),
    eruBalanceAfterDisplay: reward.eruBalanceAfterExact === null
      ? null : displayEru(requireEru(reward.eruBalanceAfterExact)),
    metadata: reward.metadata,
    createdAt: reward.createdAt,
  };
}

function requireEru(value: string | null) {
  if (value === null) return invalidState();
  try {
    return canonicalEru(value, 'legacy ERU value');
  } catch {
    return invalidState();
  }
}

function historyTime(item: RaffleHistoryItem) {
  const value = new Date((item.draw as unknown as { createdAt?: unknown }).createdAt as string).valueOf();
  return Number.isNaN(value) ? 0 : value;
}

function contractCost(value: string) {
  try {
    return canonicalErt(parseUnsignedErtDecimal(value, 'legacy raffle cost', false));
  } catch {
    return invalidState();
  }
}

function safeCompatibilityInteger(value: string | null) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function safeRequiredDecimal(value: string) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : invalidState();
}

function safeNonNegativeInteger(value: unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return invalidState();
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : invalidState();
}

function safePositiveInteger(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return invalidState();
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : invalidState();
}

function canonicalTimestamp(value: unknown) {
  if (typeof value !== 'string') return invalidState();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? invalidState() : value;
}

function requireString(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) return invalidState();
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidState();
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidState();
  return value;
}

function invalidState(): never {
  throw new RaffleV2ApiContractError('STATE');
}
