import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EquippedRing } from '../ring/equipped-ring.entity';
import { GameRing, GameRingStatus } from '../ring/game-ring.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { RaffleRingAward } from './raffle-ring-award.entity';
import { UserReward } from './user-reward.entity';

export interface RaffleV2FulfillmentPersistence {
  lockBalance(manager: EntityManager, ownerUserId: string): Promise<{ ertBalanceExact: string } | null>;
  lockDailyStats(manager: EntityManager, ownerUserId: string, utcDate: string): Promise<DailyUserStats>;
  hasValidEquipment(manager: EntityManager, ownerUserId: string): Promise<boolean>;
  hasCopperAward(manager: EntityManager, ownerUserId: string, utcDate: string): Promise<boolean>;
  saveUserReward(manager: EntityManager, input: Partial<UserReward>): Promise<UserReward>;
  incrementAttempt(manager: EntityManager, stats: DailyUserStats): Promise<DailyUserStats>;
}

@Injectable()
export class RaffleV2FulfillmentRepository implements RaffleV2FulfillmentPersistence {
  async lockBalance(manager: EntityManager, ownerUserId: string) {
    const [row] = await manager.query(`
      SELECT ert_balance::text AS "ertBalanceExact"
      FROM balances WHERE user_id = $1 FOR UPDATE
    `, [ownerUserId]) as Array<{ ertBalanceExact: string }>;
    return row ?? null;
  }

  async lockDailyStats(manager: EntityManager, ownerUserId: string, utcDate: string) {
    await manager.query(`
      INSERT INTO daily_user_stats (
        user_id, date, accepted_steps, earned_ert, raffle_attempts, created_at, updated_at
      ) VALUES ($1, $2::date, 0, 0, 0, now(), now())
      ON CONFLICT (user_id, date) DO NOTHING
    `, [ownerUserId, utcDate]);
    const stats = await manager.getRepository(DailyUserStats).findOne({
      where: { userId: ownerUserId, date: utcDate },
      lock: { mode: 'pessimistic_write' },
    });
    if (!stats) throw new Error('Raffle daily stats are unavailable after initialization');
    return stats;
  }

  async hasValidEquipment(manager: EntityManager, ownerUserId: string) {
    const activeRingCount = await manager.getRepository(GameRing).count({
      where: { ownerUserId, status: GameRingStatus.Active },
    });
    if (activeRingCount < 1) return false;
    const equipment = await manager.getRepository(EquippedRing).findOne({
      where: { userId: ownerUserId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!equipment) return false;
    return manager.getRepository(GameRing).exists({
      where: { id: equipment.ringId, ownerUserId, status: GameRingStatus.Active },
    });
  }

  hasCopperAward(manager: EntityManager, ownerUserId: string, utcDate: string) {
    return manager.getRepository(RaffleRingAward).exists({ where: { ownerUserId, awardUtcDate: utcDate } });
  }

  saveUserReward(manager: EntityManager, input: Partial<UserReward>) {
    const repository = manager.getRepository(UserReward);
    return repository.save(repository.create(input));
  }

  incrementAttempt(manager: EntityManager, stats: DailyUserStats) {
    stats.raffleAttempts += 1;
    return manager.getRepository(DailyUserStats).save(stats);
  }
}
