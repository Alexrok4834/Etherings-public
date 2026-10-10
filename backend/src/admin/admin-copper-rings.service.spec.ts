import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager, TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import { CopperRingRepository, AdminRingSearchInput } from '../ring/copper-ring.repository';
import { EquippedRing } from '../ring/equipped-ring.entity';
import {
  COPPER_GENERATION_VERSION,
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from '../ring/game-ring.entity';
import { RingEvent, RingEventType } from '../ring/ring-event.entity';
import { CopperRingErrorCode } from '../ring/copper-ring-errors';
import { RaffleRingAward, RAFFLE_COPPER_FULFILLMENT_VERSION } from '../raffle/raffle-ring-award.entity';
import { AdminCopperRingsService } from './admin-copper-rings.service';

class FakeRingRepository {
  readonly manager = {} as EntityManager;
  rings: GameRing[] = [];
  equipment: EquippedRing[] = [];
  ringEvents: RingEvent[] = [];
  searchCalls: AdminRingSearchInput[] = [];
  transactionError: Error | null = null;
  awards: RaffleRingAward[] = [];

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    if (this.transactionError) throw this.transactionError;
    return operation(this.manager);
  }

  async searchRingsForAdmin(manager: EntityManager, input: AdminRingSearchInput) {
    assert.equal(manager, this.manager);
    this.searchCalls.push(input);
    return [this.rings, this.rings.length] as [GameRing[], number];
  }

  async listEquipmentForRings(manager: EntityManager, ringIds: string[]) {
    assert.equal(manager, this.manager);
    return this.equipment.filter((item) => ringIds.includes(item.ringId));
  }

  async findRingForAdmin(manager: EntityManager, ringId: string) {
    assert.equal(manager, this.manager);
    return this.rings.find((item) => item.id === ringId) ?? null;
  }

  async findEquipmentForRing(manager: EntityManager, ringId: string) {
    assert.equal(manager, this.manager);
    return this.equipment.find((item) => item.ringId === ringId) ?? null;
  }

  async findRaffleAwardForRing(manager: EntityManager, ownerUserId: string, ringId: string) {
    assert.equal(manager, this.manager);
    return this.awards.find((award) => award.ownerUserId === ownerUserId && award.ringId === ringId) ?? null;
  }

  async listEventsForAdmin(manager: EntityManager, ringId: string, limit: number, offset: number) {
    assert.equal(manager, this.manager);
    const matches = this.ringEvents.filter((item) => item.ringId === ringId);
    return [matches.slice(offset, offset + limit), matches.length] as [RingEvent[], number];
  }
}

function fixture() {
  const repository = new FakeRingRepository();
  const service = new AdminCopperRingsService(repository as unknown as CopperRingRepository);
  return { repository, service };
}

function owner(id = randomUUID()) {
  return Object.assign(new User(), {
    id,
    telegramId: 'admin-search-100',
    username: 'ring_owner',
    firstName: 'Ring',
    lastName: 'Owner',
  });
}

function ring(ringOwner = owner(), id = randomUUID()) {
  return Object.assign(new GameRing(), {
    id,
    ownerUserId: ringOwner.id,
    owner: ringOwner,
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
    rulesetVersion: COPPER_RULESET_VERSION,
    generationVersion: COPPER_GENERATION_VERSION,
    visualSetVersion: COPPER_VISUAL_SET_VERSION,
    issuedReason: CopperIssuanceReason.Registration,
    createdAt: new Date('2026-08-19T12:00:00.000Z'),
    updatedAt: new Date('2026-08-19T12:01:00.000Z'),
  });
}

function equipment(item: GameRing) {
  return Object.assign(new EquippedRing(), {
    userId: item.ownerUserId,
    ringId: item.id,
    equippedAt: new Date('2026-08-19T12:02:00.000Z'),
    updatedAt: new Date('2026-08-19T12:03:00.000Z'),
  });
}

function event(item: GameRing) {
  return Object.assign(new RingEvent(), {
    id: randomUUID(),
    ringId: item.id,
    ownerUserId: item.ownerUserId,
    operationKey: `starter-copper-v1:${item.ownerUserId}`,
    eventType: RingEventType.StarterIssued,
    rulesetVersion: COPPER_RULESET_VERSION,
    snapshot: { ringId: item.id, ownerUserId: item.ownerUserId },
    createdAt: new Date('2026-08-19T12:04:00.000Z'),
  });
}

describe('AdminCopperRingsService read-only views', () => {
  it('returns paginated ring, owner, and equipment data and normalizes search input', async () => {
    const { repository, service } = fixture();
    const item = ring();
    repository.rings = [item];
    repository.equipment = [equipment(item)];

    const result = await service.list({ query: '  ring_owner  ', limit: 20, offset: 5 });

    assert.deepEqual(repository.searchCalls, [{ query: 'ring_owner', limit: 20, offset: 5 }]);
    assert.equal(result.total, 1);
    assert.equal(result.limit, 20);
    assert.equal(result.offset, 5);
    assert.equal(result.items[0].owner.id, item.ownerUserId);
    assert.equal(result.items[0].owner.username, 'ring_owner');
    assert.equal(result.items[0].equipment?.userId, item.ownerUserId);
    assert.equal(result.items[0].unspentAttributePoints, 0);
    assert.deepEqual(result.items[0].attributes, { comfort: 2, charm: 20, quality: 7, luck: 11 });
  });

  it('uses bounded defaults and rejects unsafe pagination or oversized search', async () => {
    const { repository, service } = fixture();
    await service.list({});
    assert.deepEqual(repository.searchCalls, [{ query: null, limit: 50, offset: 0 }]);

    await assert.rejects(() => service.list({ limit: 0 }), /limit must be/);
    await assert.rejects(() => service.list({ limit: 101 }), /limit must be/);
    await assert.rejects(() => service.list({ offset: -1 }), /offset must be/);
    await assert.rejects(() => service.list({ query: 'x'.repeat(129) }), /query must not exceed/);
  });

  it('returns ring detail and masks absent records as not found', async () => {
    const { repository, service } = fixture();
    const item = ring();
    repository.rings = [item];
    repository.equipment = [equipment(item)];

    const result = await service.detail(item.id);
    assert.equal(result.ring.id, item.id);
    assert.equal(result.ring.issuedReason, CopperIssuanceReason.Registration);
    assert.equal(result.ring.raffleAward, null);
    await assert.rejects(
      () => service.detail(randomUUID()),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 404,
    );
  });

  it('returns immutable raffle award references in admin detail', async () => {
    const { repository, service } = fixture();
    const item = ring();
    item.issuedReason = CopperIssuanceReason.Raffle;
    const award = Object.assign(new RaffleRingAward(), {
      id: randomUUID(),
      ownerUserId: item.ownerUserId,
      ringId: item.id,
      drawResultId: randomUUID(),
      rewardId: randomUUID(),
      ringEventId: randomUUID(),
      awardUtcDate: '2026-08-31',
      fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
      rulesetVersion: COPPER_RULESET_VERSION,
      createdAt: new Date('2026-08-31T12:00:00.000Z'),
    });
    repository.rings = [item];
    repository.awards = [award];

    const result = await service.detail(item.id);
    assert.equal(result.ring.raffleAward?.id, award.id);
    assert.equal(result.ring.raffleAward?.drawResultId, award.drawResultId);
    assert.equal(result.ring.raffleAward?.createdAt, '2026-08-31T12:00:00.000Z');
  });

  it('returns immutable audit snapshots without creating or changing events', async () => {
    const { repository, service } = fixture();
    const item = ring();
    const issued = event(item);
    repository.rings = [item];
    repository.ringEvents = [issued];

    const result = await service.events(item.id, { limit: 10, offset: 0 });

    assert.equal(result.total, 1);
    assert.deepEqual(result.items[0].snapshot, issued.snapshot);
    assert.equal(repository.ringEvents.length, 1);
    await assert.rejects(
      () => service.events(randomUUID(), {}),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 404,
    );
  });

  it('returns the stable unavailable code for a TypeORM read failure', async () => {
    const { repository, service } = fixture();
    repository.transactionError = new TypeORMError('database unavailable');

    await assert.rejects(() => service.list({}), (error) => {
      const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
      return exception.getStatus?.() === 503
        && (exception.getResponse?.() as { code?: string }).code === CopperRingErrorCode.ReadUnavailable;
    });
  });
});
