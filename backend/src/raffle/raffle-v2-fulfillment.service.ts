import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ERU_RAFFLE_REWARD_REFERENCE, EruLedgerService } from '../balance/eru-ledger.service';
import { canonicalEru, displayEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { RaffleCopperAwardService } from './raffle-copper-award.service';
import { RaffleV2FulfillmentPort, RaffleV2FulfillmentResponse, RaffleV2LockedDraw, RaffleV2PreparedFulfillment } from './raffle-v2-fulfillment.port';
import { RaffleV2FulfillmentRepository } from './raffle-v2-fulfillment.repository';
import { Reward, RewardType } from './reward.entity';
import { validateRaffleV2Configuration } from './raffle-v2-configuration-validator';

const positiveInteger = /^[1-9][0-9]{0,29}$/;

export enum RaffleV2FulfillmentFailure {
  InvalidState = 'INVALID_STATE',
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  DailyLimitReached = 'DAILY_LIMIT_REACHED',
  NoEligibleReward = 'NO_ELIGIBLE_REWARD',
}

export class RaffleV2FulfillmentError extends Error {
  constructor(readonly reason: RaffleV2FulfillmentFailure) {
    super(`Raffle v2 fulfillment failed: ${reason}`);
    this.name = 'RaffleV2FulfillmentError';
  }
}

type PreparedState = {
  ownerUserId: string;
  operationId: string;
  configurationId: string;
  utcDate: string;
  resetsAt: string;
  attemptsUsed: number;
  costErtExact: string;
  dailyAttemptLimit: number;
  eligibleRewardIds: string[];
  rewards: Map<string, Reward>;
};

@Injectable()
export class RaffleV2FulfillmentService implements RaffleV2FulfillmentPort {
  private readonly preparedStates = new WeakSet<object>();

  constructor(
    private readonly repository: RaffleV2FulfillmentRepository,
    private readonly ledger: LedgerService,
    private readonly eruLedger: EruLedgerService,
    private readonly copperAward: RaffleCopperAwardService,
  ) {}

  async lockAndValidate(
    manager: EntityManager,
    input: Parameters<RaffleV2FulfillmentPort['lockAndValidate']>[1],
  ): Promise<RaffleV2PreparedFulfillment> {
    const economy = this.requireConfigurationEconomy(input.draw);
    const rewards = this.validateLockedRewards(input.draw);
    const balance = await this.repository.lockBalance(manager, input.ownerUserId);
    if (!balance) this.fail(RaffleV2FulfillmentFailure.InvalidState);
    if (parseUnsignedErtDecimal(balance.ertBalanceExact, 'balance').lessThan(economy.costErtExact)) {
      this.fail(RaffleV2FulfillmentFailure.InsufficientBalance);
    }

    const utcDate = this.currentTime().toISOString().slice(0, 10);
    const stats = await this.repository.lockDailyStats(manager, input.ownerUserId, utcDate);
    if (!Number.isSafeInteger(stats.raffleAttempts) || stats.raffleAttempts < 0) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    if (stats.raffleAttempts >= economy.dailyAttemptLimit) {
      this.fail(RaffleV2FulfillmentFailure.DailyLimitReached);
    }
    if (!await this.repository.hasValidEquipment(manager, input.ownerUserId)) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    const copperAlreadyAwarded = await this.repository.hasCopperAward(manager, input.ownerUserId, utcDate);
    const eligibleRewardIds = [...rewards.values()]
      .filter((reward) => reward.type !== RewardType.CopperRing || !copperAlreadyAwarded)
      .map((reward) => reward.id);
    if (eligibleRewardIds.length === 0) this.fail(RaffleV2FulfillmentFailure.NoEligibleReward);

    const state: PreparedState = {
      ownerUserId: input.ownerUserId,
      operationId: input.operation.id,
      configurationId: input.draw.configuration.id,
      utcDate,
      resetsAt: `${this.nextUtcDate(utcDate)}T00:00:00.000Z`,
      attemptsUsed: stats.raffleAttempts,
      costErtExact: economy.costErtExact,
      dailyAttemptLimit: economy.dailyAttemptLimit,
      eligibleRewardIds,
      rewards,
    };
    this.preparedStates.add(state);
    return { eligibleRewardIds: [...eligibleRewardIds], state };
  }

  async fulfill(
    manager: EntityManager,
    input: Parameters<RaffleV2FulfillmentPort['fulfill']>[1],
  ): Promise<RaffleV2FulfillmentResponse> {
    const state = this.requirePrepared(input.preparedState);
    if (state.ownerUserId !== input.ownerUserId
      || state.operationId !== input.operation.id
      || state.configurationId !== input.draw.configuration.id
      || input.result.operationId !== input.operation.id
      || input.result.selectedRewardId !== input.selection.selectedRewardId
      || !state.eligibleRewardIds.includes(input.selection.selectedRewardId)) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    const reward = state.rewards.get(input.selection.selectedRewardId);
    if (!reward) this.fail(RaffleV2FulfillmentFailure.InvalidState);

    const debit = await this.ledger.debitDecimalInTransaction(manager, {
      userId: input.ownerUserId,
      amount: state.costErtExact,
      type: LedgerTransactionType.RaffleSpend,
      referenceType: 'raffle_v2_draw',
      referenceId: input.result.id,
      metadata: { operationId: input.operation.id, configurationId: input.draw.configuration.id },
    });
    const fulfillment = await this.fulfillReward(manager, input, reward, state.utcDate);
    const stats = await this.repository.lockDailyStats(manager, input.ownerUserId, state.utcDate);
    if (stats.raffleAttempts !== state.attemptsUsed) this.fail(RaffleV2FulfillmentFailure.InvalidState);
    const savedStats = await this.repository.incrementAttempt(manager, stats);

    return {
      cost: {
        currency: 'ERT', amountExact: state.costErtExact, amountDisplay: displayErt(state.costErtExact),
        ledgerTransactionId: debit.ledgerTransaction.id,
      },
      attempts: {
        limit: state.dailyAttemptLimit,
        used: savedStats.raffleAttempts,
        remaining: state.dailyAttemptLimit - savedStats.raffleAttempts,
        day: state.utcDate,
        resetsAt: state.resetsAt,
      },
      fulfillment,
    };
  }

  protected currentTime() { return new Date(); }

  private async fulfillReward(
    manager: EntityManager,
    input: Parameters<RaffleV2FulfillmentPort['fulfill']>[1],
    reward: Reward,
    awardUtcDate: string,
  ): Promise<Record<string, unknown>> {
    if (reward.type === RewardType.CopperRing) {
      const awarded = await this.copperAward.awardInTransaction(manager, {
        ownerUserId: input.ownerUserId, operation: input.operation, result: input.result, awardUtcDate,
      });
      return {
        type: 'RING_AWARD', ringId: awarded.ring.id, ringEventId: awarded.ringEventId,
        equipped: false, ring: awarded.ring,
      };
    }

    const amount = this.rewardAmount(reward, input.selection.selectedRewardSnapshot);
    if (reward.type === RewardType.Ert) {
      const credit = await this.ledger.creditDecimalInTransaction(manager, {
        userId: input.ownerUserId, amount, type: LedgerTransactionType.RaffleReward,
        referenceType: 'raffle_v2_draw', referenceId: input.result.id,
        metadata: { rewardId: reward.id, operationId: input.operation.id },
      });
      await this.saveCurrencyUserReward(manager, input, reward, null);
      return {
        type: 'ERT_CREDIT', ledgerTransactionId: credit.ledgerTransaction.id,
        balanceAfterExact: credit.balance.ertBalance,
        balanceAfterDisplay: displayErt(credit.balance.ertBalance),
      };
    }
    if (reward.type === RewardType.Eru) {
      const credit = await this.eruLedger.creditInTransaction(manager, {
        userId: input.ownerUserId, amount, type: LedgerTransactionType.RaffleReward,
        referenceType: ERU_RAFFLE_REWARD_REFERENCE, referenceId: input.result.id,
        metadata: { rewardId: reward.id, operationId: input.operation.id },
      });
      await this.saveCurrencyUserReward(manager, input, reward, credit.ledgerTransaction.balanceAfter);
      return {
        type: 'ERU_CREDIT', ledgerTransactionId: credit.ledgerTransaction.id,
        balanceAfterExact: credit.ledgerTransaction.balanceAfter,
        balanceAfterDisplay: displayEru(credit.ledgerTransaction.balanceAfter),
      };
    }
    return this.fail(RaffleV2FulfillmentFailure.InvalidState);
  }

  private saveCurrencyUserReward(
    manager: EntityManager,
    input: Parameters<RaffleV2FulfillmentPort['fulfill']>[1],
    reward: Reward,
    eruBalanceAfterExact: string | null,
  ) {
    return this.repository.saveUserReward(manager, {
      userId: input.ownerUserId, rewardId: reward.id, raffleDrawId: null,
      raffleDrawResultV2Id: input.result.id, title: reward.title, type: reward.type,
      amount: reward.amount, amountExactValue: reward.amountExactValue, eruBalanceAfterExact,
      metadata: { operationId: input.operation.id, configurationId: input.draw.configuration.id },
    });
  }

  private requireConfigurationEconomy(draw: RaffleV2LockedDraw) {
    try {
      const costErtExact = canonicalErt(parseUnsignedErtDecimal(draw.configuration.costErtExact, 'cost', false));
      const dailyAttemptLimit = draw.configuration.dailyUserAttemptLimit;
      if (!Number.isSafeInteger(dailyAttemptLimit) || dailyAttemptLimit <= 0) {
        this.fail(RaffleV2FulfillmentFailure.InvalidState);
      }
      return { costErtExact, dailyAttemptLimit };
    } catch (error) {
      if (error instanceof RaffleV2FulfillmentError) throw error;
      return this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
  }

  private validateLockedRewards(draw: RaffleV2LockedDraw) {
    const validation = validateRaffleV2Configuration({
      costErtExact: draw.configuration.costErtExact,
      dailyUserAttemptLimit: draw.configuration.dailyUserAttemptLimit,
      rewards: [...draw.rewards]
        .sort((left, right) => left.segmentIndex - right.segmentIndex)
        .map((mapping) => ({
          rewardId: mapping.rewardId,
          segmentIndex: mapping.segmentIndex,
          weight: mapping.weight,
          snapshot: mapping.rewardSnapshot,
          live: {
            id: mapping.reward?.id ?? '',
            type: mapping.reward?.type ?? '',
            active: mapping.reward?.isActive ?? false,
            amount: mapping.reward?.amount ?? null,
            amountExact: mapping.reward?.amountExactValue ?? null,
            stockTotal: mapping.reward?.stockTotal ?? null,
            stockRemaining: mapping.reward?.stockRemaining ?? null,
            perUserLimit: mapping.reward?.perUserLimit ?? null,
            dailyGlobalLimit: mapping.reward?.dailyGlobalLimit ?? null,
          },
        })),
    });
    if (!validation.valid) this.fail(RaffleV2FulfillmentFailure.InvalidState);
    const rewards = new Map<string, Reward>();
    for (const mapping of draw.rewards) {
      const reward = mapping.reward;
      if (!reward || reward.id !== mapping.rewardId || !reward.isActive || rewards.has(reward.id)
        || reward.stockTotal !== null || reward.stockRemaining !== null
        || ![RewardType.Ert, RewardType.Eru, RewardType.CopperRing].includes(reward.type)) {
        this.fail(RaffleV2FulfillmentFailure.InvalidState);
      }
      if (reward.type === RewardType.CopperRing) {
        if (reward.amount !== null || reward.amountExactValue !== null
          || mapping.rewardSnapshot.rewardId !== reward.id
          || mapping.rewardSnapshot.type !== RewardType.CopperRing
          || mapping.rewardSnapshot.amountExact !== null) {
          this.fail(RaffleV2FulfillmentFailure.InvalidState);
        }
      } else this.rewardAmount(reward, mapping.rewardSnapshot);
      rewards.set(reward.id, reward);
    }
    if (rewards.size === 0) this.fail(RaffleV2FulfillmentFailure.NoEligibleReward);
    return rewards;
  }

  private rewardAmount(reward: Reward, snapshot: Readonly<Record<string, unknown>>) {
    const rawAmount = snapshot.amountExact;
    if (typeof rawAmount !== 'string' || snapshot.rewardId !== reward.id || snapshot.type !== reward.type) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    let amount: string;
    try {
      amount = reward.type === RewardType.Eru
        ? canonicalEru(rawAmount, 'raffle reward amount')
        : canonicalErt(parseUnsignedErtDecimal(rawAmount, 'raffle reward amount', false));
      if (reward.type === RewardType.Eru) parseUnsignedEruDecimal(amount, 'raffle reward amount', false);
    } catch {
      return this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    if (reward.type === RewardType.Ert && (!positiveInteger.test(rawAmount)
      || !Number.isSafeInteger(reward.amount) || String(reward.amount) !== amount)) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    if (reward.type === RewardType.Eru) {
      try {
        if (canonicalEru(reward.amountExactValue, 'persisted ERU reward') !== amount) {
          this.fail(RaffleV2FulfillmentFailure.InvalidState);
        }
      } catch {
        this.fail(RaffleV2FulfillmentFailure.InvalidState);
      }
    }
    return amount;
  }

  private requirePrepared(value: unknown) {
    if (value === null || typeof value !== 'object' || !this.preparedStates.has(value)) {
      this.fail(RaffleV2FulfillmentFailure.InvalidState);
    }
    return value as PreparedState;
  }

  private nextUtcDate(utcDate: string) {
    const next = new Date(`${utcDate}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }

  private fail(reason: RaffleV2FulfillmentFailure): never { throw new RaffleV2FulfillmentError(reason); }
}
