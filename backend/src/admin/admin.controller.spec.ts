import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { GoneException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { LEGACY_RAFFLE_ADMIN_WRITE_RETIRED_CODE } from './admin-legacy-write.errors';

class FakeAdminRewardsService {
  mutationCalls = 0;

  listRewards() {
    return [{ id: 'reward-1' }];
  }

  createReward() { this.mutationCalls += 1; }
  updateReward() { this.mutationCalls += 1; }
  softDisableReward() { this.mutationCalls += 1; }
}

class FakeAdminRafflePoolsService {
  mutationCalls = 0;

  listPools() {
    return [{ id: 'pool-1' }];
  }

  getPoolProbabilities(poolId: string) {
    return { pool: { id: poolId }, rewards: [] };
  }

  createPool() { this.mutationCalls += 1; }
  updatePool() { this.mutationCalls += 1; }
  attachReward() { this.mutationCalls += 1; }
  updatePoolReward() { this.mutationCalls += 1; }
}

class FakeAdminCopperRingsService {
  calls: Array<{ method: string; args: unknown[] }> = [];

  list(input: unknown) {
    this.calls.push({ method: 'list', args: [input] });
    return { items: [] };
  }

  detail(ringId: string) {
    this.calls.push({ method: 'detail', args: [ringId] });
    return { ring: { id: ringId } };
  }

  events(ringId: string, input: unknown) {
    this.calls.push({ method: 'events', args: [ringId, input] });
    return { items: [] };
  }
}

class FakeEruBalanceReadService {
  userIds: string[] = [];

  getRequired(userId: string) {
    this.userIds.push(userId);
    return { userId, eruBalanceExact: '0' };
  }
}

class FakeAdminRaffleV2Service {
  calls: Array<{ method: string; args: unknown[] }> = [];
  overview() { this.calls.push({ method: 'overview', args: [] }); return { machine: null, configurations: [] }; }
  draws(input: unknown) { this.calls.push({ method: 'draws', args: [input] }); return { items: [] }; }
  createReward(input: unknown) { this.calls.push({ method: 'createReward', args: [input] }); return { id: 'reward' }; }
  createDraft(adminId: string, input: unknown) {
    this.calls.push({ method: 'createDraft', args: [adminId, input] }); return { id: 'draft' };
  }
  updateDraft(id: string, input: unknown) {
    this.calls.push({ method: 'updateDraft', args: [id, input] }); return { id };
  }
  replaceDraftRewards(id: string, input: unknown) {
    this.calls.push({ method: 'replaceDraftRewards', args: [id, input] }); return { configurationId: id };
  }
  previewDraft(id: string) {
    this.calls.push({ method: 'previewDraft', args: [id] }); return { configurationId: id, valid: true };
  }
  activateDraft(adminId: string, id: string, input: unknown) {
    this.calls.push({ method: 'activateDraft', args: [adminId, id, input] }); return { activeConfigurationVersion: id };
  }
  setAvailability(adminId: string, action: string, input: unknown) {
    this.calls.push({ method: 'setAvailability', args: [adminId, action, input] }); return { action };
  }
}

describe('AdminController legacy raffle write retirement', () => {
  it('returns one stable 410 code for all legacy commands without invoking mutation services', () => {
    const rewards = new FakeAdminRewardsService();
    const pools = new FakeAdminRafflePoolsService();
    const raffleV2 = new FakeAdminRaffleV2Service();
    const controller = new AdminController(
      rewards as never,
      pools as never,
      {} as never,
      {} as never,
      {} as never,
      raffleV2 as never,
    );

    const commands = [
      () => controller.createReward(),
      () => controller.updateReward(),
      () => controller.softDisableReward(),
      () => controller.createRafflePool(),
      () => controller.updateRafflePool(),
      () => controller.attachReward(),
      () => controller.updatePoolReward(),
    ];
    for (const command of commands) assertLegacyWriteRetired(command);

    assert.equal(rewards.mutationCalls, 0);
    assert.equal(pools.mutationCalls, 0);
  });

  it('preserves legacy catalog/probability reads and typed Raffle v2 reward creation', () => {
    const rewards = new FakeAdminRewardsService();
    const pools = new FakeAdminRafflePoolsService();
    const raffleV2 = new FakeAdminRaffleV2Service();
    const controller = new AdminController(
      rewards as never,
      pools as never,
      {} as never,
      {} as never,
      {} as never,
      raffleV2 as never,
    );

    assert.deepEqual(controller.listRewards(), [{ id: 'reward-1' }]);
    assert.deepEqual(controller.listRafflePools(), [{ id: 'pool-1' }]);
    assert.deepEqual(controller.getRafflePoolProbabilities('pool-1'), {
      pool: { id: 'pool-1' },
      rewards: [],
    });
    assert.deepEqual(controller.createRaffleV2Reward({ type: 'ERT', amountExact: '5' }), { id: 'reward' });
    assert.deepEqual(raffleV2.calls, [
      { method: 'createReward', args: [{ type: 'ERT', amountExact: '5' }] },
    ]);
  });
});

describe('AdminController Copper ring reads', () => {
  it('forwards list, detail, and audit reads without exposing a ring mutation method', () => {
    const rings = new FakeAdminCopperRingsService();
    const eru = new FakeEruBalanceReadService();
    const raffleV2 = new FakeAdminRaffleV2Service();
    const controller = new AdminController(
      {} as never, {} as never, {} as never, rings as never, eru as never, raffleV2 as never,
    );
    const ringId = randomUUID();
    const userId = randomUUID();
    const draftId = randomUUID();

    controller.listRings('owner', 25, 5);
    controller.getRing(ringId);
    controller.listRingEvents(ringId, 10, 2);
    assert.deepEqual(controller.getEruBalance(userId), { userId, eruBalanceExact: '0' });
    assert.deepEqual(controller.getRaffleV2Overview(), { machine: null, configurations: [] });
    assert.deepEqual(controller.listRaffleV2Draws(25, 5), { items: [] });
    assert.deepEqual(controller.createRaffleV2Reward({ type: 'ERT' }), { id: 'reward' });
    assert.deepEqual(controller.createRaffleV2Draft({ user: { id: userId } } as never, { title: 'Draft' }), { id: 'draft' });
    assert.deepEqual(controller.updateRaffleV2Draft(draftId, { title: 'Updated' }), { id: draftId });
    assert.deepEqual(controller.replaceRaffleV2DraftRewards(draftId, { rewards: [] }), { configurationId: draftId });
    assert.deepEqual(controller.previewRaffleV2Draft(draftId), { configurationId: draftId, valid: true });
    assert.deepEqual(
      controller.activateRaffleV2Draft({ user: { id: userId } } as never, draftId, { reason: 'Approved' }),
      { activeConfigurationVersion: draftId },
    );
    assert.deepEqual(controller.pauseRaffleV2({ user: { id: userId } } as never, { reason: 'Pause' }), { action: 'PAUSE' });
    assert.deepEqual(controller.resumeRaffleV2({ user: { id: userId } } as never, { reason: 'Resume' }), { action: 'RESUME' });

    assert.deepEqual(rings.calls, [
      { method: 'list', args: [{ query: 'owner', limit: 25, offset: 5 }] },
      { method: 'detail', args: [ringId] },
      { method: 'events', args: [ringId, { limit: 10, offset: 2 }] },
    ]);
    assert.deepEqual(eru.userIds, [userId]);
    assert.deepEqual(raffleV2.calls, [
      { method: 'overview', args: [] },
      { method: 'draws', args: [{ limit: 25, offset: 5 }] },
      { method: 'createReward', args: [{ type: 'ERT' }] },
      { method: 'createDraft', args: [userId, { title: 'Draft' }] },
      { method: 'updateDraft', args: [draftId, { title: 'Updated' }] },
      { method: 'replaceDraftRewards', args: [draftId, { rewards: [] }] },
      { method: 'previewDraft', args: [draftId] },
      { method: 'activateDraft', args: [userId, draftId, { reason: 'Approved' }] },
      { method: 'setAvailability', args: [userId, 'PAUSE', { reason: 'Pause' }] },
      { method: 'setAvailability', args: [userId, 'RESUME', { reason: 'Resume' }] },
    ]);
    assert.equal('createRing' in controller, false);
    assert.equal('updateRing' in controller, false);
    assert.equal('deleteRing' in controller, false);
    assert.equal('transferRing' in controller, false);
    assert.equal('grantEru' in controller, false);
    assert.equal('adjustEru' in controller, false);
  });
});

function assertLegacyWriteRetired(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof GoneException);
    assert.equal(error.getStatus(), 410);
    assert.equal(
      (error.getResponse() as { code?: string }).code,
      LEGACY_RAFFLE_ADMIN_WRITE_RETIRED_CODE,
    );
    return true;
  });
}
