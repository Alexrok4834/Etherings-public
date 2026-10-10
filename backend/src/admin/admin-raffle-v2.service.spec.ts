import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminRaffleV2Service } from './admin-raffle-v2.service';

const machineId = '10000000-0000-4000-8000-000000000001';
const configurationId = '10000000-0000-4000-8000-000000000002';
const rewardId = '10000000-0000-4000-8000-000000000003';
const activeConfigurationId = '10000000-0000-4000-8000-000000000004';
const adminId = '10000000-0000-4000-8000-000000000005';
const idempotencyKey = '10000000-0000-4000-8000-000000000006';
const operationId = '10000000-0000-4000-8000-000000000007';

class FakeDataSource {
  calls: Array<{ sql: string; parameters?: unknown[] }> = [];
  async query(sql: string, parameters?: unknown[]) {
    this.calls.push({ sql, parameters });
    if (sql.includes('FROM "raffle_machines"')) return [{
      machineId, machineCode: 'daily-draw-v2', machineAvailable: true, machinePausedAt: null,
      machineCreatedAt: new Date('2026-08-30T00:00:00Z'),
      configurationId, contractVersion: 'raffle-v2', status: 'ACTIVE', title: 'Daily Draw', description: null,
      costErtExact: '7.500000000000000000', dailyUserAttemptLimit: 3,
      createdByUserId: machineId, createdAt: new Date('2026-08-30T01:00:00Z'),
      activatedAt: new Date('2026-08-30T02:00:00Z'), disabledAt: null,
    }];
    if (sql.includes('FROM "raffle_configuration_rewards"')) return [{
      configurationId, rewardId, segmentIndex: 0, weight: 7,
      rewardSnapshot: { rewardId, type: 'ERT', amountExact: '10' },
      liveCode: 'ert-10', liveTitle: '10 ERT', liveType: 'ERT', liveActive: true,
      liveStockTotal: null, liveStockRemaining: null, livePerUserLimit: null, liveDailyGlobalLimit: null,
    }];
    return [{
      drawResultId: machineId, operationId: configurationId, ownerUserId: rewardId,
      machineId, configurationId, selectedRewardId: rewardId, selectedSegmentIndex: 0,
      algorithm: 'CSPRNG_UNBIASED_INT_V1', ticket: 3, totalWeight: 7,
      rangesSnapshot: { ranges: [] }, costErtExact: '7.500000000000000000',
      createdAt: new Date('2026-09-01T10:00:00Z'), idempotencyKey: machineId,
      operationStatus: 'COMPLETED', responseSnapshot: {}, completedAt: new Date('2026-09-01T10:00:01Z'),
      rewardCode: 'ert-10', rewardTitle: '10 ERT', rewardType: 'ERT',
      ringAwardId: null, ringId: null, ringEventId: null,
    }];
  }
}

class DraftDataSource {
  configurationStatus = 'DRAFT';
  queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  manager = {
    query: async (sql: string, parameters?: unknown[]) => {
      this.queries.push({ sql, parameters });
      if (sql.includes('SELECT "id", "status"')) {
        return [{ id: configurationId, status: this.configurationStatus }];
      }
      if (sql.includes('"cost_ert"::text AS "costErtExact"')) {
        return [{ id: configurationId, status: this.configurationStatus, costErtExact: '5', dailyUserAttemptLimit: 5 }];
      }
      if (sql.includes('mapping."reward_snapshot" AS "snapshot"')) {
        return [{
          rewardId, segmentIndex: 0, weight: 1,
          snapshot: { rewardId, type: 'ERT', amountExact: '10' },
          liveId: rewardId, liveType: 'ERT', liveActive: true, liveAmount: '10', liveAmountExact: null,
          stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
        }];
      }
      if (sql.includes('FROM "rewards"')) {
        return [{
          id: rewardId, code: 'ert-10', title: '10 ERT', type: 'ERT', amount: '10', amountExact: '10',
          imageUrl: null, active: true, stockTotal: null, stockRemaining: null,
          perUserLimit: null, dailyGlobalLimit: null,
        }];
      }
      return [];
    },
  };

  async query(sql: string, parameters?: unknown[]) {
    this.queries.push({ sql, parameters });
    if (sql.includes('"cost_ert"::text AS "costErtExact"')) {
      return [{ id: configurationId, status: this.configurationStatus, costErtExact: '5', dailyUserAttemptLimit: 5 }];
    }
    if (sql.includes('mapping."reward_snapshot" AS "snapshot"')) {
      return [{
        rewardId, segmentIndex: 0, weight: 1,
        snapshot: { rewardId, type: 'ERT', amountExact: '10' },
        liveId: rewardId, liveType: 'ERT', liveActive: true, liveAmount: '10', liveAmountExact: null,
        stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
      }];
    }
    if (sql.includes('INSERT INTO "rewards"')) return [{ id: rewardId, code: 'ert-10', type: 'ERT' }];
    if (sql.includes('INSERT INTO "raffle_configurations"')) {
      return [{ id: configurationId, status: 'DRAFT', costErtExact: '7.5', dailyUserAttemptLimit: 3 }];
    }
    if (sql.includes('UPDATE "raffle_configurations"')) {
      return this.configurationStatus === 'DRAFT'
        ? [{ id: configurationId, status: 'DRAFT', title: 'Updated' }]
        : [];
    }
    if (sql.includes('SELECT "status"')) return [{ status: this.configurationStatus }];
    return [];
  }

  async transaction<T>(operation: (manager: typeof this.manager) => Promise<T>) {
    return operation(this.manager);
  }
}

class ActivationDataSource {
  queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  activeId: string | null = activeConfigurationId;
  replay: Record<string, unknown> | null = null;
  requestFingerprint: string | null = null;
  manager = {
    query: async (sql: string, parameters?: unknown[]) => {
      this.queries.push({ sql, parameters });
      if (sql.includes('FROM "raffle_machines"')) return [{ id: machineId }];
      if (sql.includes('FROM "raffle_configuration_activation_operations"')) {
        return this.replay ? [{ requestFingerprint: this.requestFingerprint, status: 'COMPLETED', responseSnapshot: this.replay }] : [];
      }
      if (sql.includes('"status" = \'ACTIVE\'') && sql.includes('SELECT "id"')) {
        return this.activeId ? [{ id: this.activeId }] : [];
      }
      if (sql.includes('"cost_ert"::text AS "costErtExact"')) {
        return [{ id: configurationId, status: 'DRAFT', costErtExact: '5', dailyUserAttemptLimit: 5 }];
      }
      if (sql.includes('mapping."reward_snapshot" AS "snapshot"')) {
        return [{
          rewardId, segmentIndex: 0, weight: 1,
          snapshot: { rewardId, type: 'ERT', amountExact: '10' },
          liveId: rewardId, liveType: 'ERT', liveActive: true, liveAmount: '10', liveAmountExact: null,
          stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
        }];
      }
      if (sql.includes('INSERT INTO "raffle_configuration_activation_operations"')) {
        this.requestFingerprint = String(parameters?.[6]);
        return [{ id: operationId }];
      }
      if (sql.includes('SET "status" = \'DISABLED\'')) return [[{ disabledAt: new Date('2026-09-02T10:00:00Z') }], 1];
      if (sql.includes('SET "status" = \'ACTIVE\'')) return [[{ activatedAt: new Date('2026-09-02T10:00:01Z') }], 1];
      if (sql.includes('SET "status" = \'COMPLETED\'')) {
        this.replay = JSON.parse(String(parameters?.[1]));
        return [[{ id: operationId }], 1];
      }
      return [];
    },
  };
  transaction<T>(operation: (manager: typeof this.manager) => Promise<T>) { return operation(this.manager); }
}

class AvailabilityDataSource {
  available = true;
  fingerprint: string | null = null;
  snapshot: Record<string, unknown> | null = null;
  writes = 0;
  manager = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('FROM "raffle_machines"')) return [{ id: machineId, available: this.available, pausedAt: null }];
    if (sql.includes('FROM "raffle_machine_availability_operations"')) {
      return this.snapshot ? [{ requestFingerprint: this.fingerprint, responseSnapshot: this.snapshot }] : [];
    }
    if (sql.includes('UPDATE "raffle_machines"')) {
      this.writes += 1;
      this.available = Boolean(parameters?.[1]);
      return [[{ available: this.available, pausedAt: this.available ? null : new Date('2026-09-02T12:00:00Z') }], 1];
    }
    if (sql.includes('INSERT INTO "raffle_machine_availability_operations"')) {
      this.fingerprint = String(parameters?.[8]);
      this.snapshot = JSON.parse(String(parameters?.[9]));
      return [{ id: parameters?.[0] }];
    }
    return [];
  }};
  transaction<T>(operation: (manager: typeof this.manager) => Promise<T>) { return operation(this.manager); }
}

describe('AdminRaffleV2Service', () => {
  it('returns immutable versions with exact economy and derived integer probabilities', async () => {
    const dataSource = new FakeDataSource();
    const result = await new AdminRaffleV2Service(dataSource as never).overview() as any;

    assert.equal(result.machine.id, machineId);
    assert.equal(result.machine.available, true);
    assert.deepEqual(result.configurations[0].cost, {
      currency: 'ERT', amountExact: '7.5', amountDisplay: '7.50',
    });
    assert.equal(result.configurations[0].dailyUserAttemptLimit, 3);
    assert.equal(result.configurations[0].totalWeight, '7');
    assert.deepEqual(result.configurations[0].rewards[0].probability, { numerator: '7', denominator: '7' });
    assert.deepEqual(dataSource.calls[1].parameters, [[configurationId]]);
  });

  it('returns v2 operation/result evidence and validates pagination', async () => {
    const service = new AdminRaffleV2Service(new FakeDataSource() as never);
    const result = await service.draws({ limit: 25, offset: 5 }) as any;

    assert.equal(result.items[0].ticket, '3');
    assert.equal(result.items[0].totalWeight, '7');
    assert.equal(result.items[0].costErtExact, '7.5');
    assert.equal(result.items[0].costErtDisplay, '7.50');
    await assert.rejects(() => service.draws({ limit: 101, offset: 0 }), BadRequestException);
  });

  it('creates only typed supported catalog rewards and complete drafts', async () => {
    const dataSource = new DraftDataSource();
    const service = new AdminRaffleV2Service(dataSource as never);
    const reward = await service.createReward({
      code: 'ert-10', title: '10 ERT', type: 'ERT', amountExact: '10',
    }) as any;
    const draft = await service.createDraft(machineId, {
      title: 'Config B', costErtExact: '7.500000000000000000', dailyUserAttemptLimit: 3,
    }) as any;

    assert.equal(reward.id, rewardId);
    assert.equal(draft.id, configurationId);
    const rewardInsert = dataSource.queries.find((call) => call.sql.includes('INSERT INTO "rewards"'));
    assert.deepEqual(rewardInsert?.parameters?.slice(0, 6), ['ert-10', '10 ERT', null, 'ERT', '10', null]);
    await service.createReward({
      code: 'eru-fractional', title: 'Fractional ERU', type: 'ERU', amountExact: '1.235000000000000000',
    });
    const eruInsert = dataSource.queries.filter((call) => call.sql.includes('INSERT INTO "rewards"')).at(-1);
    assert.deepEqual(eruInsert?.parameters?.slice(0, 6), [
      'eru-fractional', 'Fractional ERU', null, 'ERU', null, '1.235',
    ]);
    await assert.rejects(() => service.createReward({
      code: 'eru-invalid', title: 'Invalid ERU', type: 'ERU', amountExact: '1.1234567890123456789',
    }), BadRequestException);
    await assert.rejects(() => service.createReward({
      code: 'badge', title: 'Badge', type: 'BADGE', amountExact: '1',
    }), BadRequestException);
  });

  it('updates only drafts and atomically replaces ordered outcomes with backend snapshots', async () => {
    const dataSource = new DraftDataSource();
    const service = new AdminRaffleV2Service(dataSource as never);
    const updated = await service.updateDraft(configurationId, { title: 'Updated' }) as any;
    const replaced = await service.replaceDraftRewards(configurationId, {
      rewards: [{ rewardId, weight: 7 }],
    }) as any;

    assert.equal(updated.status, 'DRAFT');
    assert.deepEqual(replaced.rewards[0], {
      rewardId, segmentIndex: 0, weight: '7', probability: { numerator: '7', denominator: '7' },
    });
    const insert = dataSource.queries.find((call) => call.sql.includes('INSERT INTO "raffle_configuration_rewards"'));
    const snapshot = JSON.parse(String(insert?.parameters?.[4]));
    assert.equal(snapshot.amountExact, '10');
    assert.equal(snapshot.amountDisplay, '10.00');
    assert.deepEqual(snapshot.probability, { numerator: '7', denominator: '7' });

    dataSource.configurationStatus = 'ACTIVE';
    await assert.rejects(
      () => service.replaceDraftRewards(configurationId, { rewards: [{ rewardId, weight: 1 }] }),
      ConflictException,
    );
  });

  it('previews a draft through canonical runtime validation and exact economics', async () => {
    const service = new AdminRaffleV2Service(new DraftDataSource() as never);
    const preview = await service.previewDraft(configurationId) as any;

    assert.equal(preview.valid, true);
    assert.equal(preview.totalWeight, '1');
    assert.equal(preview.economy.expectedPerDraw.ertExact, '10');
    assert.equal(preview.issues[0].code, 'ERT_EXPECTED_RETURN_NOT_BELOW_COST');
  });

  it('atomically switches the expected active version and persists immutable activation evidence', async () => {
    const dataSource = new ActivationDataSource();
    const service = new AdminRaffleV2Service(dataSource as never);
    const result = await service.activateDraft(adminId, configurationId, {
      expectedActiveConfigurationVersion: activeConfigurationId,
      reason: 'Approved economy update',
      idempotencyKey,
    }) as any;

    assert.equal(result.activeConfigurationVersion, configurationId);
    assert.equal(result.previousActiveConfigurationVersion, activeConfigurationId);
    assert.equal(result.validation.valid, true);
    const statements = dataSource.queries.map((query) => query.sql);
    assert.ok(statements.findIndex((sql) => sql.includes('FROM "raffle_machines"'))
      < statements.findIndex((sql) => sql.includes('SET "status" = \'DISABLED\'')));
    assert.ok(statements.findIndex((sql) => sql.includes('SET "status" = \'DISABLED\''))
      < statements.findIndex((sql) => sql.includes('SET "status" = \'ACTIVE\'')));
    assert.ok(statements.findIndex((sql) => sql.includes('SET "status" = \'ACTIVE\''))
      < statements.findIndex((sql) => sql.includes('SET "status" = \'COMPLETED\'')));

    const replay = await service.activateDraft(adminId, configurationId, {
      expectedActiveConfigurationVersion: activeConfigurationId,
      reason: 'Approved economy update',
      idempotencyKey,
    }) as any;
    assert.equal(replay.replay, true);
    assert.equal(dataSource.queries.filter((query) => query.sql.includes('SET "status" = \'ACTIVE\'')).length, 1);
  });

  it('rejects a stale expected active version before claiming an operation', async () => {
    const dataSource = new ActivationDataSource();
    const service = new AdminRaffleV2Service(dataSource as never);
    await assert.rejects(() => service.activateDraft(adminId, configurationId, {
      expectedActiveConfigurationVersion: null,
      reason: 'Stale request',
      idempotencyKey,
    }), ConflictException);
    assert.equal(dataSource.queries.some((query) => query.sql.includes('INSERT INTO "raffle_configuration_activation_operations"')), false);
  });

  it('pauses idempotently without changing configuration evidence', async () => {
    const dataSource = new AvailabilityDataSource();
    const service = new AdminRaffleV2Service(dataSource as never);
    const input = { expectedAvailable: true, reason: 'Maintenance', idempotencyKey };
    const paused = await service.setAvailability(adminId, 'PAUSE', input) as any;
    const replay = await service.setAvailability(adminId, 'PAUSE', input) as any;
    assert.equal(paused.available, false);
    assert.equal(replay.replay, true);
    assert.equal(dataSource.writes, 1);
  });
});
