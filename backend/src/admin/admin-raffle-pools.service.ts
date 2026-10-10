import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { canonicalErt, displayErt } from '../m2e/ert-decimal';
import { RafflePoolReward } from '../raffle/raffle-pool-reward.entity';
import { RafflePool } from '../raffle/raffle-pool.entity';
import { Reward } from '../raffle/reward.entity';

export type AdminRafflePoolInput = {
  code?: unknown;
  title?: unknown;
  description?: unknown;
  costErt?: unknown;
  isActive?: unknown;
  dailyUserAttemptLimit?: unknown;
};

export type AdminPoolRewardInput = {
  rewardId?: unknown;
  weight?: unknown;
  isActive?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
};

@Injectable()
export class AdminRafflePoolsService {
  constructor(
    @InjectRepository(RafflePool)
    private readonly poolRepository: Repository<RafflePool>,
    @InjectRepository(RafflePoolReward)
    private readonly poolRewardRepository: Repository<RafflePoolReward>,
    @InjectRepository(Reward)
    private readonly rewardRepository: Repository<Reward>,
  ) {}

  async listPools() {
    const pools = await this.poolRepository.find({ order: { createdAt: 'DESC' } });
    return pools.map((pool) => this.toPoolContract(pool));
  }

  async createPool(input: AdminRafflePoolInput) {
    const data = this.normalizeCreatePoolInput(input);
    const existing = await this.poolRepository.findOne({ where: { code: data.code } });

    if (existing) {
      throw new ConflictException('Raffle pool code already exists');
    }

    return this.toPoolContract(await this.poolRepository.save(this.poolRepository.create(data)));
  }

  async updatePool(id: string, input: AdminRafflePoolInput) {
    const pool = await this.findPool(id);
    const data = this.normalizeUpdatePoolInput(input);

    if (data.code !== undefined && data.code !== pool.code) {
      const existing = await this.poolRepository.findOne({ where: { code: data.code } });

      if (existing && existing.id !== pool.id) {
        throw new ConflictException('Raffle pool code already exists');
      }
    }

    Object.assign(pool, data);

    return this.toPoolContract(await this.poolRepository.save(pool));
  }

  async attachReward(poolId: string, input: AdminPoolRewardInput) {
    const pool = await this.findPool(poolId);
    const rewardId = this.requiredString(input.rewardId, 'rewardId', 64);
    const reward = await this.rewardRepository.findOne({ where: { id: rewardId } });

    if (!reward) {
      throw new NotFoundException('Reward not found');
    }

    const existing = await this.poolRewardRepository.findOne({ where: { poolId: pool.id, rewardId: reward.id } });

    if (existing) {
      throw new ConflictException('Reward is already attached to this pool');
    }

    const data = this.normalizeCreatePoolRewardInput(input);

    return this.poolRewardRepository.save(this.poolRewardRepository.create({
      ...data,
      poolId: pool.id,
      rewardId: reward.id,
    }));
  }

  async updatePoolReward(poolId: string, poolRewardId: string, input: AdminPoolRewardInput) {
    await this.findPool(poolId);
    const poolReward = await this.poolRewardRepository.findOne({ where: { id: poolRewardId, poolId } });

    if (!poolReward) {
      throw new NotFoundException('Pool reward not found');
    }

    const data = this.normalizeUpdatePoolRewardInput(input);
    Object.assign(poolReward, data);

    return this.poolRewardRepository.save(poolReward);
  }

  async getPoolProbabilities(poolId: string, now = new Date()) {
    const pool = await this.findPool(poolId);
    const poolRewards = await this.poolRewardRepository.find({
      where: { poolId: pool.id },
      relations: { reward: true },
      order: { createdAt: 'ASC' },
    });
    const rows = poolRewards.map((poolReward) => this.toProbabilityRow(poolReward, now));
    const eligibleTotalWeight = rows.reduce((sum, row) => sum + (row.eligible ? row.weight : 0), 0);

    return {
      pool: {
        id: pool.id,
        code: pool.code,
        title: pool.title,
        costErt: pool.costErt,
        ...this.costContract(pool.costErt),
      },
      totalEligibleWeight: eligibleTotalWeight,
      rewards: rows.map((row) => ({
        ...row,
        probabilityPercent: row.eligible && eligibleTotalWeight > 0 ? (row.weight / eligibleTotalWeight) * 100 : 0,
      })),
    };
  }
  private async findPool(id: string) {
    const pool = await this.poolRepository.findOne({ where: { id } });

    if (!pool) {
      throw new NotFoundException('Raffle pool not found');
    }

    return pool;
  }

  private normalizeCreatePoolInput(input: AdminRafflePoolInput): Partial<RafflePool> {
    return {
      code: this.requiredString(input.code, 'code', 64),
      title: this.requiredString(input.title, 'title', 128),
      description: this.optionalString(input.description, 'description'),
      costErt: this.optionalInteger(input.costErt, 'costErt') ?? 0,
      isActive: this.optionalBoolean(input.isActive, true),
      dailyUserAttemptLimit: this.optionalInteger(input.dailyUserAttemptLimit, 'dailyUserAttemptLimit'),
    };
  }

  private normalizeUpdatePoolInput(input: AdminRafflePoolInput): Partial<RafflePool> {
    const data: Partial<RafflePool> = {};

    if (input.code !== undefined) data.code = this.requiredString(input.code, 'code', 64);
    if (input.title !== undefined) data.title = this.requiredString(input.title, 'title', 128);
    if (input.description !== undefined) data.description = this.optionalString(input.description, 'description');
    if (input.costErt !== undefined) data.costErt = this.requiredInteger(input.costErt, 'costErt');
    if (input.isActive !== undefined) data.isActive = this.optionalBoolean(input.isActive, true);
    if (input.dailyUserAttemptLimit !== undefined) data.dailyUserAttemptLimit = this.optionalInteger(input.dailyUserAttemptLimit, 'dailyUserAttemptLimit');

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one raffle pool field is required');
    }

    return data;
  }

  private normalizeCreatePoolRewardInput(input: AdminPoolRewardInput): Partial<RafflePoolReward> {
    return {
      weight: this.requiredInteger(input.weight, 'weight'),
      isActive: this.optionalBoolean(input.isActive, true),
      startsAt: this.optionalDate(input.startsAt, 'startsAt'),
      endsAt: this.optionalDate(input.endsAt, 'endsAt'),
    };
  }

  private normalizeUpdatePoolRewardInput(input: AdminPoolRewardInput): Partial<RafflePoolReward> {
    const data: Partial<RafflePoolReward> = {};

    if (input.weight !== undefined) data.weight = this.requiredInteger(input.weight, 'weight');
    if (input.isActive !== undefined) data.isActive = this.optionalBoolean(input.isActive, true);
    if (input.startsAt !== undefined) data.startsAt = this.optionalDate(input.startsAt, 'startsAt');
    if (input.endsAt !== undefined) data.endsAt = this.optionalDate(input.endsAt, 'endsAt');

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one pool reward field is required');
    }

    return data;
  }

  private toProbabilityRow(poolReward: RafflePoolReward, now: Date) {
    const reward = poolReward.reward;
    const linkActive = poolReward.isActive;
    const rewardActive = reward.isActive;
    const stockState = this.stockState(reward);
    const dateWindowState = this.dateWindowState(poolReward, now);
    const eligible = linkActive && rewardActive && stockState !== 'out_of_stock' && dateWindowState === 'active' && poolReward.weight > 0;

    return {
      poolRewardId: poolReward.id,
      rewardId: reward.id,
      rewardTitle: reward.title,
      rewardCode: reward.code,
      weight: poolReward.weight,
      probabilityPercent: 0,
      eligible,
      activeState: {
        poolRewardActive: linkActive,
        rewardActive,
      },
      stockState,
      dateWindowState,
    };
  }

  private stockState(reward: Reward) {
    if (reward.stockRemaining === null) {
      return 'unlimited';
    }

    return reward.stockRemaining > 0 ? 'available' : 'out_of_stock';
  }

  private dateWindowState(poolReward: RafflePoolReward, now: Date) {
    if (poolReward.startsAt && poolReward.startsAt > now) {
      return 'upcoming';
    }

    if (poolReward.endsAt && poolReward.endsAt <= now) {
      return 'expired';
    }

    return 'active';
  }
  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestException(`${field} is required`);
    }

    const trimmed = value.trim();

    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }

    return trimmed;
  }

  private optionalString(value: unknown, field: string, maxLength?: number) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const trimmed = value.trim();

    if (maxLength !== undefined && trimmed.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }

    return trimmed === '' ? null : trimmed;
  }

  private optionalInteger(value: unknown, field: string): number | null {
    if (value === undefined || value === null) {
      return null;
    }

    return this.requiredInteger(value, field);
  }

  private requiredInteger(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }

    return value;
  }

  private toPoolContract(pool: RafflePool) {
    return { ...pool, ...this.costContract(pool.costErt) };
  }

  private costContract(costErt: number) {
    if (!Number.isSafeInteger(costErt) || costErt < 0) {
      throw new Error('pool.costErt must be a non-negative safe integer');
    }
    const costErtExact = canonicalErt(String(costErt));
    return { costErtExact, costErtDisplay: displayErt(costErtExact) };
  }

  private optionalBoolean(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined || value === null) {
      return defaultValue;
    }

    if (typeof value !== 'boolean') {
      throw new BadRequestException('isActive must be a boolean');
    }

    return value;
  }

  private optionalDate(value: unknown, field: string): Date | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be an ISO date string`);
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be an ISO date string`);
    }

    return date;
  }
}
