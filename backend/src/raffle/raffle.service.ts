import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { canonicalErt, displayErt } from '../m2e/ert-decimal';
import { canonicalEru, displayEru, eruCompatibilityNumber, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { RaffleDraw } from './raffle-draw.entity';
import { RafflePoolReward } from './raffle-pool-reward.entity';
import { RafflePool } from './raffle-pool.entity';
import { RaffleSelectionService } from './raffle-selection.service';
import { Reward, RewardType } from './reward.entity';
import { UserReward } from './user-reward.entity';

export type PublicRaffleReward = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  type: Reward['type'];
  amount: number | null;
  amountExact: string | null;
  amountDisplay: string | null;
  metadata: Record<string, unknown> | null;
  imageUrl: string | null;
  stockRemaining: number | null;
  weight: number;
  probability: number;
};

export type PublicRafflePool = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  costErt: number;
  costErtExact: string;
  costErtDisplay: string;
  dailyUserAttemptLimit: number | null;
  rewards: PublicRaffleReward[];
};

export type RaffleDrawContract = RaffleDraw & {
  costErtExact: string;
  costErtDisplay: string;
  rewardSnapshot: Record<string, unknown> & {
    amountExact: string | null;
    amountDisplay: string | null;
  };
};

export type UserRewardContract = Omit<UserReward, 'amountExactValue'> & {
  amountExact: string | null;
  amountDisplay: string | null;
  eruBalanceAfterDisplay: string | null;
};

export type RaffleHistoryItem = {
  draw: RaffleDrawContract;
  userReward: UserRewardContract | null;
};

@Injectable()
export class RaffleService {
  constructor(
    @InjectRepository(RafflePool)
    private readonly rafflePoolRepository: Repository<RafflePool>,
    @InjectRepository(RafflePoolReward)
    private readonly rafflePoolRewardRepository: Repository<RafflePoolReward>,
    private readonly raffleSelectionService: RaffleSelectionService,
    private readonly dataSource: DataSource,
  ) {}

  async listPublicPools(now = new Date()): Promise<PublicRafflePool[]> {
    const allPools = await this.rafflePoolRepository.find({
      where: { isActive: true },
      order: { createdAt: 'ASC' },
    });
    const pools = allPools.filter((pool) => pool.isActive);

    if (pools.length === 0) {
      return [];
    }

    const poolIds = pools.map((pool) => pool.id);
    const poolRewards = await this.rafflePoolRewardRepository.find({
      where: { poolId: In(poolIds), isActive: true },
      relations: { reward: true },
      order: { createdAt: 'ASC' },
    });

    const rewardsByPoolId = new Map<string, RafflePoolReward[]>();

    for (const poolReward of poolRewards) {
      if (!poolIds.includes(poolReward.poolId) || !this.raffleSelectionService.isEligible(poolReward, now)) {
        continue;
      }

      const rewards = rewardsByPoolId.get(poolReward.poolId) ?? [];
      rewards.push(poolReward);
      rewardsByPoolId.set(poolReward.poolId, rewards);
    }

    return pools.map((pool) => {
      const visibleRewards = rewardsByPoolId.get(pool.id) ?? [];
      const totalWeight = visibleRewards.reduce((sum, poolReward) => sum + poolReward.weight, 0);

      return {
        id: pool.id,
        code: pool.code,
        title: pool.title,
        description: pool.description,
        costErt: pool.costErt,
        costErtExact: exactIntegerErt(pool.costErt, 'pool.costErt'),
        costErtDisplay: displayErt(exactIntegerErt(pool.costErt, 'pool.costErt')),
        dailyUserAttemptLimit: pool.dailyUserAttemptLimit,
        rewards: visibleRewards.map((poolReward) => this.toPublicReward(poolReward, totalWeight)),
      };
    });
  }

  async listHistory(user: User): Promise<RaffleHistoryItem[]> {
    const drawRepository = this.dataSource.getRepository(RaffleDraw);
    const userRewardRepository = this.dataSource.getRepository(UserReward);
    const draws = await drawRepository.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    if (draws.length === 0) {
      return [];
    }

    const drawIds = draws.map((draw) => draw.id);
    const userRewards = await userRewardRepository.find({ where: { userId: user.id, raffleDrawId: In(drawIds) } });
    const userRewardsByDrawId = new Map(userRewards.map((userReward) => [userReward.raffleDrawId, userReward]));

    return draws.map((draw) => ({
      draw: this.toDrawContract(draw),
      userReward: this.toUserRewardContract(userRewardsByDrawId.get(draw.id) ?? null),
    }));
  }

  private toPublicReward(poolReward: RafflePoolReward, totalWeight: number): PublicRaffleReward {
    const reward = poolReward.reward;
    const amount = this.rewardAmountContract(reward.type, reward.amount, reward.amountExactValue);

    return {
      id: reward.id,
      code: reward.code,
      title: reward.title,
      description: reward.description,
      type: reward.type,
      ...amount,
      metadata: reward.metadata,
      imageUrl: reward.imageUrl,
      stockRemaining: reward.stockRemaining,
      weight: poolReward.weight,
      probability: totalWeight > 0 ? poolReward.weight / totalWeight : 0,
    };
  }

  private toDrawContract(draw: RaffleDraw): RaffleDrawContract {
    const costErtExact = exactIntegerErt(draw.costErt, 'draw.costErt');
    const snapshot = draw.rewardSnapshot ?? {};
    const amount = this.rewardAmountContract(
      snapshot.type as RewardType | undefined,
      snapshot.amount as number | null | undefined,
      snapshot.amountExact as string | null | undefined,
    );
    return Object.assign(draw, {
      costErtExact,
      costErtDisplay: displayErt(costErtExact),
      rewardSnapshot: { ...snapshot, ...amount },
    });
  }

  private toUserRewardContract(userReward: UserReward | null): UserRewardContract | null {
    if (!userReward) return null;
    const { amountExactValue, ...publicReward } = userReward;
    const eruBalanceAfterExact = userReward.eruBalanceAfterExact === null
      ? null
      : canonicalEru(userReward.eruBalanceAfterExact, 'userReward.eruBalanceAfterExact');
    return Object.assign(publicReward,
      this.rewardAmountContract(userReward.type, userReward.amount, amountExactValue), {
        eruBalanceAfterExact,
        eruBalanceAfterDisplay: eruBalanceAfterExact === null ? null : displayEru(eruBalanceAfterExact),
      });
  }

  private rewardAmountContract(
    type: RewardType | undefined,
    amount: number | null | undefined,
    storedExact: string | null | undefined,
  ) {
    if (type === RewardType.Eru) {
      const amountExact = exactPositiveEru(storedExact, 'reward.amountExact');
      return {
        amount: eruCompatibilityNumber(amountExact),
        amountExact,
        amountDisplay: displayEru(amountExact),
      };
    }
    if (type !== RewardType.Ert || amount === null || amount === undefined) {
      return { amount: amount ?? null, amountExact: null, amountDisplay: null };
    }
    const amountExact = exactIntegerErt(amount, 'reward.amount');
    return { amount, amountExact, amountDisplay: displayErt(amountExact) };
  }
}

function exactPositiveEru(value: unknown, field: string) {
  try {
    const amount = canonicalEru(value, field);
    parseUnsignedEruDecimal(amount, field, false);
    return amount;
  } catch {
    throw new Error(`${field} must be a positive ERU decimal with at most 30 integer and 18 fractional digits`);
  }
}

function exactIntegerErt(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return canonicalErt(String(value));
}
