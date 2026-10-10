import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../auth/user.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleDrawOperation, RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { Reward } from './reward.entity';

export const RAFFLE_V2_DRAW_REPOSITORY = Symbol('RAFFLE_V2_DRAW_REPOSITORY');

export type RaffleV2OperationClaim = Pick<RaffleDrawOperation,
  'ownerUserId' | 'idempotencyKey' | 'requestFingerprint' | 'contractVersion' | 'configurationId'>;

export type RaffleV2ResultEvidence = Pick<RaffleDrawResultV2,
  | 'operationId'
  | 'ownerUserId'
  | 'machineId'
  | 'configurationId'
  | 'selectedRewardId'
  | 'selectedSegmentIndex'
  | 'algorithm'
  | 'ticket'
  | 'totalWeight'
  | 'rangesSnapshot'
  | 'costErtExact'>;

export interface RaffleV2DrawTransactionRepository {
  transaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T>;
  lockOwner(manager: EntityManager, ownerUserId: string): Promise<User | null>;
  findOperationForUpdate(
    manager: EntityManager,
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<RaffleDrawOperation | null>;
  lockSingletonMachine(manager: EntityManager): Promise<RaffleMachine | null>;
  lockActiveConfiguration(
    manager: EntityManager,
    machineId: string,
  ): Promise<RaffleConfiguration | null>;
  claimOperation(manager: EntityManager, input: RaffleV2OperationClaim): Promise<RaffleDrawOperation | null>;
  lockConfigurationRewards(
    manager: EntityManager,
    configurationId: string,
  ): Promise<RaffleConfigurationReward[]>;
  saveResult(manager: EntityManager, input: RaffleV2ResultEvidence): Promise<RaffleDrawResultV2>;
  completeOperation(
    manager: EntityManager,
    operation: RaffleDrawOperation,
    responseSnapshot: Record<string, unknown>,
  ): Promise<RaffleDrawOperation>;
}

@Injectable()
export class RaffleV2DrawRepository implements RaffleV2DrawTransactionRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    return this.dataSource.transaction(operation);
  }

  lockOwner(manager: EntityManager, ownerUserId: string) {
    return manager.getRepository(User).findOne({
      where: { id: ownerUserId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  findOperationForUpdate(manager: EntityManager, ownerUserId: string, idempotencyKey: string) {
    return manager.getRepository(RaffleDrawOperation).findOne({
      where: { ownerUserId, idempotencyKey },
      lock: { mode: 'pessimistic_write' },
    });
  }

  lockSingletonMachine(manager: EntityManager) {
    return manager.getRepository(RaffleMachine).findOne({
      where: { singletonKey: 1 },
      lock: { mode: 'pessimistic_write' },
    });
  }

  lockActiveConfiguration(manager: EntityManager, machineId: string) {
    return manager.getRepository(RaffleConfiguration).findOne({
      where: { machineId, status: RaffleConfigurationStatus.Active },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async claimOperation(manager: EntityManager, input: RaffleV2OperationClaim) {
    await manager.createQueryBuilder()
      .insert()
      .into(RaffleDrawOperation)
      .values({
        ...input,
        status: RaffleDrawOperationStatus.Pending,
        responseSnapshot: null,
        completedAt: null,
      })
      .orIgnore()
      .execute();

    return this.findOperationForUpdate(manager, input.ownerUserId, input.idempotencyKey);
  }

  async lockConfigurationRewards(manager: EntityManager, configurationId: string) {
    const mappings = await manager.getRepository(RaffleConfigurationReward)
      .createQueryBuilder('configurationReward')
      .where('configurationReward.configurationId = :configurationId', { configurationId })
      .orderBy('configurationReward.rewardId', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    for (const mapping of mappings) {
      const reward = await manager.getRepository(Reward).findOne({
        where: { id: mapping.rewardId },
        lock: { mode: 'pessimistic_write' },
      });
      if (reward) mapping.reward = reward;
    }
    return mappings;
  }

  saveResult(manager: EntityManager, input: RaffleV2ResultEvidence) {
    const repository = manager.getRepository(RaffleDrawResultV2);
    return repository.save(repository.create(input));
  }

  completeOperation(
    manager: EntityManager,
    operation: RaffleDrawOperation,
    responseSnapshot: Record<string, unknown>,
  ) {
    operation.status = RaffleDrawOperationStatus.Completed;
    operation.responseSnapshot = responseSnapshot;
    operation.completedAt = new Date();
    return manager.getRepository(RaffleDrawOperation).save(operation);
  }
}
