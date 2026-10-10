import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GameRing } from '../ring/game-ring.entity';
import { RingEvent } from '../ring/ring-event.entity';
import { RaffleRingAward } from './raffle-ring-award.entity';
import { Reward } from './reward.entity';
import { UserReward } from './user-reward.entity';

export type RaffleCopperAwardAggregate = Readonly<{
  award: RaffleRingAward;
  ring: GameRing;
  event: RingEvent;
  userReward: UserReward;
}>;

export interface RaffleCopperAwardPersistence {
  findByDrawResult(manager: EntityManager, drawResultId: string): Promise<RaffleCopperAwardAggregate | null>;
  findReward(manager: EntityManager, rewardId: string): Promise<Reward | null>;
  saveRing(manager: EntityManager, input: Partial<GameRing>): Promise<GameRing>;
  saveEvent(manager: EntityManager, input: Partial<RingEvent>): Promise<RingEvent>;
  saveAward(manager: EntityManager, input: Partial<RaffleRingAward>): Promise<RaffleRingAward>;
  saveUserReward(manager: EntityManager, input: Partial<UserReward>): Promise<UserReward>;
}

@Injectable()
export class RaffleCopperAwardRepository implements RaffleCopperAwardPersistence {
  async findByDrawResult(manager: EntityManager, drawResultId: string) {
    const award = await manager.getRepository(RaffleRingAward).findOne({ where: { drawResultId } });
    if (!award) return null;

    const [ring, event, userReward] = await Promise.all([
      manager.getRepository(GameRing).findOne({ where: { id: award.ringId, ownerUserId: award.ownerUserId } }),
      manager.getRepository(RingEvent).findOne({ where: { id: award.ringEventId } }),
      manager.getRepository(UserReward).findOne({ where: { raffleDrawResultV2Id: drawResultId } }),
    ]);
    if (!ring || !event || !userReward) return null;
    return { award, ring, event, userReward };
  }

  findReward(manager: EntityManager, rewardId: string) {
    return manager.getRepository(Reward).findOne({ where: { id: rewardId } });
  }

  saveRing(manager: EntityManager, input: Partial<GameRing>) {
    const repository = manager.getRepository(GameRing);
    return repository.save(repository.create(input));
  }

  saveEvent(manager: EntityManager, input: Partial<RingEvent>) {
    const repository = manager.getRepository(RingEvent);
    return repository.save(repository.create(input));
  }

  saveAward(manager: EntityManager, input: Partial<RaffleRingAward>) {
    const repository = manager.getRepository(RaffleRingAward);
    return repository.save(repository.create(input));
  }

  saveUserReward(manager: EntityManager, input: Partial<UserReward>) {
    const repository = manager.getRepository(UserReward);
    return repository.save(repository.create(input));
  }
}
