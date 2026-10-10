import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { CopperAttributeAllocationErrorCode } from './copper-attribute-allocation-errors';
import {
  COPPER_ATTRIBUTE_ALLOCATION_V1,
  COPPER_ATTRIBUTE_ALLOCATION_VERSION,
  CopperAttributeAllocationOperation,
  CopperAttributeAllocationOperationStatus,
} from './copper-attribute-allocation-operation.entity';
import { CopperAttributeAllocationService } from './copper-attribute-allocation.service';
import { CopperRingRepository } from './copper-ring.repository';
import { GameRing } from './game-ring.entity';
import { RingEventType } from './ring-event.entity';

function request(
  expectedUnspentPoints = 8,
  allocation: Record<string, number> = { comfort: 1, charm: 1, quality: 1, luck: 1 },
  idempotencyKey = randomUUID(),
) {
  return { expectedUnspentPoints, allocation, idempotencyKey };
}

function fixture(options: {
  unspent?: number;
  failSave?: boolean;
  failEvent?: boolean;
  failComplete?: boolean;
  missingRing?: boolean;
} = {}) {
  const user = Object.assign(new User(), { id: randomUUID() });
  const ring = Object.assign(new GameRing(), {
    id: randomUUID(),
    ownerUserId: user.id,
    comfort: 20,
    charm: 7,
    quality: 11,
    luck: 2,
    unspentAttributePoints: options.unspent ?? 8,
  });
  const operations = new Map<string, CopperAttributeAllocationOperation>();
  const calls: string[] = [];
  const events: unknown[] = [];

  const repository = {
    transaction: async (operation: (manager: object) => Promise<unknown>) => {
      const beforeRing = {
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
        unspentAttributePoints: ring.unspentAttributePoints,
      };
      const beforeOperations = new Map(operations);
      const beforeEvents = events.length;
      try {
        return await operation({});
      } catch (error) {
        Object.assign(ring, beforeRing);
        operations.clear();
        for (const [key, value] of beforeOperations) operations.set(key, value);
        events.length = beforeEvents;
        throw error;
      }
    },
    claimAttributeAllocationOperation: async (
      _manager: object,
      input: Partial<CopperAttributeAllocationOperation>,
    ) => {
      calls.push('operation');
      const key = `${input.ownerUserId}:${input.idempotencyKey}`;
      const existing = operations.get(key);
      if (existing) return existing;
      const created = Object.assign(new CopperAttributeAllocationOperation(), input, {
        id: randomUUID(),
        status: CopperAttributeAllocationOperationStatus.Pending,
        responseSnapshot: null,
      });
      operations.set(key, created);
      return created;
    },
    lockOwner: async () => { calls.push('owner'); return user; },
    findOwnedRingForUpdate: async () => {
      calls.push('ring');
      return options.missingRing ? null : ring;
    },
    saveRing: async () => {
      calls.push('save-ring');
      if (options.failSave) throw new Error('injected allocation ring save failure');
      return ring;
    },
    saveAttributeAllocationEvent: async (_manager: object, input: { eventType: RingEventType }) => {
      calls.push('event');
      if (options.failEvent) throw new Error('injected allocation audit failure');
      assert.equal(input.eventType, RingEventType.AttributePointsAllocated);
      events.push(input);
      return input;
    },
    completeAttributeAllocationOperation: async (
      _manager: object,
      operation: CopperAttributeAllocationOperation,
      snapshot: Record<string, unknown>,
    ) => {
      calls.push('complete');
      if (options.failComplete) throw new Error('injected allocation completion failure');
      operation.status = CopperAttributeAllocationOperationStatus.Completed;
      operation.responseSnapshot = snapshot;
      return operation;
    },
  };
  return {
    user,
    ring,
    calls,
    operations,
    events,
    service: new CopperAttributeAllocationService(repository as unknown as CopperRingRepository),
  };
}

describe('CopperAttributeAllocationService transactional mutation', () => {
  it('accepts totals one, four, intermediate, and all 76 accumulated points', async () => {
    const allocations = [
      { comfort: 1, charm: 0, quality: 0, luck: 0 },
      { comfort: 0, charm: 4, quality: 0, luck: 0 },
      { comfort: 0, charm: 0, quality: 37, luck: 0 },
      { comfort: 0, charm: 0, quality: 0, luck: 76 },
    ];
    const totals = [1, 4, 37, 76];
    for (let index = 0; index < allocations.length; index += 1) {
      const total = totals[index];
      const state = fixture({ unspent: total });
      const result = await state.service.allocate(
        state.user,
        state.ring.id,
        request(total, allocations[index]),
      ) as Record<string, any>;
      assert.equal(state.ring.unspentAttributePoints, 0);
      assert.equal(result.rulesVersion, COPPER_ATTRIBUTE_ALLOCATION_VERSION);
      assert.deepEqual(result.unspentAttributePoints, {
        previous: total,
        spent: total,
        current: 0,
      });
      assert.equal(Object.values(result.attributes.current).reduce<number>(
        (sum, value) => sum + (value as number), 0,
      ), 40 + total);
      assert.deepEqual(state.calls, ['owner', 'operation', 'ring', 'save-ring', 'event', 'complete']);
    }
  });

  it('retains the exact remainder from an intermediate bulk allocation', async () => {
    const state = fixture({ unspent: 50 });
    const result = await state.service.allocate(
      state.user,
      state.ring.id,
      request(50, { comfort: 10, charm: 9, quality: 8, luck: 10 }),
    ) as Record<string, any>;
    assert.deepEqual(result.unspentAttributePoints, { previous: 50, spent: 37, current: 13 });
    assert.equal(state.ring.unspentAttributePoints, 13);
  });

  it('returns one committed response for same-key replay without another mutation', async () => {
    const state = fixture();
    const body = request();
    const first = await state.service.allocate(state.user, state.ring.id, body);
    const second = await state.service.allocate(state.user, state.ring.id, body);
    assert.deepEqual(second, first);
    assert.equal(state.ring.unspentAttributePoints, 4);
    assert.equal(state.events.length, 1);
    assert.equal(state.calls.filter((call) => call === 'ring').length, 1);
  });

  it('replays an immutable v1 operation using its stored-version fingerprint', async () => {
    const state = fixture();
    const body = request(8, undefined, randomUUID());
    const snapshot = { operationId: randomUUID(), rulesVersion: COPPER_ATTRIBUTE_ALLOCATION_V1 };
    const operation = Object.assign(new CopperAttributeAllocationOperation(), {
      id: snapshot.operationId,
      ownerUserId: state.user.id,
      ringId: state.ring.id,
      idempotencyKey: body.idempotencyKey,
      requestFingerprint: requestFingerprint(
        state.user.id,
        state.ring.id,
        body,
        COPPER_ATTRIBUTE_ALLOCATION_V1,
      ),
      rulesVersion: COPPER_ATTRIBUTE_ALLOCATION_V1,
      status: CopperAttributeAllocationOperationStatus.Completed,
      responseSnapshot: snapshot,
    });
    state.operations.set(`${state.user.id}:${body.idempotencyKey}`, operation);

    assert.deepEqual(await state.service.allocate(state.user, state.ring.id, body), snapshot);
    assert.deepEqual(state.calls, ['owner', 'operation']);
    assert.equal(state.ring.unspentAttributePoints, 8);
    assert.equal(state.events.length, 0);
  });

  it('rejects same-key different allocation before a second ring lock', async () => {
    const state = fixture();
    const key = randomUUID();
    await state.service.allocate(state.user, state.ring.id, request(8, undefined, key));
    await assertCode(
      state.service.allocate(
        state.user,
        state.ring.id,
        request(4, { comfort: 1, charm: 0, quality: 0, luck: 0 }, key),
      ),
      CopperAttributeAllocationErrorCode.IdempotencyConflict,
    );
    assert.equal(state.calls.filter((call) => call === 'ring').length, 1);
  });

  it('rejects stale and over-expected point requests without ring mutation', async () => {
    const stale = fixture({ unspent: 8 });
    await assertCode(
      stale.service.allocate(stale.user, stale.ring.id, request(7)),
      CopperAttributeAllocationErrorCode.StalePoints,
    );
    assert.equal(stale.ring.unspentAttributePoints, 8);

    const overExpected = fixture({ unspent: 8 });
    await assertCode(
      overExpected.service.allocate(
        overExpected.user,
        overExpected.ring.id,
        request(4, { comfort: 5, charm: 0, quality: 0, luck: 0 }),
      ),
      CopperAttributeAllocationErrorCode.AllocationInvalid,
    );
    assert.equal(overExpected.ring.comfort, 20);
    assert.deepEqual(overExpected.calls, []);
  });

  it('masks missing and cross-owner rings as not found', async () => {
    const state = fixture({ missingRing: true });
    await assert.rejects(
      state.service.allocate(state.user, state.ring.id, request()),
      (error) => (error as HttpException).getStatus() === 404,
    );
  });

  it('rolls back ring, points, operation, and event at every persistence boundary', async () => {
    for (const options of [
      { failSave: true },
      { failEvent: true },
      { failComplete: true },
    ]) {
      const state = fixture(options);
      await assert.rejects(
        state.service.allocate(state.user, state.ring.id, request()),
        /injected allocation (ring save|audit|completion) failure/,
      );
      assert.deepEqual(
        [state.ring.comfort, state.ring.charm, state.ring.quality, state.ring.luck],
        [20, 7, 11, 2],
      );
      assert.equal(state.ring.unspentAttributePoints, 8);
      assert.equal(state.operations.size, 0);
      assert.equal(state.events.length, 0);
    }
  });

  it('rejects malformed top-level and allocation bodies before a transaction', async () => {
    const invalidBodies = [
      null,
      {},
      { ...request(), extra: true },
      { ...request(), idempotencyKey: 'invalid' },
      { ...request(), expectedUnspentPoints: 77 },
    ];
    for (const body of invalidBodies) {
      const state = fixture();
      await assertCode(
        state.service.allocate(state.user, state.ring.id, body),
        CopperAttributeAllocationErrorCode.RequestInvalid,
      );
      assert.deepEqual(state.calls, []);
    }

    const invalidAllocations = [
      { comfort: 0, charm: 0, quality: 0, luck: 0 },
      { comfort: 77, charm: 0, quality: 0, luck: 0 },
      { comfort: 1.5, charm: 0, quality: 0, luck: 0 },
      { comfort: -1, charm: 1, quality: 1, luck: 1 },
      { comfort: 1, charm: 0, quality: 0 },
      { comfort: 5, charm: 4, quality: 0, luck: 0 },
    ];
    for (const allocation of invalidAllocations) {
      const state = fixture();
      await assertCode(
        state.service.allocate(state.user, state.ring.id, request(8, allocation as Record<string, number>)),
        CopperAttributeAllocationErrorCode.AllocationInvalid,
      );
      assert.deepEqual(state.calls, []);
    }
  });
});

function requestFingerprint(
  ownerUserId: string,
  ringId: string,
  body: ReturnType<typeof request>,
  rulesVersion: string,
) {
  return createHash('sha256').update(JSON.stringify({
    ownerUserId,
    ringId,
    expectedUnspentPoints: body.expectedUnspentPoints,
    allocation: body.allocation,
    rulesVersion,
  })).digest('hex');
}

async function assertCode(promise: Promise<unknown>, expected: CopperAttributeAllocationErrorCode) {
  await assert.rejects(promise, (error) => {
    const response = (error as HttpException).getResponse() as { code?: string };
    return response.code === expected;
  });
}
