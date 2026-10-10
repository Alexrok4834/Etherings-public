import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { User } from '../auth/user.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleRingAward } from './raffle-ring-award.entity';
import { RaffleV2HistoryCursor } from './raffle-v2-api-contract';
import { UserReward } from './user-reward.entity';

export const RAFFLE_V2_READ_REPOSITORY = Symbol('RAFFLE_V2_READ_REPOSITORY');

export type RaffleV2CurrentReadSnapshot = Readonly<{
  ownerExists: boolean;
  machine: RaffleMachine | null;
  configuration: RaffleConfiguration | null;
  rewards: ReadonlyArray<RaffleConfigurationReward>;
  attemptsUsed: number;
  copperAwarded: boolean;
}>;

export type RaffleV2HistoryReadRow = Readonly<{
  drawResultId: string;
  operationId: string;
  createdAt: Date;
  responseSnapshot: Record<string, unknown>;
}>;

export interface RaffleV2ReadPersistence {
  readCurrent(ownerUserId: string, utcDate: string): Promise<RaffleV2CurrentReadSnapshot>;
  readLegacyCurrent(): Promise<Pick<RaffleV2CurrentReadSnapshot, 'machine' | 'configuration' | 'rewards'>>;
  readHistory(
    ownerUserId: string,
    limit: number,
    cursor: RaffleV2HistoryCursor | null,
  ): Promise<RaffleV2HistoryReadRow[]>;
  readUserRewardsForResults(ownerUserId: string, drawResultIds: string[]): Promise<UserReward[]>;
}

@Injectable()
export class RaffleV2ReadRepository implements RaffleV2ReadPersistence {
  constructor(private readonly dataSource: DataSource) {}

  readCurrent(ownerUserId: string, utcDate: string) {
    return this.dataSource.transaction('REPEATABLE READ', async (manager): Promise<RaffleV2CurrentReadSnapshot> => {
      const ownerExists = await manager.getRepository(User).existsBy({ id: ownerUserId });
      const { machine, configuration, rewards } = await this.readActiveConfiguration(manager);
      const stats = await manager.getRepository(DailyUserStats).findOneBy({ userId: ownerUserId, date: utcDate });
      const copperAwarded = await manager.getRepository(RaffleRingAward)
        .existsBy({ ownerUserId, awardUtcDate: utcDate });
      return Object.freeze({
        ownerExists,
        machine,
        configuration,
        rewards: Object.freeze(rewards),
        attemptsUsed: stats?.raffleAttempts ?? 0,
        copperAwarded,
      });
    });
  }

  readLegacyCurrent() {
    return this.dataSource.transaction('REPEATABLE READ', (manager) => this.readActiveConfiguration(manager));
  }

  async readHistory(ownerUserId: string, limit: number, cursor: RaffleV2HistoryCursor | null) {
    const query = this.dataSource.getRepository(RaffleDrawResultV2)
      .createQueryBuilder('result')
      .innerJoinAndSelect('result.operation', 'operation')
      .where('result.ownerUserId = :ownerUserId', { ownerUserId })
      .andWhere('operation.ownerUserId = :ownerUserId', { ownerUserId })
      .andWhere('operation.status = :status', { status: RaffleDrawOperationStatus.Completed })
      .andWhere('operation.responseSnapshot IS NOT NULL');
    if (cursor) {
      query.andWhere(
        '(result.createdAt < :cursorCreatedAt OR (result.createdAt = :cursorCreatedAt AND result.id < :cursorId))',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.drawResultId },
      );
    }
    const results = await query
      .orderBy('result.createdAt', 'DESC')
      .addOrderBy('result.id', 'DESC')
      .take(limit + 1)
      .getMany();
    return results.map((result) => ({
      drawResultId: result.id,
      operationId: result.operationId,
      createdAt: result.createdAt,
      responseSnapshot: result.operation.responseSnapshot as Record<string, unknown>,
    }));
  }

  readUserRewardsForResults(ownerUserId: string, drawResultIds: string[]) {
    if (drawResultIds.length === 0) return Promise.resolve([]);
    return this.dataSource.getRepository(UserReward).find({
      where: { userId: ownerUserId, raffleDrawResultV2Id: In(drawResultIds) },
    });
  }

  private async readActiveConfiguration(manager: EntityManager) {
    const machine = await manager.getRepository(RaffleMachine).findOneBy({ singletonKey: 1 });
    const configuration = machine
      ? await manager.getRepository(RaffleConfiguration).findOneBy({
        machineId: machine.id,
        status: RaffleConfigurationStatus.Active,
      })
      : null;
    const rewards = configuration
      ? await manager.getRepository(RaffleConfigurationReward).find({
        where: { configurationId: configuration.id },
        relations: { reward: true },
        order: { segmentIndex: 'ASC' },
      })
      : [];
    return Object.freeze({ machine, configuration, rewards: Object.freeze(rewards) });
  }
}
