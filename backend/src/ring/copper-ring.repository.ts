import { Injectable } from '@nestjs/common';
import { Brackets, DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { User } from '../auth/user.entity';
import { RaffleRingAward } from '../raffle/raffle-ring-award.entity';
import { EquippedRing } from './equipped-ring.entity';
import { GameRing, GameRingStatus } from './game-ring.entity';
import { RingEvent, RingEventType } from './ring-event.entity';
import {
  CopperLevelUpOperation,
  CopperLevelUpOperationStatus,
} from './copper-level-up-operation.entity';
import {
  CopperAttributeAllocationOperation,
  CopperAttributeAllocationOperationStatus,
} from './copper-attribute-allocation-operation.entity';
import {
  RingEquipmentOperation,
  RingEquipmentOperationStatus,
} from './ring-equipment-operation.entity';

export type StarterRingPersistenceInput = Pick<GameRing,
  | 'ownerUserId'
  | 'entitlementCode'
  | 'ringKind'
  | 'status'
  | 'level'
  | 'shine'
  | 'comfort'
  | 'charm'
  | 'quality'
  | 'luck'
  | 'unspentAttributePoints'
  | 'visualVariantCode'
  | 'rulesetVersion'
  | 'generationVersion'
  | 'visualSetVersion'
  | 'issuedReason'
>;

export type StarterEventPersistenceInput = Pick<RingEvent,
  | 'ringId'
  | 'ownerUserId'
  | 'operationKey'
  | 'eventType'
  | 'rulesetVersion'
  | 'snapshot'
>;

export type AdminRingSearchInput = {
  query: string | null;
  limit: number;
  offset: number;
};

export type ExactErtBalanceRow = {
  ertBalance: string;
  lifetimeEarnedErt: string;
  lifetimeSpentErt: string;
  eruBalance: string;
  lifetimeEarnedEru: string;
  lifetimeSpentEru: string;
};

@Injectable()
export class CopperRingRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    return this.dataSource.transaction(operation);
  }

  lockOwner(manager: EntityManager, userId: string) {
    return manager.getRepository(User).findOne({
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  findStarterForUpdate(manager: EntityManager, userId: string, entitlementCode: string) {
    return manager.getRepository(GameRing).findOne({
      where: { ownerUserId: userId, entitlementCode },
      lock: { mode: 'pessimistic_write' },
    });
  }

  saveStarterRing(manager: EntityManager, input: StarterRingPersistenceInput) {
    const repository = manager.getRepository(GameRing);
    return repository.save(repository.create(input));
  }

  saveAutomaticEquipment(manager: EntityManager, userId: string, ringId: string) {
    const repository = manager.getRepository(EquippedRing);
    return repository.save(repository.create({ userId, ringId }));
  }

  saveStarterEvent(manager: EntityManager, input: StarterEventPersistenceInput) {
    const repository = manager.getRepository(RingEvent);
    return repository.save(repository.create(input));
  }

  findEquipment(manager: EntityManager, userId: string) {
    return manager.getRepository(EquippedRing).findOne({ where: { userId } });
  }

  findEquipmentOperationForUpdate(
    manager: EntityManager,
    ownerUserId: string,
    idempotencyKey: string,
  ) {
    return manager.getRepository(RingEquipmentOperation).findOne({
      where: { ownerUserId, idempotencyKey },
      lock: { mode: 'pessimistic_write' },
    });
  }

  lockEquipment(manager: EntityManager, userId: string) {
    return manager.getRepository(EquippedRing).findOne({
      where: { userId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async claimEquipmentOperation(
    manager: EntityManager,
    input: Pick<RingEquipmentOperation,
      | 'ownerUserId'
      | 'targetRingId'
      | 'expectedEquippedRingId'
      | 'idempotencyKey'
      | 'requestFingerprint'
      | 'contractVersion'>,
  ) {
    await manager.createQueryBuilder()
      .insert()
      .into(RingEquipmentOperation)
      .values({
        ...input,
        status: RingEquipmentOperationStatus.Pending,
        responseSnapshot: null,
        completedAt: null,
      })
      .orIgnore()
      .execute();
    return this.findEquipmentOperationForUpdate(
      manager,
      input.ownerUserId,
      input.idempotencyKey,
    );
  }

  saveEquipment(manager: EntityManager, equipment: EquippedRing) {
    return manager.getRepository(EquippedRing).save(equipment);
  }

  saveEquipmentEvent(manager: EntityManager, input: StarterEventPersistenceInput) {
    const repository = manager.getRepository(RingEvent);
    return repository.save(repository.create(input));
  }

  completeEquipmentOperation(
    manager: EntityManager,
    operation: RingEquipmentOperation,
    responseSnapshot: Record<string, unknown>,
    completedAt: Date,
  ) {
    operation.status = RingEquipmentOperationStatus.Completed;
    operation.responseSnapshot = responseSnapshot;
    operation.completedAt = completedAt;
    return manager.getRepository(RingEquipmentOperation).save(operation);
  }

  findStarterEvent(manager: EntityManager, ringId: string) {
    return manager.getRepository(RingEvent).findOne({
      where: { ringId, eventType: RingEventType.StarterIssued },
    });
  }

  listOwnedRings(manager: EntityManager, userId: string) {
    return manager.getRepository(GameRing).find({
      where: { ownerUserId: userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  listActiveOwnedRings(manager: EntityManager, userId: string) {
    return manager.getRepository(GameRing).find({
      where: { ownerUserId: userId, status: GameRingStatus.Active },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  findRaffleAwardForRing(manager: EntityManager, ownerUserId: string, ringId: string) {
    return manager.getRepository(RaffleRingAward).findOne({ where: { ownerUserId, ringId } });
  }

  findOwnedRing(manager: EntityManager, userId: string, ringId: string) {
    return manager.getRepository(GameRing).findOne({
      where: { id: ringId, ownerUserId: userId },
    });
  }

  findOwnedRingForUpdate(manager: EntityManager, userId: string, ringId: string) {
    return manager.getRepository(GameRing).findOne({
      where: { id: ringId, ownerUserId: userId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async findErtBalanceForUpdate(manager: EntityManager, userId: string) {
    const rows = await manager.query(`
      SELECT ert_balance::text AS "ertBalance",
        lifetime_earned_ert::text AS "lifetimeEarnedErt",
        lifetime_spent_ert::text AS "lifetimeSpentErt",
        eru_balance::text AS "eruBalance",
        lifetime_earned_eru::text AS "lifetimeEarnedEru",
        lifetime_spent_eru::text AS "lifetimeSpentEru"
      FROM balances WHERE user_id = $1 FOR UPDATE
    `, [userId]) as ExactErtBalanceRow[];
    return rows[0] ?? null;
  }

  async claimLevelUpOperation(
    manager: EntityManager,
    input: Pick<CopperLevelUpOperation,
      'ownerUserId' | 'ringId' | 'idempotencyKey' | 'requestFingerprint' | 'rulesVersion'>,
  ) {
    await manager.createQueryBuilder()
      .insert()
      .into(CopperLevelUpOperation)
      .values({ ...input, status: CopperLevelUpOperationStatus.Pending, responseSnapshot: null })
      .orIgnore()
      .execute();

    return manager.getRepository(CopperLevelUpOperation).findOne({
      where: { ownerUserId: input.ownerUserId, idempotencyKey: input.idempotencyKey },
      lock: { mode: 'pessimistic_write' },
    });
  }

  saveRing(manager: EntityManager, ring: GameRing) {
    return manager.getRepository(GameRing).save(ring);
  }

  saveLevelUpEvent(manager: EntityManager, input: StarterEventPersistenceInput) {
    const repository = manager.getRepository(RingEvent);
    return repository.save(repository.create(input));
  }

  completeLevelUpOperation(
    manager: EntityManager,
    operation: CopperLevelUpOperation,
    responseSnapshot: Record<string, unknown>,
  ) {
    operation.status = CopperLevelUpOperationStatus.Completed;
    operation.responseSnapshot = responseSnapshot;
    return manager.getRepository(CopperLevelUpOperation).save(operation);
  }

  async claimAttributeAllocationOperation(
    manager: EntityManager,
    input: Pick<CopperAttributeAllocationOperation,
      'ownerUserId' | 'ringId' | 'idempotencyKey' | 'requestFingerprint' | 'rulesVersion'>,
  ) {
    try {
      await manager.createQueryBuilder()
        .insert()
        .into(CopperAttributeAllocationOperation)
        .values({
          ...input,
          status: CopperAttributeAllocationOperationStatus.Pending,
          responseSnapshot: null,
        })
        .orIgnore()
        .execute();
    } catch (error) {
      if (isAllocationRingOwnerForeignKey(error)) return null;
      throw error;
    }

    return manager.getRepository(CopperAttributeAllocationOperation).findOne({
      where: { ownerUserId: input.ownerUserId, idempotencyKey: input.idempotencyKey },
      lock: { mode: 'pessimistic_write' },
    });
  }

  saveAttributeAllocationEvent(manager: EntityManager, input: StarterEventPersistenceInput) {
    const repository = manager.getRepository(RingEvent);
    return repository.save(repository.create(input));
  }

  completeAttributeAllocationOperation(
    manager: EntityManager,
    operation: CopperAttributeAllocationOperation,
    responseSnapshot: Record<string, unknown>,
  ) {
    operation.status = CopperAttributeAllocationOperationStatus.Completed;
    operation.responseSnapshot = responseSnapshot;
    return manager.getRepository(CopperAttributeAllocationOperation).save(operation);
  }

  async findErtBalance(manager: EntityManager, userId: string) {
    const rows = await manager.query(`
      SELECT ert_balance::text AS "ertBalance",
        lifetime_earned_ert::text AS "lifetimeEarnedErt",
        lifetime_spent_ert::text AS "lifetimeSpentErt",
        eru_balance::text AS "eruBalance",
        lifetime_earned_eru::text AS "lifetimeEarnedEru",
        lifetime_spent_eru::text AS "lifetimeSpentEru"
      FROM balances WHERE user_id = $1
    `, [userId]) as ExactErtBalanceRow[];
    return rows[0] ?? null;
  }

  searchRingsForAdmin(manager: EntityManager, input: AdminRingSearchInput) {
    const builder = manager.getRepository(GameRing)
      .createQueryBuilder('ring')
      .innerJoinAndSelect('ring.owner', 'owner')
      .orderBy('ring.createdAt', 'DESC')
      .addOrderBy('ring.id', 'DESC')
      .skip(input.offset)
      .take(input.limit);

    if (input.query) {
      const pattern = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`;
      builder.andWhere(new Brackets((where) => {
        where
          .where(`CAST(ring.id AS text) ILIKE :pattern ESCAPE '\\'`, { pattern })
          .orWhere(`CAST(ring.ownerUserId AS text) ILIKE :pattern ESCAPE '\\'`, { pattern })
          .orWhere(`owner.telegramId ILIKE :pattern ESCAPE '\\'`, { pattern })
          .orWhere(`COALESCE(owner.username, '') ILIKE :pattern ESCAPE '\\'`, { pattern })
          .orWhere(`COALESCE(owner.firstName, '') ILIKE :pattern ESCAPE '\\'`, { pattern })
          .orWhere(`COALESCE(owner.lastName, '') ILIKE :pattern ESCAPE '\\'`, { pattern });
      }));
    }

    return builder.getManyAndCount();
  }

  findRingForAdmin(manager: EntityManager, ringId: string) {
    return manager.getRepository(GameRing).findOne({
      where: { id: ringId },
      relations: { owner: true },
    });
  }

  listEquipmentForRings(manager: EntityManager, ringIds: string[]) {
    if (ringIds.length === 0) return Promise.resolve([]);
    return manager.getRepository(EquippedRing).find({ where: { ringId: In(ringIds) } });
  }

  findEquipmentForRing(manager: EntityManager, ringId: string) {
    return manager.getRepository(EquippedRing).findOne({ where: { ringId } });
  }

  listEventsForAdmin(manager: EntityManager, ringId: string, limit: number, offset: number) {
    return manager.getRepository(RingEvent).findAndCount({
      where: { ringId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: offset,
      take: limit,
    });
  }
}

function isAllocationRingOwnerForeignKey(error: unknown) {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; constraint?: string };
  return driverError.code === '23503'
    && driverError.constraint === 'FK_copper_attribute_allocation_operation_ring_owner';
}
