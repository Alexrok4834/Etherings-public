import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { canonicalEru, displayEru, eruCompatibilityNumber, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { canonicalErt, displayErt } from '../m2e/ert-decimal';
import { Reward, RewardType } from '../raffle/reward.entity';

export type AdminRewardInput = {
  code?: unknown;
  title?: unknown;
  description?: unknown;
  type?: unknown;
  amount?: unknown;
  amountExact?: unknown;
  metadata?: unknown;
  imageUrl?: unknown;
  isActive?: unknown;
  stockTotal?: unknown;
  stockRemaining?: unknown;
  perUserLimit?: unknown;
  dailyGlobalLimit?: unknown;
};

@Injectable()
export class AdminRewardsService {
  constructor(
    @InjectRepository(Reward)
    private readonly rewardRepository: Repository<Reward>,
    private readonly dataSource: DataSource,
  ) {}

  async listRewards() {
    const rewards = await this.rewardRepository.find({ order: { createdAt: 'DESC' } });
    return rewards.map((reward) => this.toContract(reward));
  }

  async createReward(input: AdminRewardInput) {
    const data = this.normalizeCreateInput(input);
    const existing = await this.rewardRepository.findOne({ where: { code: data.code } });

    if (existing) {
      throw new ConflictException('Reward code already exists');
    }

    return this.toContract(await this.rewardRepository.save(this.rewardRepository.create(data)));
  }

  async updateReward(id: string, input: AdminRewardInput) {
    const reward = await this.findReward(id);
    await this.assertNotReferencedByActiveRaffleV2(id);
    const data = this.normalizeUpdateInput(input);
    const nextType = data.type ?? reward.type;

    if (input.type !== undefined || input.amount !== undefined || input.amountExact !== undefined) {
      Object.assign(
        data,
        this.rewardAmounts(nextType, input.amount, input.amountExact, reward.type !== RewardType.Eru && nextType === RewardType.Eru),
      );
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one reward field is required');
    }

    if (data.code !== undefined && data.code !== reward.code) {
      const existing = await this.rewardRepository.findOne({ where: { code: data.code } });

      if (existing && existing.id !== reward.id) {
        throw new ConflictException('Reward code already exists');
      }
    }

    Object.assign(reward, data);

    return this.toContract(await this.rewardRepository.save(reward));
  }

  async softDisableReward(id: string) {
    const reward = await this.findReward(id);
    await this.assertNotReferencedByActiveRaffleV2(id);
    reward.isActive = false;

    return this.toContract(await this.rewardRepository.save(reward));
  }

  private async findReward(id: string) {
    const reward = await this.rewardRepository.findOne({ where: { id } });

    if (!reward) {
      throw new NotFoundException('Reward not found');
    }

    return reward;
  }

  private async assertNotReferencedByActiveRaffleV2(rewardId: string) {
    const rows = await this.dataSource.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM "raffle_configuration_rewards" mapping
          INNER JOIN "raffle_configurations" configuration
            ON configuration."id" = mapping."configuration_id"
          WHERE mapping."reward_id" = $1
            AND configuration."status" = 'ACTIVE'
        ) AS "referenced"
      `,
      [rewardId],
    ) as Array<{ referenced: boolean | string }>;
    const referenced = rows[0]?.referenced;
    if (referenced === true || referenced === 'true') {
      throw new ConflictException(
        'Active Raffle v2 rewards are immutable; create and activate a new configuration version',
      );
    }
  }

  private normalizeCreateInput(input: AdminRewardInput): Partial<Reward> {
    const code = this.requiredString(input.code, 'code', 64);
    const title = this.requiredString(input.title, 'title', 128);
    const type = this.rewardType(input.type);

    return {
      code,
      title,
      description: this.optionalString(input.description, 'description'),
      type,
      ...this.rewardAmounts(type, input.amount, input.amountExact, true),
      metadata: this.optionalObject(input.metadata, 'metadata'),
      imageUrl: this.optionalString(input.imageUrl, 'imageUrl', 512),
      isActive: this.optionalBoolean(input.isActive, true),
      stockTotal: this.optionalInteger(input.stockTotal, 'stockTotal'),
      stockRemaining: this.optionalInteger(input.stockRemaining, 'stockRemaining'),
      perUserLimit: this.optionalInteger(input.perUserLimit, 'perUserLimit'),
      dailyGlobalLimit: this.optionalInteger(input.dailyGlobalLimit, 'dailyGlobalLimit'),
    };
  }

  private normalizeUpdateInput(input: AdminRewardInput): Partial<Reward> {
    const data: Partial<Reward> = {};

    if (input.code !== undefined) data.code = this.requiredString(input.code, 'code', 64);
    if (input.title !== undefined) data.title = this.requiredString(input.title, 'title', 128);
    if (input.description !== undefined) data.description = this.optionalString(input.description, 'description');
    if (input.type !== undefined) data.type = this.rewardType(input.type);
    if (input.metadata !== undefined) data.metadata = this.optionalObject(input.metadata, 'metadata');
    if (input.imageUrl !== undefined) data.imageUrl = this.optionalString(input.imageUrl, 'imageUrl', 512);
    if (input.isActive !== undefined) data.isActive = this.optionalBoolean(input.isActive, true);
    if (input.stockTotal !== undefined) data.stockTotal = this.optionalInteger(input.stockTotal, 'stockTotal');
    if (input.stockRemaining !== undefined) data.stockRemaining = this.optionalInteger(input.stockRemaining, 'stockRemaining');
    if (input.perUserLimit !== undefined) data.perUserLimit = this.optionalInteger(input.perUserLimit, 'perUserLimit');
    if (input.dailyGlobalLimit !== undefined) data.dailyGlobalLimit = this.optionalInteger(input.dailyGlobalLimit, 'dailyGlobalLimit');

    return data;
  }

  private rewardAmounts(type: RewardType, amount: unknown, amountExact: unknown, creating: boolean) {
    if (type === RewardType.Eru) {
      if (amount !== undefined && amount !== null) {
        throw new BadRequestException('ERU reward amount must use amountExact');
      }
      if (amountExact === undefined && !creating) return {};
      return { amount: null, amountExactValue: this.positiveEruDecimal(amountExact) };
    }
    if (amountExact !== undefined) {
      throw new BadRequestException('amountExact is supported only for ERU rewards');
    }
    const normalized = this.optionalInteger(amount, 'amount');
    return {
      amount: normalized,
      amountExactValue: normalized === null ? null : String(normalized),
    };
  }

  private positiveEruDecimal(value: unknown) {
    try {
      const amount = canonicalEru(value, 'amountExact');
      parseUnsignedEruDecimal(amount, 'amountExact', false);
      return amount;
    } catch {
      throw new BadRequestException('amountExact must be a positive ERU decimal with at most 30 integer and 18 fractional digits');
    }
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

  private rewardType(value: unknown) {
    if (typeof value !== 'string' || !Object.values(RewardType).includes(value as RewardType)) {
      throw new BadRequestException('type must be a valid reward type');
    }

    return value as RewardType;
  }

  private optionalInteger(value: unknown, field: string): number | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }

    return value;
  }

  private toContract(reward: Reward) {
    const { amountExactValue, ...publicReward } = reward;
    if (reward.type === RewardType.Eru) {
      const amountExact = canonicalEru(amountExactValue, 'reward.amountExactValue');
      parseUnsignedEruDecimal(amountExact, 'reward.amountExactValue', false);
      return {
        ...publicReward,
        amount: eruCompatibilityNumber(amountExact),
        amountExact,
        amountDisplay: displayEru(amountExact),
      };
    }
    if (reward.type !== RewardType.Ert || reward.amount === null) {
      return { ...publicReward, amountExact: null, amountDisplay: null };
    }
    if (!Number.isSafeInteger(reward.amount) || reward.amount < 0) {
      throw new Error('reward.amount must be a non-negative safe integer');
    }
    const amountExact = canonicalErt(String(reward.amount));
    return { ...publicReward, amountExact, amountDisplay: displayErt(amountExact) };
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

  private optionalObject(value: unknown, field: string): Record<string, unknown> | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an object`);
    }

    return value as Record<string, unknown>;
  }
}
