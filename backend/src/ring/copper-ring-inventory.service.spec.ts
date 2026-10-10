import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { DataSource, EntityManager, TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import { CopperRingEntitlementService } from './copper-ring-entitlement.service';
import { CopperRingInventoryService } from './copper-ring-inventory.service';
import { CopperRingRepository } from './copper-ring.repository';
import { EquippedRing } from './equipped-ring.entity';
import { CopperRingErrorCode } from './copper-ring-errors';
import { RaffleRingAward, RAFFLE_COPPER_FULFILLMENT_VERSION } from '../raffle/raffle-ring-award.entity';
import {
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from './game-ring.entity';

class FakeEntitlementService {
  calls: Array<{ userId: string; reason: CopperIssuanceReason }> = [];

  async ensureStarterCopper(userId: string, reason: CopperIssuanceReason) {
    this.calls.push({ userId, reason });
    return { ring: ring(userId), created: false };
  }
}

class FakeInventoryRepository {
  readonly manager = {} as EntityManager;
  rings: GameRing[] = [];
  equipment: EquippedRing | null = null;
  transactionError: Error | null = null;
  awards: RaffleRingAward[] = [];

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    if (this.transactionError) throw this.transactionError;
    return operation(this.manager);
  }

  async listOwnedRings(manager: EntityManager, userId: string) {
    assert.equal(manager, this.manager);
    return this.rings.filter((candidate) => candidate.ownerUserId === userId);
  }

  async findOwnedRing(manager: EntityManager, userId: string, ringId: string) {
    assert.equal(manager, this.manager);
    return this.rings.find((candidate) => candidate.ownerUserId === userId && candidate.id === ringId) ?? null;
  }

  async findEquipment(manager: EntityManager, userId: string) {
    assert.equal(manager, this.manager);
    return this.equipment?.userId === userId ? this.equipment : null;
  }

  async findRaffleAwardForRing(manager: EntityManager, userId: string, ringId: string) {
    assert.equal(manager, this.manager);
    return this.awards.find((award) => award.ownerUserId === userId && award.ringId === ringId) ?? null;
  }
}

function fixture() {
  const repository = new FakeInventoryRepository();
  const entitlement = new FakeEntitlementService();
  const service = new CopperRingInventoryService(
    repository as unknown as CopperRingRepository,
    entitlement as unknown as CopperRingEntitlementService,
  );
  return { repository, entitlement, service };
}

function user(id = randomUUID()) {
  return Object.assign(new User(), { id });
}

function ring(ownerUserId: string, id = randomUUID()) {
  return Object.assign(new GameRing(), {
    id,
    ownerUserId,
    entitlementCode: 'starter-copper-v1',
    ringKind: GameRingKind.Copper,
    status: GameRingStatus.Active,
    level: 1,
    shine: 100,
    unspentAttributePoints: 0,
    comfort: 2,
    charm: 20,
    quality: 7,
    luck: 11,
    visualVariantCode: CopperVisualVariant.Celtic,
    visualSetVersion: COPPER_VISUAL_SET_VERSION,
    rulesetVersion: COPPER_RULESET_VERSION,
    issuedReason: CopperIssuanceReason.Registration,
    createdAt: new Date('2026-08-19T12:00:00.000Z'),
    updatedAt: new Date('2026-08-19T12:01:00.000Z'),
  });
}

describe('CopperRingInventoryService owner-scoped reads', () => {
  it('requests stable owner inventory ordering and a separate ACTIVE-only economic view', async () => {
    const queries: unknown[] = [];
    const manager = {
      getRepository(target: unknown) {
        assert.equal(target, GameRing);
        return { find: async (options: unknown) => { queries.push(options); return []; } };
      },
    } as unknown as EntityManager;
    const repository = new CopperRingRepository({} as DataSource);
    const ownerId = randomUUID();

    await repository.listOwnedRings(manager, ownerId);
    await repository.listActiveOwnedRings(manager, ownerId);
    assert.deepEqual(queries, [
      { where: { ownerUserId: ownerId }, order: { createdAt: 'ASC', id: 'ASC' } },
      {
        where: { ownerUserId: ownerId, status: GameRingStatus.Active },
        order: { createdAt: 'ASC', id: 'ASC' },
      },
    ]);
  });

  it('returns the stable player DTO after lazy ensure without internal ownership or audit fields', async () => {
    const { repository, entitlement, service } = fixture();
    const owner = user();
    const ownedRing = ring(owner.id);
    repository.rings = [ownedRing, ring(randomUUID())];
    repository.equipment = Object.assign(new EquippedRing(), { userId: owner.id, ringId: ownedRing.id });

    const result = await service.listForOwner(owner);

    assert.deepEqual(entitlement.calls, [{ userId: owner.id, reason: CopperIssuanceReason.LazyEnsure }]);
    assert.deepEqual(result, {
      rings: [{
        id: ownedRing.id,
        ringKind: GameRingKind.Copper,
        status: GameRingStatus.Active,
        level: 1,
        shine: 100,
        unspentAttributePoints: 0,
        attributes: { comfort: 2, charm: 20, quality: 7, luck: 11 },
        visualVariantCode: CopperVisualVariant.Celtic,
        visualSetVersion: COPPER_VISUAL_SET_VERSION,
        rulesetVersion: COPPER_RULESET_VERSION,
        equipped: true,
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:01:00.000Z',
      }],
    });
    assert.equal('ownerUserId' in result.rings[0], false);
    assert.equal('issuedReason' in result.rings[0], false);
    assert.equal('entitlementCode' in result.rings[0], false);
  });

  it('reports a conflict instead of inferring equipment from another account', async () => {
    const { repository, service } = fixture();
    const owner = user();
    const ownedRing = ring(owner.id);
    repository.rings = [ownedRing];
    repository.equipment = Object.assign(new EquippedRing(), { userId: randomUUID(), ringId: ownedRing.id });

    await assertRingError(
      service.getForOwner(owner, ownedRing.id),
      409,
      CopperRingErrorCode.StateConflict,
    );
  });

  it('masks another account ring as not found', async () => {
    const { repository, service } = fixture();
    const owner = user();
    const otherRing = ring(randomUUID());
    repository.rings = [otherRing];

    await assert.rejects(
      () => service.getForOwner(owner, otherRing.id),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 404,
    );
  });

  it('returns immutable starter or raffle provenance only from the detail read', async () => {
    const { repository, service } = fixture();
    const owner = user();
    const awardedRing = ring(owner.id);
    awardedRing.entitlementCode = `raffle-copper-v1:${randomUUID()}`;
    awardedRing.issuedReason = CopperIssuanceReason.Raffle;
    repository.rings = [awardedRing];
    repository.equipment = Object.assign(new EquippedRing(), { userId: owner.id, ringId: awardedRing.id });
    const award = Object.assign(new RaffleRingAward(), {
      id: randomUUID(),
      ownerUserId: owner.id,
      ringId: awardedRing.id,
      drawResultId: randomUUID(),
      rewardId: randomUUID(),
      ringEventId: randomUUID(),
      awardUtcDate: '2026-08-31',
      fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
      rulesetVersion: COPPER_RULESET_VERSION,
      createdAt: new Date('2026-08-31T12:00:00.000Z'),
    });
    repository.awards = [award];

    const detail = await service.getForOwner(owner, awardedRing.id);
    assert.equal(detail.provenance.entitlementCode, awardedRing.entitlementCode);
    assert.equal(detail.provenance.issuedReason, CopperIssuanceReason.Raffle);
    assert.deepEqual(detail.provenance.raffleAward, {
      awardId: award.id,
      drawResultId: award.drawResultId,
      rewardId: award.rewardId,
      ringEventId: award.ringEventId,
      awardUtcDate: '2026-08-31',
      fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
      rulesetVersion: COPPER_RULESET_VERSION,
      createdAt: '2026-08-31T12:00:00.000Z',
    });

    const compact = await service.listForOwner(owner);
    assert.equal('provenance' in compact.rings[0], false);
  });

  it('returns the server-owned automatically equipped ring and equipment timestamp', async () => {
    const { repository, service } = fixture();
    const owner = user();
    const ownedRing = ring(owner.id);
    repository.rings = [ownedRing];
    repository.equipment = Object.assign(new EquippedRing(), {
      userId: owner.id,
      ringId: ownedRing.id,
      equippedAt: new Date('2026-08-19T12:02:00.000Z'),
    });

    const result = await service.getEquippedForOwner(owner);

    assert.equal(result.ring.id, ownedRing.id);
    assert.equal(result.ring.equipped, true);
    assert.equal(result.equippedAt, '2026-08-19T12:02:00.000Z');
  });

  it('fails closed instead of fabricating a missing or cross-owner equipment state', async () => {
    const { repository, service } = fixture();
    const owner = user();
    const otherRing = ring(randomUUID());
    repository.rings = [otherRing];

    await assertRingError(
      service.getEquippedForOwner(owner),
      409,
      CopperRingErrorCode.StateConflict,
    );

    repository.equipment = Object.assign(new EquippedRing(), {
      userId: owner.id,
      ringId: otherRing.id,
      equippedAt: new Date(),
    });
    await assertRingError(
      service.getEquippedForOwner(owner),
      409,
      CopperRingErrorCode.StateConflict,
    );
  });

  it('returns a stable unavailable contract for TypeORM failures', async () => {
    const { repository, service } = fixture();
    repository.transactionError = new TypeORMError('database connection failed');

    await assertRingError(
      service.listForOwner(user()),
      503,
      CopperRingErrorCode.ReadUnavailable,
    );
  });
});

async function assertRingError(promise: Promise<unknown>, status: number, code: CopperRingErrorCode) {
  await assert.rejects(promise, (error) => {
    const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
    return exception.getStatus?.() === status
      && (exception.getResponse?.() as { code?: string }).code === code;
  });
}
