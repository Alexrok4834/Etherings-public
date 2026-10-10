import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { User } from '../auth/user.entity';
import { CopperRingRepository } from './copper-ring.repository';
import { EquippedRing } from './equipped-ring.entity';
import {
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from './game-ring.entity';
import { RingEquipmentErrorCode } from './ring-equipment-errors';
import {
  RING_EQUIPMENT_CONTRACT_VERSION,
  RingEquipmentOperation,
  RingEquipmentOperationStatus,
} from './ring-equipment-operation.entity';
import { RingEquipmentService } from './ring-equipment.service';
import { RingEventType } from './ring-event.entity';

const changedAt = new Date('2026-08-31T12:34:56.000Z');

class FixedTimeEquipmentService extends RingEquipmentService {
  protected override currentTime() {
    return changedAt;
  }
}

function request(expectedEquippedRingId: string, idempotencyKey = randomUUID()) {
  return {
    contractVersion: RING_EQUIPMENT_CONTRACT_VERSION,
    expectedEquippedRingId,
    idempotencyKey,
  };
}

function fixture() {
  const user = Object.assign(new User(), { id: randomUUID() });
  const original = ring(user.id, CopperVisualVariant.PlainPolished, '2026-08-19T10:00:00.000Z');
  const target = ring(user.id, CopperVisualVariant.RuneRough, '2026-08-20T10:00:00.000Z');
  const equipment = Object.assign(new EquippedRing(), {
    userId: user.id,
    ringId: original.id,
    equippedAt: new Date('2026-08-19T10:00:01.000Z'),
    updatedAt: new Date('2026-08-19T10:00:01.000Z'),
  });
  const rings = new Map<string, GameRing>([[original.id, original], [target.id, target]]);
  const operations = new Map<string, RingEquipmentOperation>();
  const events: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let failEvent = false;

  const repository = {
    transaction: async (work: (manager: object) => Promise<unknown>) => {
      calls.push('transaction');
      const equipmentBefore = { ...equipment };
      const operationsBefore = new Map([...operations].map(([key, value]) => [
        key,
        Object.assign(new RingEquipmentOperation(), { ...value }),
      ]));
      const eventCount = events.length;
      try {
        return await work({});
      } catch (error) {
        Object.assign(equipment, equipmentBefore);
        operations.clear();
        for (const [key, value] of operationsBefore) operations.set(key, value);
        events.length = eventCount;
        throw error;
      }
    },
    lockOwner: async () => { calls.push('owner'); return user; },
    findEquipmentOperationForUpdate: async (_manager: object, ownerId: string, key: string) => {
      calls.push('find-operation');
      return operations.get(`${ownerId}:${key}`) ?? null;
    },
    lockEquipment: async () => { calls.push('equipment'); return equipment; },
    findOwnedRingForUpdate: async (_manager: object, ownerId: string, ringId: string) => {
      calls.push('target');
      const found = rings.get(ringId);
      return found?.ownerUserId === ownerId ? found : null;
    },
    claimEquipmentOperation: async (_manager: object, input: Partial<RingEquipmentOperation>) => {
      calls.push('claim');
      const key = `${input.ownerUserId}:${input.idempotencyKey}`;
      const existing = operations.get(key);
      if (existing) return existing;
      const operation = Object.assign(new RingEquipmentOperation(), input, {
        id: randomUUID(),
        status: RingEquipmentOperationStatus.Pending,
        responseSnapshot: null,
        completedAt: null,
        createdAt: new Date('2026-08-31T12:00:00.000Z'),
      });
      operations.set(key, operation);
      return operation;
    },
    saveEquipment: async () => { calls.push('save-equipment'); return equipment; },
    saveEquipmentEvent: async (_manager: object, input: Record<string, unknown>) => {
      calls.push('event');
      if (failEvent) throw new Error('injected equipment event failure');
      events.push(input);
      return input;
    },
    completeEquipmentOperation: async (
      _manager: object,
      operation: RingEquipmentOperation,
      snapshot: Record<string, unknown>,
      completedAt: Date,
    ) => {
      calls.push('complete');
      operation.status = RingEquipmentOperationStatus.Completed;
      operation.responseSnapshot = snapshot;
      operation.completedAt = completedAt;
      return operation;
    },
  };

  return {
    user,
    original,
    target,
    equipment,
    operations,
    events,
    calls,
    setFailEvent: () => { failEvent = true; },
    service: new FixedTimeEquipmentService(repository as unknown as CopperRingRepository),
  };
}

describe('RingEquipmentService internal idempotent command', () => {
  it('switches only owner equipment and appends one EQUIPPED event in frozen lock order', async () => {
    const state = fixture();
    const result = await state.service.equip(
      state.user,
      state.target.id,
      request(state.original.id),
    ) as Record<string, any>;

    assert.deepEqual(state.calls, [
      'transaction',
      'owner',
      'find-operation',
      'equipment',
      'target',
      'claim',
      'save-equipment',
      'event',
      'complete',
    ]);
    assert.equal(state.equipment.ringId, state.target.id);
    assert.equal(state.equipment.equippedAt.toISOString(), changedAt.toISOString());
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].eventType, RingEventType.Equipped);
    assert.equal(result.previousRingId, state.original.id);
    assert.equal(result.currentRingId, state.target.id);
    assert.equal(result.noChange, false);
    assert.equal(result.replay, false);
    assert.equal(result.ring.equipped, true);
  });

  it('returns a completed replay before equipment and target locks', async () => {
    const state = fixture();
    const key = randomUUID();
    const body = request(state.original.id, key);
    const first = await state.service.equip(state.user, state.target.id, body) as Record<string, unknown>;
    state.calls.length = 0;

    const replay = await state.service.equip(state.user, state.target.id, body) as Record<string, unknown>;
    assert.deepEqual(replay, { ...first, replay: true });
    assert.deepEqual(state.calls, ['transaction', 'owner', 'find-operation']);
    assert.equal(state.events.length, 1);
  });

  it('rejects conflicting key reuse before mutable equipment state', async () => {
    const state = fixture();
    const key = randomUUID();
    await state.service.equip(state.user, state.target.id, request(state.original.id, key));
    state.calls.length = 0;

    await assertCode(
      state.service.equip(state.user, state.original.id, request(state.target.id, key)),
      RingEquipmentErrorCode.IdempotencyConflict,
    );
    assert.deepEqual(state.calls, ['transaction', 'owner', 'find-operation']);
  });

  it('rejects stale expected equipment before target and operation claim', async () => {
    const state = fixture();
    await assertCode(
      state.service.equip(state.user, state.target.id, request(randomUUID())),
      RingEquipmentErrorCode.Stale,
    );
    assert.deepEqual(state.calls, ['transaction', 'owner', 'find-operation', 'equipment']);
    assert.equal(state.operations.size, 0);
  });

  it('commits a no-change response without equipment update or duplicate event', async () => {
    const state = fixture();
    const equippedAtBefore = state.equipment.equippedAt.toISOString();
    const result = await state.service.equip(
      state.user,
      state.original.id,
      request(state.original.id),
    ) as Record<string, any>;

    assert.equal(result.noChange, true);
    assert.equal(result.previousRingId, state.original.id);
    assert.equal(result.currentRingId, state.original.id);
    assert.equal(result.equippedAt, equippedAtBefore);
    assert.equal(state.events.length, 0);
    assert.equal(state.calls.includes('save-equipment'), false);
    assert.equal(state.calls.at(-1), 'complete');
  });

  it('masks a missing or cross-owner target and rolls back a failed event', async () => {
    const missing = fixture();
    await assert.rejects(
      missing.service.equip(missing.user, randomUUID(), request(missing.original.id)),
      (error) => (error as HttpException).getStatus() === 404,
    );
    assert.equal(missing.operations.size, 0);

    const failed = fixture();
    failed.setFailEvent();
    await assert.rejects(
      failed.service.equip(failed.user, failed.target.id, request(failed.original.id)),
      /injected equipment event failure/,
    );
    assert.equal(failed.equipment.ringId, failed.original.id);
    assert.equal(failed.operations.size, 0);
    assert.equal(failed.events.length, 0);
  });

  it('rejects malformed route and body values before opening a transaction', async () => {
    const invalid = [
      null,
      {},
      { ...request(randomUUID()), extra: true },
      { ...request(randomUUID()), contractVersion: 'ring-equipment-v2' },
      { ...request(randomUUID()), expectedEquippedRingId: 'invalid' },
      { ...request(randomUUID()), idempotencyKey: 'invalid' },
    ];
    for (const body of invalid) {
      const state = fixture();
      await assertCode(
        state.service.equip(state.user, state.target.id, body),
        RingEquipmentErrorCode.RequestInvalid,
      );
      assert.deepEqual(state.calls, []);
    }

    const state = fixture();
    await assertCode(
      state.service.equip(state.user, 'invalid', request(state.original.id)),
      RingEquipmentErrorCode.RequestInvalid,
    );
    assert.deepEqual(state.calls, []);
  });
});

function ring(ownerUserId: string, visualVariantCode: CopperVisualVariant, createdAt: string) {
  const timestamp = new Date(createdAt);
  return Object.assign(new GameRing(), {
    id: randomUUID(),
    ownerUserId,
    ringKind: GameRingKind.Copper,
    status: GameRingStatus.Active,
    level: 1,
    shine: 100,
    unspentAttributePoints: 0,
    comfort: 10,
    charm: 11,
    quality: 12,
    luck: 13,
    visualVariantCode,
    visualSetVersion: COPPER_VISUAL_SET_VERSION,
    rulesetVersion: COPPER_RULESET_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function assertCode(promise: Promise<unknown>, expected: RingEquipmentErrorCode) {
  await assert.rejects(promise, (error) => {
    const response = (error as HttpException).getResponse() as { code?: string };
    return response.code === expected;
  });
}
