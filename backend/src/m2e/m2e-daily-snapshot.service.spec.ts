import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CopperRingEntitlementService } from '../ring/copper-ring-entitlement.service';
import { CopperRingRepository } from '../ring/copper-ring.repository';
import { CopperVisualVariant, GameRing, GameRingStatus } from '../ring/game-ring.entity';
import { M2eBalanceConfigService } from './m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';
import { M2E_RING_SELECTION_UNAVAILABLE } from './m2e-daily-snapshot.errors';
import { M2eDailySnapshotService } from './m2e-daily-snapshot.service';
import { M2eEarningCalculator } from './m2e-earning-calculator';

type SnapshotRepository = {
  rows: M2eDailyEconomicSnapshot[];
  findOne: (options: unknown) => Promise<M2eDailyEconomicSnapshot | null>;
  create: (input: Partial<M2eDailyEconomicSnapshot>) => M2eDailyEconomicSnapshot;
  save: (snapshot: M2eDailyEconomicSnapshot) => Promise<M2eDailyEconomicSnapshot>;
};

function setup(options: { rings?: GameRing[]; equippedRingId?: string | null } = {}) {
  const rings = options.rings ?? [ring('ring-1', 20)];
  let equippedRingId = options.equippedRingId === undefined ? rings[0]?.id ?? null : options.equippedRingId;
  const snapshots: SnapshotRepository = {
    rows: [],
    async findOne(optionsValue: unknown) {
      const where = (optionsValue as { where: { userId: string; accountingDate: string } }).where;
      return this.rows.find((row) => row.userId === where.userId
        && row.accountingDate === where.accountingDate) ?? null;
    },
    create(input) {
      return { id: `snapshot-${this.rows.length + 1}`, ...input } as M2eDailyEconomicSnapshot;
    },
    async save(snapshot) {
      this.rows.push(snapshot);
      return snapshot;
    },
  };
  const manager = {
    getRepository(target: unknown) {
      assert.equal(target, M2eDailyEconomicSnapshot);
      return snapshots;
    },
  } as unknown as EntityManager;
  const entitlementCalls: Array<{ userId: string; reason: string }> = [];
  const entitlement = {
    async ensureStarterCopperInTransaction(_manager: EntityManager, userId: string, reason: string) {
      entitlementCalls.push({ userId, reason });
      return { ring: rings[0], created: false };
    },
  } as unknown as CopperRingEntitlementService;
  const ringRepository = {
    async lockOwner() { return { id: 'user-1' }; },
    async listActiveOwnedRings(_manager: EntityManager, userId: string) {
      return rings.filter((item) => item.ownerUserId === userId && item.status === GameRingStatus.Active);
    },
    async findEquipment() { return equippedRingId === null ? null : { ringId: equippedRingId }; },
  } as unknown as CopperRingRepository;
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  const service = new M2eDailySnapshotService(
    config,
    new M2eEarningCalculator(config),
    entitlement,
    ringRepository,
  );
  return {
    service,
    manager,
    snapshots,
    entitlementCalls,
    rings,
    setEquippedRingId: (ringId: string | null) => { equippedRingId = ringId; },
  };
}

function ring(id: string, comfort: number) {
  return {
    id,
    ownerUserId: 'user-1',
    status: GameRingStatus.Active,
    comfort,
    visualVariantCode: CopperVisualVariant.PlainPolished,
  } as GameRing;
}

describe('M2eDailySnapshotService', () => {
  it('returns the locked immutable snapshot without reading current Ring state', async () => {
    const state = setup();
    const existing = {
      id: 'snapshot-existing',
      userId: 'user-1',
      accountingDate: '2026-08-21',
      selectedRingId: 'ring-old',
      selectedRingComfort: 7,
      ringCount: 1,
      stepCap: 5000,
    } as M2eDailyEconomicSnapshot;
    state.snapshots.rows.push(existing);

    const result = await state.service.getOrCreateInTransaction(
      state.manager,
      'user-1',
      '2026-08-21',
    );

    assert.equal(result, existing);
    assert.deepEqual(state.entitlementCalls, []);
    assert.equal(state.snapshots.rows.length, 1);
  });

  it('snapshots the sole automatically equipped Ring and central balance constants', async () => {
    const state = setup();

    const result = await state.service.getOrCreateInTransaction(
      state.manager,
      'user-1',
      '2026-08-21',
    );

    assert.deepEqual(state.entitlementCalls, [{ userId: 'user-1', reason: 'LAZY_ENSURE' }]);
    assert.deepEqual({
      userId: result.userId,
      accountingDate: result.accountingDate,
      selectedRingId: result.selectedRingId,
      ringCount: result.ringCount,
      selectedRingComfort: result.selectedRingComfort,
      stepCap: result.stepCap,
      rulesVersion: result.rulesVersion,
      balanceConfigVersion: result.balanceConfigVersion,
      baseSteps: result.baseSteps,
      extraStepsPerRing: result.extraStepsPerRing,
      baseErtPer1000Steps: result.baseErtPer1000Steps,
      comfortCurveK: result.comfortCurveK,
    }, {
      userId: 'user-1',
      accountingDate: '2026-08-21',
      selectedRingId: 'ring-1',
      ringCount: 1,
      selectedRingComfort: 20,
      stepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
      baseSteps: 5000,
      extraStepsPerRing: 1000,
      baseErtPer1000Steps: '0.871',
      comfortCurveK: 20,
    });
  });

  it('keeps one date frozen and snapshots changed Comfort only on the next date', async () => {
    const state = setup();
    const first = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-21');
    state.rings[0].comfort = 24;
    const retry = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-21');
    const next = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-22');

    assert.equal(first.selectedRingComfort, 20);
    assert.equal(retry.selectedRingComfort, 20);
    assert.equal(next.selectedRingComfort, 24);
  });

  it('counts every owned ACTIVE Ring and uses only the equipped Ring Comfort', async () => {
    const state = setup({
      rings: [ring('ring-1', 20), ring('ring-2', 30)],
      equippedRingId: 'ring-2',
    });
    const result = await state.service.getOrCreateInTransaction(
      state.manager,
      'user-1',
      '2026-08-21',
    );
    assert.equal(result.ringCount, 2);
    assert.equal(result.stepCap, 6000);
    assert.equal(result.selectedRingId, 'ring-2');
    assert.equal(result.selectedRingComfort, 30);
  });

  it('ignores non-ACTIVE and other-owner Rings when freezing ring count', async () => {
    const inactive = ring('ring-inactive', 99);
    inactive.status = 'INACTIVE' as GameRingStatus;
    const otherOwner = ring('ring-other-owner', 88);
    otherOwner.ownerUserId = 'user-2';
    const state = setup({ rings: [ring('ring-1', 20), inactive, otherOwner] });
    const result = await state.service.getOrCreateInTransaction(
      state.manager,
      'user-1',
      '2026-08-21',
    );
    assert.equal(result.ringCount, 1);
    assert.equal(result.stepCap, 5000);
    assert.equal(result.selectedRingComfort, 20);
  });

  it('keeps an existing day frozen and observes later Ring/equipment state only next day', async () => {
    const state = setup();
    const first = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-21');
    state.rings.push(ring('ring-2', 45));
    state.setEquippedRingId('ring-2');

    const sameDay = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-21');
    const nextDay = await state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-22');
    assert.equal(sameDay, first);
    assert.deepEqual(
      [sameDay.ringCount, sameDay.selectedRingId, sameDay.selectedRingComfort, sameDay.stepCap],
      [1, 'ring-1', 20, 5000],
    );
    assert.deepEqual(
      [nextDay.ringCount, nextDay.selectedRingId, nextDay.selectedRingComfort, nextDay.stepCap],
      [2, 'ring-2', 45, 6000],
    );
  });

  it('fails closed when equipment does not select the sole owned Ring', async () => {
    const state = setup({ equippedRingId: 'ring-other' });
    await assertSelectionUnavailable(
      state.service.getOrCreateInTransaction(state.manager, 'user-1', '2026-08-21'),
    );
    assert.equal(state.snapshots.rows.length, 0);
  });
});

async function assertSelectionUnavailable(promise: Promise<unknown>) {
  await assert.rejects(promise, (error) => {
    if (!(error instanceof ConflictException)) return false;
    const response = error.getResponse() as { code?: string };
    return response.code === M2E_RING_SELECTION_UNAVAILABLE;
  });
}
