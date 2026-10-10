import { BadRequestException, Injectable } from '@nestjs/common';
import { RafflePoolReward } from './raffle-pool-reward.entity';

export type WeightedSelectionResult = {
  selected: RafflePoolReward;
  eligibleRewards: RafflePoolReward[];
  totalWeight: number;
  randomRoll: number;
};

@Injectable()
export class RaffleSelectionService {
  getEligiblePoolRewards(poolRewards: RafflePoolReward[], now = new Date()) {
    return poolRewards.filter((poolReward) => this.isEligible(poolReward, now));
  }

  selectWeighted(poolRewards: RafflePoolReward[], randomRoll: number, now = new Date()): WeightedSelectionResult {
    const eligibleRewards = this.getEligiblePoolRewards(poolRewards, now);
    const totalWeight = eligibleRewards.reduce((sum, poolReward) => sum + poolReward.weight, 0);

    if (totalWeight <= 0) {
      throw new BadRequestException('Raffle pool has no active rewards');
    }

    const clampedRoll = Math.min(Math.max(randomRoll, 0), 0.999999999999);
    const target = clampedRoll * totalWeight;
    let cursor = 0;

    for (const poolReward of eligibleRewards) {
      cursor += poolReward.weight;

      if (target < cursor) {
        return { selected: poolReward, eligibleRewards, totalWeight, randomRoll: clampedRoll };
      }
    }

    return {
      selected: eligibleRewards[eligibleRewards.length - 1],
      eligibleRewards,
      totalWeight,
      randomRoll: clampedRoll,
    };
  }

  isEligible(poolReward: RafflePoolReward, now = new Date()) {
    const reward = poolReward.reward;

    if (!poolReward.isActive || !reward?.isActive || poolReward.weight <= 0) {
      return false;
    }

    if (reward.stockRemaining !== null && reward.stockRemaining <= 0) {
      return false;
    }

    if (poolReward.startsAt !== null && poolReward.startsAt > now) {
      return false;
    }

    if (poolReward.endsAt !== null && poolReward.endsAt <= now) {
      return false;
    }

    return true;
  }
}