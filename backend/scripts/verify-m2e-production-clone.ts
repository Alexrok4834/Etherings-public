import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { LedgerTransaction } from '../src/balance/ledger-transaction.entity';
import { M2eBalanceConfigService } from '../src/m2e/m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from '../src/m2e/m2e-daily-economic-snapshot.entity';
import { M2eDailySnapshotService } from '../src/m2e/m2e-daily-snapshot.service';
import { M2E_RING_SELECTION_UNAVAILABLE } from '../src/m2e/m2e-daily-snapshot.errors';
import { M2eEarningCalculator } from '../src/m2e/m2e-earning-calculator';
import { M2eSettlementService } from '../src/m2e/m2e-settlement.service';
import { CopperRingEntitlementService } from '../src/ring/copper-ring-entitlement.service';
import { EquippedRing } from '../src/ring/equipped-ring.entity';
import { GameRing } from '../src/ring/game-ring.entity';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { StepSyncBatch, StepSyncBatchSource } from '../src/step-sync/step-sync-batch.entity';
import { StepSyncInstallation } from '../src/step-sync/step-sync-installation.entity';
import {
  StepSyncConflictCode,
  StepSyncResultCode,
  StepSyncService,
} from '../src/step-sync/step-sync.service';
import { DailyUserStats } from '../src/walk/daily-user-stats.entity';
import { WalkSession } from '../src/walk/walk-session.entity';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^etherings_m2e_clone_[a-z0-9_]+_qa$/.test(databaseName)) {
  throw new Error('Refusing to run outside an approved M2E QA clone');
}

const accountingDate = '2099-01-10';
const now = new Date('2099-01-10T18:00:00.000Z');
const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [
    User,
    Balance,
    LedgerTransaction,
    GameRing,
    EquippedRing,
    M2eDailyEconomicSnapshot,
    StepSyncInstallation,
    StepSyncBatch,
    DailyUserStats,
    WalkSession,
  ],
});

type Fixture = { user: User; ringId: string };

async function main() {
  await dataSource.initialize();
  try {
    const single = await seedFixture('single');
    const partitioned = await seedFixture('partitioned');
    const rollback = await seedFixture('rollback');
    const service = activeService();

    const singleInput = batchInput(randomUUID(), randomUUID(), 1, 5000, 8, 0);
    const singleResult = await service.receiveBatch(single.user, singleInput);
    const retryResult = await service.receiveBatch(single.user, singleInput);
    assert.equal(JSON.stringify(retryResult), JSON.stringify(singleResult));
    assert.equal(singleResult.earnedErtDeltaExact, '6.5325');
    assert.equal(singleResult.dailyStepCap, 5000);

    const capResult = await service.receiveBatch(
      single.user,
      batchInput(singleInput.installationId, randomUUID(), 2, 100, 9, 0),
    );
    assert.equal(capResult.resultCode, StepSyncResultCode.DailyCapReached);
    assert.equal(capResult.earnedErtDeltaExact, '0');

    const installationId = randomUUID();
    for (const [index, steps] of [1000, 1500, 2500].entries()) {
      await service.receiveBatch(
        partitioned.user,
        batchInput(installationId, randomUUID(), index + 1, steps, 8 + index, index * 20),
      );
    }

    const singleEvidence = await evidence(single.user.id);
    const partitionedEvidence = await evidence(partitioned.user.id);
    assert.equal(singleEvidence.balance, '6.532500000000000000');
    assert.equal(partitionedEvidence.balance, singleEvidence.balance);
    assert.equal(singleEvidence.dailyEarned, singleEvidence.balance);
    assert.equal(partitionedEvidence.dailyEarned, partitionedEvidence.balance);
    assert.equal(singleEvidence.batchDelta, singleEvidence.balance);
    assert.equal(partitionedEvidence.batchDelta, partitionedEvidence.balance);
    assert.equal(singleEvidence.ledgerAmount, singleEvidence.balance);
    assert.equal(partitionedEvidence.ledgerAmount, partitionedEvidence.balance);
    assert.equal(singleEvidence.ledgerCount, 1);
    assert.equal(partitionedEvidence.ledgerCount, 3);
    assert.equal(singleEvidence.snapshotCount, 1);
    assert.equal(partitionedEvidence.snapshotCount, 1);

    const realSettlement = activeSettlement();
    const rollbackService = activeService({
      async settleInTransaction(manager: EntityManager, input: Parameters<M2eSettlementService['settleInTransaction']>[1]) {
        await realSettlement.settleInTransaction(manager, input);
        throw new Error('INJECTED_AFTER_M2E_SETTLEMENT');
      },
    } as M2eSettlementService);
    await assert.rejects(
      () => rollbackService.receiveBatch(
        rollback.user,
        batchInput(randomUUID(), randomUUID(), 1, 100, 8, 0),
      ),
      /INJECTED_AFTER_M2E_SETTLEMENT/,
    );
    const rollbackEvidence = await evidence(rollback.user.id);
    assert.deepEqual(rollbackEvidence, {
      balance: '0.000000000000000000',
      dailyEarned: '0',
      batchDelta: '0',
      ledgerAmount: '0',
      ledgerCount: 0,
      snapshotCount: 0,
      installationCount: 0,
      batchCount: 0,
      dailyCount: 0,
    });

    const rollover = await seedFixture('rollover');
    const rolloverService = activeService(activeSettlement(), new Date('2099-01-10T22:00:00.000Z'));
    const rolloverInstallation = randomUUID();
    const firstDay = await rolloverService.receiveBatch(rollover.user, batchInputAt({
      installationId: rolloverInstallation,
      batchId: randomUUID(),
      sequence: 1,
      localDate: '2099-01-10',
      timezoneOffsetMinutes: 180,
      observedStartedAt: '2099-01-10T20:40:00.000Z',
      observedEndedAt: '2099-01-10T20:50:00.000Z',
      stepDelta: 1000,
    }));
    assert.equal(firstDay.earnedErtDeltaExact, '1.3065');
    await dataSource.query('UPDATE game_rings SET comfort = 40, updated_at = now() WHERE id = $1', [rollover.ringId]);
    const secondDay = await rolloverService.receiveBatch(rollover.user, batchInputAt({
      installationId: rolloverInstallation,
      batchId: randomUUID(),
      sequence: 2,
      localDate: '2099-01-11',
      timezoneOffsetMinutes: 180,
      observedStartedAt: '2099-01-10T21:10:00.000Z',
      observedEndedAt: '2099-01-10T21:20:00.000Z',
      stepDelta: 1000,
    }));
    assert.equal(secondDay.earnedErtDeltaExact, '1.451666666666666667');
    const rolloverRows = await dataSource.query(`
      SELECT id, accounting_date::text AS date, selected_ring_comfort AS comfort,
        step_cap AS "stepCap"
      FROM m2e_daily_economic_snapshots
      WHERE user_id = $1 ORDER BY accounting_date
    `, [rollover.user.id]);
    assert.deepEqual(rolloverRows.map((row: Record<string, unknown>) => ({
      date: row.date,
      comfort: row.comfort,
      stepCap: row.stepCap,
    })), [
      { date: '2099-01-10', comfort: 20, stepCap: 5000 },
      { date: '2099-01-11', comfort: 40, stepCap: 5000 },
    ]);
    await assert.rejects(
      () => dataSource.query(
        'UPDATE m2e_daily_economic_snapshots SET selected_ring_comfort = 99 WHERE id = $1',
        [rolloverRows[0].id],
      ),
      (error) => pgCode(error) === '23514',
    );
    const rolloverReconciliation = await reconcileOwner(rollover.user.id);
    assert.deepEqual(rolloverReconciliation, {
      balance: '2.758166666666666667',
      dailyEarned: '2.758166666666666667',
      batchDelta: '2.758166666666666667',
      ledgerAmount: '2.758166666666666667',
      snapshotCount: 2,
    });

    const concurrent = await seedFixture('concurrent-snapshot');
    const snapshots = activeSnapshotService();
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      dataSource.transaction((manager) => snapshots.getOrCreateInTransaction(
        manager,
        concurrent.user.id,
        '2099-01-12',
      )),
      dataSource.transaction((manager) => snapshots.getOrCreateInTransaction(
        manager,
        concurrent.user.id,
        '2099-01-12',
      )),
    ]);
    assert.equal(concurrentFirst.id, concurrentSecond.id);
    const [{ count: concurrentSnapshotCount }] = await dataSource.query(`
      SELECT count(*)::integer AS count FROM m2e_daily_economic_snapshots
      WHERE user_id = $1 AND accounting_date = '2099-01-12'
    `, [concurrent.user.id]);
    assert.equal(concurrentSnapshotCount, 1);

    const invalidSelection = await seedFixture('invalid-selection');
    const otherOwner = await seedFixture('other-owner');
    await dataSource.query(
      'DELETE FROM equipped_rings WHERE user_id IN ($1, $2)',
      [invalidSelection.user.id, otherOwner.user.id],
    );
    await assert.rejects(
      () => dataSource.query(
        'INSERT INTO equipped_rings (user_id, ring_id, equipped_at, updated_at) VALUES ($1, $2, now(), now())',
        [invalidSelection.user.id, otherOwner.ringId],
      ),
      (error) => pgCode(error) === '23503',
    );
    await assert.rejects(
      () => activeService().receiveBatch(
        invalidSelection.user,
        batchInput(randomUUID(), randomUUID(), 1, 100, 8, 0),
      ),
      (error) => conflictCode(error) === M2E_RING_SELECTION_UNAVAILABLE,
    );
    const invalidEvidence = await evidence(invalidSelection.user.id);
    assert.equal(invalidEvidence.installationCount, 0);
    assert.equal(invalidEvidence.batchCount, 0);
    assert.equal(invalidEvidence.dailyCount, 0);
    assert.equal(invalidEvidence.snapshotCount, 0);
    assert.equal(invalidEvidence.ledgerCount, 0);

    const legacy = await seedFixture('legacy-conflict');
    await dataSource.query(`
      INSERT INTO daily_user_stats (
        user_id, date, accepted_steps, earned_ert, raffle_attempts, created_at, updated_at
      ) VALUES ($1, $2, 100, 1, 0, now(), now())
    `, [legacy.user.id, accountingDate]);
    await dataSource.query(`
      UPDATE balances SET ert_balance = 1, lifetime_earned_ert = 1, updated_at = now()
      WHERE user_id = $1
    `, [legacy.user.id]);
    await assert.rejects(
      () => activeService().receiveBatch(
        legacy.user,
        batchInput(randomUUID(), randomUUID(), 1, 100, 8, 0),
      ),
      (error) => conflictCode(error) === StepSyncConflictCode.M2eActivationDateConflict,
    );
    const legacyEvidence = await evidence(legacy.user.id);
    assert.equal(legacyEvidence.balance, '1.000000000000000000');
    assert.equal(legacyEvidence.dailyEarned, '1.000000000000000000');
    assert.equal(legacyEvidence.installationCount, 0);
    assert.equal(legacyEvidence.batchCount, 0);
    assert.equal(legacyEvidence.snapshotCount, 0);
    assert.equal(legacyEvidence.ledgerCount, 0);

    console.log(JSON.stringify({
      database: databaseName,
      activeBranchOnlyOnClone: true,
      singleBatchSteps: 5000,
      partitionedBatchSteps: [1000, 1500, 2500],
      cumulativeErtExact: singleEvidence.balance,
      partitionIndependent: true,
      identicalRetryReceiptByteStable: true,
      oneLedgerCreditPerPositiveBatch: true,
      capExhaustionRejectedWithoutCredit: true,
      exactLedgerDailyBatchReconciliation: true,
      injectedFailureRolledBackCompletely: true,
      ownerLocalDayRollover: true,
      priorDaySnapshotImmutableAfterComfortChange: true,
      nextDayUsesUpdatedComfortOnly: true,
      concurrentFirstSnapshotConverged: true,
      crossOwnerEquipmentRejectedByDatabase: true,
      missingEquipmentRejectedWithApprovedCode: true,
      legacyMidDayActivationRejectedWithApprovedCode: true,
      rolloverLedgerReconciliationExact: true,
    }, null, 2));
  } finally {
    await dataSource.destroy();
  }
}

function activeSettlement() {
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  return new M2eSettlementService(new M2eEarningCalculator(config), new LedgerService(dataSource));
}

function activeSnapshotService() {
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  const calculator = new M2eEarningCalculator(config);
  const rings = new CopperRingRepository(dataSource);
  const entitlement = {
    async ensureStarterCopperInTransaction() { return { created: false }; },
  } as unknown as CopperRingEntitlementService;
  return new M2eDailySnapshotService(config, calculator, entitlement, rings);
}

function activeService(settlement = activeSettlement(), clock = now) {
  return new StepSyncService(
    dataSource,
    { getLimits: () => { throw new Error('Legacy earning path was called'); } } as never,
    { creditInTransaction: () => { throw new Error('Legacy ledger path was called'); } } as never,
    {
      getPolicy: () => ({ retentionSeconds: 604800, maxFutureSkewSeconds: 600 }),
      now: () => clock,
    } as never,
    { isEarningEnabledForUser: () => true } as never,
    activeSnapshotService(),
    settlement,
  );
}

function batchInputAt(input: {
  installationId: string;
  batchId: string;
  sequence: number;
  localDate: string;
  timezoneOffsetMinutes: number;
  observedStartedAt: string;
  observedEndedAt: string;
  stepDelta: number;
}) {
  return {
    ...input,
    sensorEventCount: input.stepDelta,
    source: StepSyncBatchSource.AndroidStepCounter,
    algorithmVersion: 'm2e-production-clone-qa-v1',
    clientMetadata: { qa: 'sanitized-production-clone' },
  };
}

async function seedFixture(suffix: string): Promise<Fixture> {
  const userId = randomUUID();
  const ringId = randomUUID();
  const telegramId = `clone-m2e-qa:${userId}`;
  await dataSource.query(`
    INSERT INTO users (id, telegram_id, first_name, is_admin, created_at, updated_at)
    VALUES ($1, $2, 'QA', false, now(), now())
  `, [userId, telegramId]);
  await dataSource.query(`
    INSERT INTO balances (
      user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert,
      eru_balance, lifetime_earned_eru, lifetime_spent_eru, updated_at
    ) VALUES ($1, 0, 0, 0, 0, 0, 0, now())
  `, [userId]);
  await dataSource.query(`
    INSERT INTO game_rings (
      id, owner_user_id, entitlement_code, ring_kind, status, level, shine,
      comfort, charm, quality, luck, visual_variant_code, ruleset_version,
      generation_version, visual_set_version, issued_reason, created_at, updated_at
    ) VALUES ($1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', 1, 100,
      20, 10, 10, 10, 'copper_plain_polished', 'copper-rules-v1',
      'copper-generation-v1', 'copper-visual-v1', 'LAZY_ENSURE', now(), now())
  `, [ringId, userId]);
  await dataSource.query(`
    INSERT INTO equipped_rings (user_id, ring_id, equipped_at, updated_at)
    VALUES ($1, $2, now(), now())
  `, [userId, ringId]);
  const user = await dataSource.getRepository(User).findOneByOrFail({ id: userId });
  assert.equal(user.telegramId, telegramId, suffix);
  return { user, ringId };
}

function batchInput(
  installationId: string,
  batchId: string,
  sequence: number,
  stepDelta: number,
  hour: number,
  minute: number,
) {
  const start = new Date(Date.UTC(2099, 0, 10, hour, minute, 0));
  const end = new Date(start.getTime() + 10 * 60 * 1000);
  return {
    installationId,
    batchId,
    sequence,
    localDate: accountingDate,
    timezoneOffsetMinutes: 0,
    observedStartedAt: start.toISOString(),
    observedEndedAt: end.toISOString(),
    stepDelta,
    sensorEventCount: stepDelta,
    source: StepSyncBatchSource.AndroidStepCounter,
    algorithmVersion: 'm2e-production-clone-qa-v1',
    clientMetadata: { qa: 'sanitized-production-clone' },
  };
}

async function evidence(userId: string) {
  const [row] = await dataSource.query(`
    SELECT
      b.ert_balance::text AS balance,
      coalesce((SELECT earned_ert::text FROM daily_user_stats WHERE user_id = $1 AND date = $2), '0') AS "dailyEarned",
      coalesce((SELECT sum(earned_ert_delta)::text FROM step_sync_batches WHERE user_id = $1 AND accounting_date = $2), '0') AS "batchDelta",
      coalesce((SELECT sum(amount)::text FROM ledger_transactions WHERE user_id = $1 AND reference_type = 'm2e_step_sync_batch'), '0') AS "ledgerAmount",
      (SELECT count(*)::integer FROM ledger_transactions WHERE user_id = $1 AND reference_type = 'm2e_step_sync_batch') AS "ledgerCount",
      (SELECT count(*)::integer FROM m2e_daily_economic_snapshots WHERE user_id = $1 AND accounting_date = $2) AS "snapshotCount",
      (SELECT count(*)::integer FROM step_sync_installations WHERE user_id = $1) AS "installationCount",
      (SELECT count(*)::integer FROM step_sync_batches WHERE user_id = $1) AS "batchCount",
      (SELECT count(*)::integer FROM daily_user_stats WHERE user_id = $1 AND date = $2) AS "dailyCount"
    FROM balances b WHERE b.user_id = $1
  `, [userId, accountingDate]);
  return row as {
    balance: string;
    dailyEarned: string;
    batchDelta: string;
    ledgerAmount: string;
    ledgerCount: number;
    snapshotCount: number;
    installationCount: number;
    batchCount: number;
    dailyCount: number;
  };
}

async function reconcileOwner(userId: string) {
  const [row] = await dataSource.query(`
    SELECT b.ert_balance::text AS balance,
      (SELECT coalesce(sum(earned_ert), 0)::text FROM daily_user_stats WHERE user_id = $1) AS "dailyEarned",
      (SELECT coalesce(sum(earned_ert_delta), 0)::text FROM step_sync_batches WHERE user_id = $1 AND accounting_date IS NOT NULL) AS "batchDelta",
      (SELECT coalesce(sum(amount), 0)::text FROM ledger_transactions WHERE user_id = $1 AND reference_type = 'm2e_step_sync_batch') AS "ledgerAmount",
      (SELECT count(*)::integer FROM m2e_daily_economic_snapshots WHERE user_id = $1) AS "snapshotCount"
    FROM balances b WHERE b.user_id = $1
  `, [userId]);
  return row as {
    balance: string;
    dailyEarned: string;
    batchDelta: string;
    ledgerAmount: string;
    snapshotCount: number;
  };
}

function conflictCode(error: unknown) {
  if (!(error instanceof ConflictException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    ? String((response as { code: unknown }).code)
    : null;
}

function pgCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
