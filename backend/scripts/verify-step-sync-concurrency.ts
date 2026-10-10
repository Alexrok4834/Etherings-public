import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerTransaction } from '../src/balance/ledger-transaction.entity';
import { LedgerMutationInput, LedgerService } from '../src/balance/ledger.service';
import { StepSyncBatch, StepSyncBatchSource } from '../src/step-sync/step-sync-batch.entity';
import { StepSyncInstallation } from '../src/step-sync/step-sync-installation.entity';
import {
  ReceiveStepSyncBatchInput,
  StepSyncConflictCode,
  StepSyncResultCode,
  StepSyncService,
} from '../src/step-sync/step-sync.service';
import { DailyUserStats } from '../src/walk/daily-user-stats.entity';
import { WalkSession, WalkSessionSource, WalkSessionStatus } from '../src/walk/walk-session.entity';
import { WalkService } from '../src/walk/walk.service';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [
    User,
    Balance,
    LedgerTransaction,
    DailyUserStats,
    WalkSession,
    StepSyncInstallation,
    StepSyncBatch,
  ],
});

const testUserId = '90000000-0000-4000-8000-000000000001';
const rollbackUserId = '90000000-0000-4000-8000-000000000013';
const crossPathUserId = '90000000-0000-4000-8000-000000000015';
const timeoutUserId = '90000000-0000-4000-8000-000000000018';
const installationId = '90000000-0000-4000-8000-000000000002';

function inactiveM2eDependencies() {
  return [
    { isEarningEnabledForUser: () => false },
    { getOrCreateInTransaction: () => { throw new Error('Inactive M2E snapshot path was called'); } },
    { settleInTransaction: () => { throw new Error('Inactive M2E settlement path was called'); } },
  ] as const;
}

function batch(
  batchId: string,
  sequence: number,
  overrides: Partial<ReceiveStepSyncBatchInput> = {},
): ReceiveStepSyncBatchInput {
  const startedAt = new Date('2026-08-11T08:00:00.000Z');
  startedAt.setUTCMinutes(startedAt.getUTCMinutes() + (sequence - 1) * 15);
  const endedAt = new Date(startedAt.getTime() + 15 * 60 * 1000);
  return {
    installationId,
    batchId,
    sequence,
    localDate: '2026-08-11',
    timezoneOffsetMinutes: 180,
    observedStartedAt: startedAt.toISOString(),
    observedEndedAt: endedAt.toISOString(),
    stepDelta: 69,
    sensorEventCount: 5,
    source: StepSyncBatchSource.AndroidStepCounter,
    algorithmVersion: 'concurrency-qa-v1',
    clientMetadata: { test: 'disposable-postgres' },
    ...overrides,
  };
}

function rejectionCode(result: PromiseSettledResult<unknown>) {
  if (result.status !== 'rejected') return null;
  const response = result.reason?.getResponse?.();
  return response && typeof response === 'object' ? response.code : null;
}

async function main() {
  await dataSource.initialize();
  const users = dataSource.getRepository(User);
  await users.delete({ telegramId: 'step-sync-concurrency-qa' });
  await users.delete({ telegramId: 'step-sync-rollback-qa' });
  await users.delete({ telegramId: 'step-sync-cross-path-qa' });
  await users.delete({ telegramId: 'step-sync-timeout-qa' });
  const user = await users.save(users.create({
    id: testUserId,
    telegramId: 'step-sync-concurrency-qa',
    username: 'step_sync_qa',
    firstName: 'Step Sync',
    lastName: 'QA',
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: null,
  }));

  try {
    const service = new StepSyncService(
      dataSource,
      {
        getLimits: () => ({
          dailyStepLimitBase: 5000,
          ertPer1000Steps: 10,
          minSessionSeconds: 30,
          maxAcceptedSpeedMps: 3.5,
          maxSessionDurationSeconds: 604800,
        }),
      } as never,
      new LedgerService(dataSource),
      {
        getPolicy: () => ({ retentionSeconds: 604800, maxFutureSkewSeconds: 600 }),
        now: () => new Date('2026-08-11T18:00:00.000Z'),
      } as never,
      ...inactiveM2eDependencies(),
    );
    const timeoutUser = await users.save(users.create({
      id: timeoutUserId,
      telegramId: 'step-sync-timeout-qa',
      username: 'step_sync_timeout_qa',
      firstName: 'Timeout',
      lastName: 'QA',
      photoUrl: null,
      isAdmin: false,
      lastLoginAt: null,
    }));
    const timeoutInput = batch('90000000-0000-4000-8000-000000000020', 1, {
      installationId: '90000000-0000-4000-8000-000000000019',
      stepDelta: 100,
    });
    const committedBeforeResponseLoss = await service.receiveBatch(timeoutUser, timeoutInput);
    const timeoutRetry = await service.receiveBatch(timeoutUser, timeoutInput);
    assert.deepEqual(timeoutRetry, committedBeforeResponseLoss);
    const timeoutStats = await dataSource.getRepository(DailyUserStats).findOneByOrFail({
      userId: timeoutUser.id,
      date: '2026-08-11',
    });
    const timeoutBalance = await dataSource.getRepository(Balance).findOneByOrFail({ userId: timeoutUser.id });
    const timeoutLedger = await dataSource.getRepository(LedgerTransaction).findBy({ userId: timeoutUser.id });
    assert.equal(timeoutStats.acceptedSteps, 100);
    assert.equal(timeoutStats.earnedErt, 1);
    assert.equal(timeoutBalance.ertBalance, 1);
    assert.equal(timeoutLedger.length, 1);
    assert.equal(await dataSource.getRepository(StepSyncBatch).countBy({ userId: timeoutUser.id }), 1);
    const sameBatch = batch('90000000-0000-4000-8000-000000000003', 1);
    const duplicateResponses = await Promise.all(
      Array.from({ length: 20 }, () => service.receiveBatch(user, sameBatch)),
    );
    for (const response of duplicateResponses) {
      assert.deepEqual(response, duplicateResponses[0]);
    }

    const installations = dataSource.getRepository(StepSyncInstallation);
    const batches = dataSource.getRepository(StepSyncBatch);
    const installation = await installations.findOneByOrFail({ userId: user.id, installationId });
    assert.equal(await installations.countBy({ userId: user.id, installationId }), 1);
    assert.equal(await batches.countBy({ installationRecordId: installation.id, sequence: '1' }), 1);

    const sequenceRace = await Promise.allSettled([
      service.receiveBatch(user, batch('90000000-0000-4000-8000-000000000004', 2)),
      service.receiveBatch(user, batch('90000000-0000-4000-8000-000000000005', 2)),
    ]);
    assert.equal(sequenceRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(sequenceRace.map(rejectionCode).filter(Boolean), [StepSyncConflictCode.SequenceConflict]);
    assert.equal(await batches.countBy({ installationRecordId: installation.id, sequence: '2' }), 1);

    const identityRace = await Promise.allSettled([
      service.receiveBatch(user, batch('90000000-0000-4000-8000-000000000006', 3, { stepDelta: 100 })),
      service.receiveBatch(user, batch('90000000-0000-4000-8000-000000000006', 3, { stepDelta: 101 })),
    ]);
    assert.equal(identityRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(identityRace.map(rejectionCode).filter(Boolean), [StepSyncConflictCode.IdempotencyConflict]);
    assert.equal(await batches.countBy({ installationRecordId: installation.id, sequence: '3' }), 1);

    const partial = await service.receiveBatch(
      user,
      batch('90000000-0000-4000-8000-000000000007', 4, { stepDelta: 5000 }),
    );
    assert.equal(partial.resultCode, StepSyncResultCode.PartiallyAccepted);

    const capped = await service.receiveBatch(
      user,
      batch('90000000-0000-4000-8000-000000000008', 5, { stepDelta: 100 }),
    );
    assert.equal(capped.resultCode, StepSyncResultCode.DailyCapReached);

    const overlapping = await service.receiveBatch(
      user,
      batch('90000000-0000-4000-8000-000000000009', 6, {
        observedStartedAt: '2026-08-11T08:00:00.000Z',
        observedEndedAt: '2026-08-11T08:15:00.000Z',
      }),
    );
    assert.equal(overlapping.resultCode, StepSyncResultCode.OverlappingInterval);

    const outOfOrder = await service.receiveBatch(
      user,
      batch('90000000-0000-4000-8000-000000000010', 0),
    );
    assert.equal(outOfOrder.resultCode, StepSyncResultCode.SequenceOutOfOrder);

    const crossInstallationOverlap = await service.receiveBatch(
      user,
      batch('90000000-0000-4000-8000-000000000011', 1, {
        installationId: '90000000-0000-4000-8000-000000000012',
        observedStartedAt: '2026-08-11T08:00:00.000Z',
        observedEndedAt: '2026-08-11T08:15:00.000Z',
      }),
    );
    assert.equal(crossInstallationOverlap.resultCode, StepSyncResultCode.OverlappingInterval);

    const stats = await dataSource.getRepository(DailyUserStats).findOneByOrFail({
      userId: user.id,
      date: '2026-08-11',
    });
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ userId: user.id });
    const ledger = await dataSource.getRepository(LedgerTransaction).findBy({ userId: user.id });
    assert.equal(stats.acceptedSteps, 5000);
    assert.equal(stats.earnedErt, 50);
    assert.equal(balance.ertBalance, 50);
    assert.equal(balance.lifetimeEarnedErt, 50);
    assert.equal(ledger.length, 3);
    assert.equal(ledger.reduce((sum, transaction) => sum + transaction.amount, 0), 50);
    assert.equal(await batches.countBy({ userId: user.id }), 8);

    const rollbackUser = await users.save(users.create({
      id: rollbackUserId,
      telegramId: 'step-sync-rollback-qa',
      username: 'step_sync_rollback_qa',
      firstName: 'Rollback',
      lastName: 'QA',
      photoUrl: null,
      isAdmin: false,
      lastLoginAt: null,
    }));
    const realLedgerService = new LedgerService(dataSource);
    const rollbackService = new StepSyncService(
      dataSource,
      {
        getLimits: () => ({
          dailyStepLimitBase: 5000,
          ertPer1000Steps: 10,
          minSessionSeconds: 30,
          maxAcceptedSpeedMps: 3.5,
          maxSessionDurationSeconds: 604800,
        }),
      } as never,
      {
        creditInTransaction: async (manager: EntityManager, mutation: LedgerMutationInput) => {
          await realLedgerService.creditInTransaction(manager, mutation);
          throw new Error('INJECTED_AFTER_LEDGER_WRITE');
        },
      } as never,
      {
        getPolicy: () => ({ retentionSeconds: 604800, maxFutureSkewSeconds: 600 }),
        now: () => new Date('2026-08-11T18:00:00.000Z'),
      } as never,
      ...inactiveM2eDependencies(),
    );
    await assert.rejects(
      () => rollbackService.receiveBatch(
        rollbackUser,
        batch('90000000-0000-4000-8000-000000000014', 1, { stepDelta: 100 }),
      ),
      /INJECTED_AFTER_LEDGER_WRITE/,
    );
    assert.equal(await installations.countBy({ userId: rollbackUser.id }), 0);
    assert.equal(await batches.countBy({ userId: rollbackUser.id }), 0);
    assert.equal(await dataSource.getRepository(DailyUserStats).countBy({ userId: rollbackUser.id }), 0);
    assert.equal(await dataSource.getRepository(Balance).countBy({ userId: rollbackUser.id }), 0);
    assert.equal(await dataSource.getRepository(LedgerTransaction).countBy({ userId: rollbackUser.id }), 0);

    const crossPathUser = await users.save(users.create({
      id: crossPathUserId,
      telegramId: 'step-sync-cross-path-qa',
      username: 'step_sync_cross_path_qa',
      firstName: 'Cross Path',
      lastName: 'QA',
      photoUrl: null,
      isAdmin: false,
      lastLoginAt: null,
    }));
    await dataSource.getRepository(DailyUserStats).save({
      userId: crossPathUser.id,
      date: '2026-08-11',
      acceptedSteps: 4900,
      earnedErt: 49,
      raffleAttempts: 0,
    });
    await dataSource.getRepository(Balance).save({
      userId: crossPathUser.id,
      ertBalance: 49,
      lifetimeEarnedErt: 49,
      lifetimeSpentErt: 0,
    });
    const limits = {
      dailyStepLimitBase: 5000,
      ertPer1000Steps: 10,
      minSessionSeconds: 30,
      maxAcceptedSpeedMps: 3.5,
      maxSessionDurationSeconds: 604800,
    };
    const crossPathLedger = new LedgerService(dataSource);
    const walkService = new WalkService(
      dataSource.getRepository(WalkSession),
      { getLimits: () => limits } as never,
      dataSource,
      crossPathLedger,
    );
    const crossPathStepSync = new StepSyncService(
      dataSource,
      { getLimits: () => limits } as never,
      crossPathLedger,
      {
        getPolicy: () => ({ retentionSeconds: 604800, maxFutureSkewSeconds: 600 }),
        now: () => new Date('2026-08-11T18:00:00.000Z'),
      } as never,
      ...inactiveM2eDependencies(),
    );
    assert.throws(
      () => walkService.startSession(crossPathUser, { source: WalkSessionSource.AndroidStepCounter }),
      (error: unknown) => (error as { getStatus?: () => number }).getStatus?.() === 410,
    );
    const walkSessions = dataSource.getRepository(WalkSession);
    const unfinishedLegacySession = await walkSessions.save(walkSessions.create({
      userId: crossPathUser.id,
      status: WalkSessionStatus.Started,
      startedAt: new Date('2026-08-11T10:00:00.000Z'),
      endedAt: null,
      clientStepCount: null,
      acceptedStepCount: null,
      durationSeconds: null,
      distanceMeters: null,
      avgSpeedMps: null,
      source: WalkSessionSource.AndroidStepCounter,
      rejectionReason: null,
      rawSummary: null,
      earnedErt: 0,
    }));
    const retiredFinish = await walkService.finishSession(crossPathUser, unfinishedLegacySession.id, {
      clientStepCount: 100,
      startedAt: '2026-08-11T10:00:00.000Z',
      endedAt: '2026-08-11T10:15:00.000Z',
      durationSeconds: 900,
      distanceMeters: null,
      samplesCount: 5,
      algorithmVersion: 'cross-path-qa-v1',
    });
    assert.equal(retiredFinish.status, 'REJECTED');
    assert.equal(retiredFinish.earnedErt, 0);

    await walkSessions.save(walkSessions.create({
      userId: crossPathUser.id,
      status: WalkSessionStatus.Accepted,
      startedAt: new Date('2026-08-11T08:00:00.000Z'),
      endedAt: new Date('2026-08-11T08:15:00.000Z'),
      clientStepCount: 100,
      acceptedStepCount: 100,
      durationSeconds: 900,
      distanceMeters: null,
      avgSpeedMps: null,
      source: WalkSessionSource.AndroidStepCounter,
      rejectionReason: null,
      rawSummary: { historical: true },
      earnedErt: 1,
    }));
    const stepResult = await crossPathStepSync.receiveBatch(
      crossPathUser,
      batch('90000000-0000-4000-8000-000000000016', 1, {
        installationId: '90000000-0000-4000-8000-000000000017',
        stepDelta: 100,
      }),
    );
    const crossPathStats = await dataSource.getRepository(DailyUserStats).findOneByOrFail({
      userId: crossPathUser.id,
      date: '2026-08-11',
    });
    const crossPathBalance = await dataSource.getRepository(Balance).findOneByOrFail({ userId: crossPathUser.id });
    const crossPathLedgerRows = await dataSource.getRepository(LedgerTransaction).findBy({ userId: crossPathUser.id });
    assert.equal(stepResult.resultCode, StepSyncResultCode.OverlappingInterval);
    assert.equal(stepResult.acceptedStepDelta, 0);
    assert.equal(stepResult.earnedErtDelta, 0);
    assert.equal(crossPathStats.acceptedSteps, 4900);
    assert.equal(crossPathStats.earnedErt, 49);
    assert.equal(crossPathBalance.ertBalance, 49);
    assert.equal(crossPathLedgerRows.length, 0);

    console.log(JSON.stringify({
      identicalConcurrentRequests: duplicateResponses.length,
      timeoutAfterCommitStableRetry: true,
      timeoutAfterCommitLedgerTransactions: timeoutLedger.length,
      installations: await installations.countBy({ userId: user.id }),
      storedBatches: 8,
      acceptedSteps: stats.acceptedSteps,
      earnedErt: stats.earnedErt,
      balance: balance.ertBalance,
      ledgerTransactions: ledger.length,
      partialResult: partial.resultCode,
      cappedResult: capped.resultCode,
      overlappingResult: overlapping.resultCode,
      outOfOrderResult: outOfOrder.resultCode,
      crossInstallationOverlapResult: crossInstallationOverlap.resultCode,
      rollbackAfterLedgerWrite: 'clean',
      legacyAndroidStart: 'retired',
      legacyAndroidFinish: 'terminally_rejected',
      legacyWalkOverlap: stepResult.resultCode,
      sequenceConflict: StepSyncConflictCode.SequenceConflict,
      idempotencyConflict: StepSyncConflictCode.IdempotencyConflict,
    }));
  } finally {
    await users.delete({ id: testUserId });
    await users.delete({ id: rollbackUserId });
    await users.delete({ id: crossPathUserId });
    await users.delete({ id: timeoutUserId });
    await dataSource.destroy();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
