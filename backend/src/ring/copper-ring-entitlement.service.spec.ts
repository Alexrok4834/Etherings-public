import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager } from 'typeorm';
import { User } from '../auth/user.entity';
import { CopperRingEntitlementService } from './copper-ring-entitlement.service';
import { CopperInitialAttributes, CopperRingRandomService } from './copper-ring-random.service';
import { CopperRingRepository, StarterEventPersistenceInput, StarterRingPersistenceInput } from './copper-ring.repository';
import { EquippedRing } from './equipped-ring.entity';
import {
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingStatus,
} from './game-ring.entity';
import { RingEvent } from './ring-event.entity';
import { CopperRingErrorCode } from './copper-ring-errors';

class FakeRandom extends CopperRingRandomService {
  attributeCalls = 0;
  visualCalls = 0;

  constructor(
    private readonly attributes: CopperInitialAttributes = { comfort: 2, charm: 20, quality: 7, luck: 11 },
    private readonly visual: CopperVisualVariant = CopperVisualVariant.Filigree,
  ) {
    super();
  }

  override generateAttributes() {
    this.attributeCalls += 1;
    return this.attributes;
  }

  override selectVisualVariant() {
    this.visualCalls += 1;
    return this.visual;
  }
}

class FakeCopperRingRepository {
  readonly manager = {} as EntityManager;
  owner: User | null = Object.assign(new User(), { id: randomUUID() });
  ring: GameRing | null = null;
  equipment: EquippedRing | null = null;
  equipmentTarget: GameRing | null = null;
  event: RingEvent | null = null;
  transactionCalls = 0;
  ringWrites = 0;
  equipmentWrites = 0;
  eventWrites = 0;

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    this.transactionCalls += 1;
    return operation(this.manager);
  }

  async lockOwner(manager: EntityManager) {
    assert.equal(manager, this.manager);
    return this.owner;
  }

  async findStarterForUpdate(manager: EntityManager) {
    assert.equal(manager, this.manager);
    return this.ring;
  }

  async saveStarterRing(manager: EntityManager, input: StarterRingPersistenceInput) {
    assert.equal(manager, this.manager);
    this.ringWrites += 1;
    this.ring = Object.assign(new GameRing(), input, {
      id: randomUUID(),
      createdAt: new Date('2026-08-19T12:00:00.000Z'),
      updatedAt: new Date('2026-08-19T12:00:00.000Z'),
    });
    return this.ring;
  }

  async saveAutomaticEquipment(manager: EntityManager, userId: string, ringId: string) {
    assert.equal(manager, this.manager);
    this.equipmentWrites += 1;
    this.equipment = Object.assign(new EquippedRing(), { userId, ringId });
    return this.equipment;
  }

  async saveStarterEvent(manager: EntityManager, input: StarterEventPersistenceInput) {
    assert.equal(manager, this.manager);
    this.eventWrites += 1;
    this.event = Object.assign(new RingEvent(), input, { id: randomUUID(), createdAt: new Date() });
    return this.event;
  }

  async findEquipment(manager: EntityManager) {
    assert.equal(manager, this.manager);
    return this.equipment;
  }

  async findStarterEvent(manager: EntityManager) {
    assert.equal(manager, this.manager);
    return this.event;
  }

  async findOwnedRing(manager: EntityManager, userId: string, ringId: string) {
    assert.equal(manager, this.manager);
    const candidates = [this.ring, this.equipmentTarget];
    return candidates.find((ring) => ring?.id === ringId && ring.ownerUserId === userId) ?? null;
  }
}

function fixture(random = new FakeRandom()) {
  const repository = new FakeCopperRingRepository();
  const service = new CopperRingEntitlementService(
    repository as unknown as CopperRingRepository,
    random,
  );
  return { repository, random, service };
}

describe('CopperRingEntitlementService internal transaction boundary', () => {
  it('persists one complete aggregate and returns it unchanged on retry', async () => {
    const { repository, random, service } = fixture();
    const userId = repository.owner!.id;

    const first = await service.ensureStarterCopper(userId, CopperIssuanceReason.Registration);
    assert.equal(first.created, true);
    assert.equal(first.ring.ownerUserId, userId);
    assert.equal(repository.equipment?.ringId, first.ring.id);
    assert.equal(repository.event?.ownerUserId, userId);
    assert.equal(first.ring.unspentAttributePoints, 0);
    assert.equal(repository.event?.snapshot.unspentAttributePoints, 0);
    assert.equal(repository.event?.snapshot.visualVariantCode, CopperVisualVariant.Filigree);
    assert.equal(repository.event?.snapshot.createdAt, '2026-08-19T12:00:00.000Z');

    const retry = await service.ensureStarterCopper(userId, CopperIssuanceReason.LazyEnsure);
    assert.equal(retry.created, false);
    assert.equal(retry.ring.id, first.ring.id);
    assert.deepEqual({
      transactions: repository.transactionCalls,
      ringWrites: repository.ringWrites,
      equipmentWrites: repository.equipmentWrites,
      eventWrites: repository.eventWrites,
      attributeCalls: random.attributeCalls,
      visualCalls: random.visualCalls,
    }, {
      transactions: 2,
      ringWrites: 1,
      equipmentWrites: 1,
      eventWrites: 1,
      attributeCalls: 1,
      visualCalls: 1,
    });
  });

  it('fails closed for a missing owner without RNG or writes', async () => {
    const { repository, random, service } = fixture();
    repository.owner = null;

    await assert.rejects(
      () => service.ensureStarterCopper(randomUUID(), CopperIssuanceReason.LegacyBackfill),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 404,
    );
    assert.equal(random.attributeCalls, 0);
    assert.equal(repository.ringWrites, 0);
  });

  it('accepts a complete starter aggregate when another owned active Ring is equipped', async () => {
    const { repository, service } = fixture();
    const userId = repository.owner!.id;
    const first = await service.ensureStarterCopper(userId, CopperIssuanceReason.Registration);
    const raffleRing = Object.assign(new GameRing(), {
      id: randomUUID(),
      ownerUserId: userId,
      status: GameRingStatus.Active,
    });
    repository.equipmentTarget = raffleRing;
    repository.equipment!.ringId = raffleRing.id;

    const existing = await service.ensureStarterCopper(userId, CopperIssuanceReason.LazyEnsure);

    assert.equal(existing.created, false);
    assert.equal(existing.ring.id, first.ring.id);
    assert.equal(repository.equipmentWrites, 1);
  });

  it('rejects equipment that no longer points to an owned active Ring', async () => {
    const { repository, service } = fixture();
    const userId = repository.owner!.id;
    await service.ensureStarterCopper(userId, CopperIssuanceReason.Registration);
    repository.equipment!.ringId = randomUUID();

    await assert.rejects(
      () => service.ensureStarterCopper(userId, CopperIssuanceReason.LazyEnsure),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 409,
    );
  });

  it('rejects invalid generated attributes before persisting anything', async () => {
    const random = new FakeRandom({ comfort: 1, charm: 20, quality: 7, luck: 11 });
    const { repository, service } = fixture(random);

    await assert.rejects(
      () => service.ensureStarterCopper(repository.owner!.id, CopperIssuanceReason.Registration),
      /invalid comfort/,
    );
    assert.equal(repository.ringWrites, 0);
    assert.equal(repository.equipmentWrites, 0);
    assert.equal(repository.eventWrites, 0);
  });

  it('does not repair or overwrite an incomplete committed aggregate', async () => {
    const { repository, random, service } = fixture();
    repository.ring = Object.assign(new GameRing(), { id: randomUUID(), ownerUserId: repository.owner!.id });

    await assert.rejects(() => service.ensureStarterCopper(repository.owner!.id, CopperIssuanceReason.LazyEnsure), (error) => {
      const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
      return exception.getStatus?.() === 409
        && (exception.getResponse?.() as { code?: string }).code === CopperRingErrorCode.StateConflict;
    });
    assert.equal(random.attributeCalls, 0);
    assert.equal(repository.ringWrites, 0);
  });
});
