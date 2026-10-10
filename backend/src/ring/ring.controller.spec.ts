import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { User } from '../auth/user.entity';
import { CopperLevelUpPreviewService } from './copper-level-up-preview.service';
import { CopperLevelUpService } from './copper-level-up.service';
import { CopperAttributeAllocationService } from './copper-attribute-allocation.service';
import { CopperRingInventoryService } from './copper-ring-inventory.service';
import { RingController } from './ring.controller';
import { RingEquipmentService } from './ring-equipment.service';

function fixture() {
  const calls: Array<{ operation: string; userId: string; ringId?: string }> = [];
  const inventory = {
    listForOwner: async (user: User) => {
      calls.push({ operation: 'list', userId: user.id });
      return { rings: [] };
    },
    getForOwner: async (user: User, ringId: string) => {
      calls.push({ operation: 'detail', userId: user.id, ringId });
      return { id: ringId };
    },
    getEquippedForOwner: async (user: User) => {
      calls.push({ operation: 'equipped', userId: user.id });
      return { ring: { id: 'equipped-ring' }, equippedAt: '2026-08-19T12:02:00.000Z' };
    },
  };
  const preview = {
    preview: async (user: User, ringId: string, body: unknown) => {
      calls.push({ operation: 'preview', userId: user.id, ringId });
      return { ringId, body };
    },
  };
  const levelUp = {
    levelUp: async (user: User, ringId: string, body: unknown) => {
      calls.push({ operation: 'level-up', userId: user.id, ringId });
      return { ringId, body };
    },
  };
  const attributeAllocation = {
    allocate: async (user: User, ringId: string, body: unknown) => {
      calls.push({ operation: 'allocate', userId: user.id, ringId });
      return { ringId, body };
    },
  };
  const equipment = {
    equip: async (user: User, ringId: string, body: unknown) => {
      calls.push({ operation: 'equip', userId: user.id, ringId });
      return { ringId, body };
    },
  };
  return {
    calls,
    controller: new RingController(
      inventory as unknown as CopperRingInventoryService,
      preview as unknown as CopperLevelUpPreviewService,
      levelUp as unknown as CopperLevelUpService,
      attributeAllocation as unknown as CopperAttributeAllocationService,
      equipment as unknown as RingEquipmentService,
    ),
  };
}

describe('RingController authenticated owner contract', () => {
  it('forwards only the authenticated request user to list and detail reads', async () => {
    const { calls, controller } = fixture();
    const requestUser = Object.assign(new User(), { id: randomUUID() });
    const ringId = randomUUID();

    assert.deepEqual(await controller.list({ headers: {}, user: requestUser }), { rings: [] });
    assert.deepEqual(await controller.equipped({ headers: {}, user: requestUser }), {
      ring: { id: 'equipped-ring' },
      equippedAt: '2026-08-19T12:02:00.000Z',
    });
    assert.deepEqual(await controller.detail({ headers: {}, user: requestUser }, ringId), { id: ringId });
    const body = { expectedCurrentLevel: 1, targetLevel: 2 };
    assert.deepEqual(await controller.previewLevelUp({ headers: {}, user: requestUser }, ringId, body), {
      ringId,
      body,
    });
    assert.deepEqual(await controller.performLevelUp({ headers: {}, user: requestUser }, ringId, body), {
      ringId,
      body,
    });
    assert.deepEqual(await controller.allocateAttributePoints(
      { headers: {}, user: requestUser },
      ringId,
      body,
    ), { ringId, body });
    assert.deepEqual(await controller.equipRing({ headers: {}, user: requestUser }, ringId, body), {
      ringId,
      body,
    });
    assert.deepEqual(calls, [
      { operation: 'list', userId: requestUser.id },
      { operation: 'equipped', userId: requestUser.id },
      { operation: 'detail', userId: requestUser.id, ringId },
      { operation: 'preview', userId: requestUser.id, ringId },
      { operation: 'level-up', userId: requestUser.id, ringId },
      { operation: 'allocate', userId: requestUser.id, ringId },
      { operation: 'equip', userId: requestUser.id, ringId },
    ]);
  });

  it('rejects a request that reaches the controller without a JWT user', async () => {
    const { controller } = fixture();
    assert.throws(
      () => controller.list({ headers: {} }),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 401,
    );
    assert.throws(
      () => controller.previewLevelUp({ headers: {} }, randomUUID(), {}),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 401,
    );
    assert.throws(
      () => controller.performLevelUp({ headers: {} }, randomUUID(), {}),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 401,
    );
    assert.throws(
      () => controller.allocateAttributePoints({ headers: {} }, randomUUID(), {}),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 401,
    );
    assert.throws(
      () => controller.equipRing({ headers: {} }, randomUUID(), {}),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 401,
    );
  });
});
