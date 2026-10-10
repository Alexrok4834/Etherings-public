import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { WalkConfigService } from '../walk/walk-config.service';
import { WalkSession, WalkSessionStatus } from '../walk/walk-session.entity';
import { StepSyncBatch, StepSyncBatchSource, StepSyncBatchStatus } from './step-sync-batch.entity';
import { StepSyncConfigService } from './step-sync-config.service';
import { StepSyncInstallation, StepSyncInstallationStatus } from './step-sync-installation.entity';
import { M2eActivationConfigService } from '../m2e/m2e-activation-config.service';
import { M2eDailyEconomicSnapshot } from '../m2e/m2e-daily-economic-snapshot.entity';
import { M2eDailySnapshotService } from '../m2e/m2e-daily-snapshot.service';
import { canonicalErt, displayErt, ErtDecimal } from '../m2e/ert-decimal';
import { M2eSettlementResult, M2eSettlementService } from '../m2e/m2e-settlement.service';

const MAX_BATCH_STEPS = 100_000;
const MAX_SENSOR_EVENTS = 1_000_000;
const MAX_BATCH_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENT_METADATA_BYTES = 4096;
const MAX_JSON_DEPTH = 8;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALGORITHM_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export enum StepSyncConflictCode {
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  SequenceConflict = 'SEQUENCE_CONFLICT',
  ConcurrentConflict = 'CONCURRENT_CONFLICT',
  M2eActivationDateConflict = 'M2E_ACTIVATION_DATE_CONFLICT',
}

export enum StepSyncResultCode {
  Accepted = 'ACCEPTED',
  PartiallyAccepted = 'PARTIALLY_ACCEPTED',
  DailyCapReached = 'DAILY_CAP_REACHED',
  ExpiredBatch = 'EXPIRED_BATCH',
  FutureTimestamp = 'FUTURE_TIMESTAMP',
  LocalDateMismatch = 'LOCAL_DATE_MISMATCH',
  SequenceOutOfOrder = 'SEQUENCE_OUT_OF_ORDER',
  OverlappingInterval = 'OVERLAPPING_INTERVAL',
}

export type ReceiveStepSyncBatchInput = {
  installationId: unknown;
  batchId: unknown;
  sequence: unknown;
  localDate: unknown;
  timezoneOffsetMinutes: unknown;
  observedStartedAt: unknown;
  observedEndedAt: unknown;
  stepDelta: unknown;
  sensorEventCount: unknown;
  source: unknown;
  algorithmVersion: unknown;
  clientMetadata?: unknown;
};

type ValidatedBatchInput = {
  installationId: string;
  batchId: string;
  sequence: number;
  localDate: string;
  timezoneOffsetMinutes: number;
  observedStartedAt: Date;
  observedEndedAt: Date;
  stepDelta: number;
  sensorEventCount: number;
  source: StepSyncBatchSource;
  algorithmVersion: string;
  clientMetadata: Record<string, unknown> | null;
};

export type StepSyncBatchResponse = {
  batchId: string;
  installationId: string;
  sequence: number;
  status: StepSyncBatchStatus;
  acceptedStepDelta: number | null;
  earnedErtDelta: number | null;
  earnedErtDeltaExact: string | null;
  earnedErtDeltaDisplay: string | null;
  dailyStepCap: number | null;
  accountingDate: string | null;
  resultCode: string | null;
  receivedAt: string;
  processedAt: string | null;
  rulesVersion: string | null;
  balanceConfigVersion: string | null;
  m2eSettlement?: M2eSettlementResult;
};

type StepSyncEconomyProjection = Pick<StepSyncBatchResponse,
  | 'earnedErtDeltaExact'
  | 'earnedErtDeltaDisplay'
  | 'dailyStepCap'
  | 'rulesVersion'
  | 'balanceConfigVersion'
>;

type ExactDailyStatsRow = {
  id: string;
  acceptedSteps: number;
  earnedErt: string;
};

@Injectable()
export class StepSyncService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly walkConfigService: WalkConfigService,
    private readonly ledgerService: LedgerService,
    private readonly stepSyncConfigService: StepSyncConfigService,
    private readonly m2eActivationConfig: M2eActivationConfigService,
    private readonly m2eDailySnapshotService: M2eDailySnapshotService,
    private readonly m2eSettlementService: M2eSettlementService,
  ) {}

  async receiveBatch(user: User, untrustedInput: ReceiveStepSyncBatchInput): Promise<StepSyncBatchResponse> {
    const input = this.validateInput(untrustedInput);
    const payloadHash = this.hashPayload(input);

    try {
      return await this.receiveInTransaction(user.id, input, payloadHash);
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      try {
        return await this.receiveInTransaction(user.id, input, payloadHash);
      } catch (retryError) {
        if (this.isUniqueViolation(retryError)) {
          throw this.conflict(
            StepSyncConflictCode.ConcurrentConflict,
            'Concurrent batch conflict could not be resolved',
          );
        }
        throw retryError;
      }
    }
  }

  private receiveInTransaction(
    userId: string,
    input: ValidatedBatchInput,
    payloadHash: string,
  ): Promise<StepSyncBatchResponse> {
    return this.dataSource.transaction(async (manager) => {
      const installation = await this.getOrCreateInstallation(manager, userId, input.installationId);
      if (installation.status === StepSyncInstallationStatus.Revoked) {
        throw new ForbiddenException('Step sync installation is revoked');
      }

      const batches = manager.getRepository(StepSyncBatch);
      const existingBatch = await batches.findOne({
        where: {
          userId,
          installationRecordId: installation.id,
          batchId: input.batchId,
        },
      });

      if (existingBatch) {
        if (existingBatch.payloadHash !== payloadHash) {
          throw this.conflict(
            StepSyncConflictCode.IdempotencyConflict,
            'Batch identity already exists with a different payload',
          );
        }
        return this.toResponse(existingBatch, installation.installationId);
      }

      const existingSequence = await batches.findOne({
        where: {
          installationRecordId: installation.id,
          sequence: String(input.sequence),
        },
      });
      if (existingSequence) {
        throw this.conflict(
          StepSyncConflictCode.SequenceConflict,
          'Installation sequence already belongs to another batch',
        );
      }

      const batch = batches.create({
        userId,
        installationRecordId: installation.id,
        batchId: input.batchId,
        sequence: String(input.sequence),
        payloadHash,
        localDate: input.localDate,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes,
        observedStartedAt: input.observedStartedAt,
        observedEndedAt: input.observedEndedAt,
        claimedStepCount: input.stepDelta,
        sensorEventCount: input.sensorEventCount,
        source: input.source,
        algorithmVersion: input.algorithmVersion,
        status: StepSyncBatchStatus.Received,
        acceptedStepDelta: null,
        earnedErtDelta: null,
        accountingDate: null,
        resultCode: null,
        clientMetadata: input.clientMetadata,
        resultSnapshot: null,
        processedAt: null,
      });
      const savedBatch = await batches.save(batch);

      installation.lastSeenAt = new Date();
      await manager.getRepository(StepSyncInstallation).save(installation);

      const terminalPolicyCode = this.getTerminalPolicyCode(input);
      if (terminalPolicyCode !== null) {
        return this.finalizeBatch(
          manager,
          savedBatch,
          installation.installationId,
          StepSyncBatchStatus.Rejected,
          0,
          0,
          null,
          terminalPolicyCode,
        );
      }

      return this.applyAccounting(manager, savedBatch, installation.installationId);
    });
  }

  private async getOrCreateInstallation(manager: EntityManager, userId: string, installationId: string) {
    const installations = manager.getRepository(StepSyncInstallation);
    const existing = await installations.findOne({
      where: { userId, installationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) return existing;

    return installations.save(installations.create({
      userId,
      installationId,
      status: StepSyncInstallationStatus.Active,
      lastSeenAt: null,
      revokedAt: null,
    }));
  }

  private async applyAccounting(
    manager: EntityManager,
    batch: StepSyncBatch,
    installationId: string,
  ): Promise<StepSyncBatchResponse> {
    const lockedUser = await manager.getRepository(User).findOne({
      where: { id: batch.userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedUser) {
      throw new ForbiddenException('Step sync user no longer exists');
    }

    const historyResultCode = await this.getHistoryResultCode(manager, batch);
    if (historyResultCode !== null) {
      return this.finalizeBatch(
        manager,
        batch,
        installationId,
        StepSyncBatchStatus.Rejected,
        0,
        0,
        null,
        historyResultCode,
      );
    }

    if (this.m2eActivationConfig.isEarningEnabledForUser(batch.userId, batch.localDate)) {
      return this.applyM2eAccounting(manager, batch, installationId);
    }

    const limits = this.walkConfigService.getLimits();
    const statsRepository = manager.getRepository(DailyUserStats);
    let stats = await statsRepository.findOne({
      where: { userId: batch.userId, date: batch.localDate },
      lock: { mode: 'pessimistic_write' },
    });
    const alreadyAcceptedSteps = stats?.acceptedSteps ?? 0;
    const remainingSteps = Math.max(0, limits.dailyStepLimitBase - alreadyAcceptedSteps);

    if (remainingSteps === 0) {
      return this.finalizeBatch(
        manager,
        batch,
        installationId,
        StepSyncBatchStatus.Rejected,
        0,
        0,
        null,
        StepSyncResultCode.DailyCapReached,
        this.economyProjection(0, limits.dailyStepLimitBase),
      );
    }

    const acceptedStepDelta = Math.min(batch.claimedStepCount, remainingSteps);
    const status = acceptedStepDelta === batch.claimedStepCount
      ? StepSyncBatchStatus.Accepted
      : StepSyncBatchStatus.PartiallyAccepted;
    const resultCode = status === StepSyncBatchStatus.Accepted
      ? StepSyncResultCode.Accepted
      : StepSyncResultCode.PartiallyAccepted;

    stats ??= statsRepository.create({
      userId: batch.userId,
      date: batch.localDate,
      acceptedSteps: 0,
      earnedErt: 0,
      raffleAttempts: 0,
    });
    const cumulativeAcceptedSteps = stats.acceptedSteps + acceptedStepDelta;
    const cumulativeEarnedErt = Math.floor(
      (cumulativeAcceptedSteps * limits.ertPer1000Steps) / 1000,
    );
    const earnedErtDelta = Math.max(0, cumulativeEarnedErt - stats.earnedErt);
    stats.acceptedSteps = cumulativeAcceptedSteps;
    stats.earnedErt += earnedErtDelta;
    await statsRepository.save(stats);

    if (earnedErtDelta > 0) {
      await this.ledgerService.creditInTransaction(manager, {
        userId: batch.userId,
        amount: earnedErtDelta,
        type: LedgerTransactionType.WalkReward,
        referenceType: 'step_sync_batch',
        referenceId: batch.id,
        metadata: {
          accountingDate: batch.localDate,
          acceptedStepDelta,
          claimedStepCount: batch.claimedStepCount,
          cumulativeAcceptedSteps,
          cumulativeEarnedErt: stats.earnedErt,
        },
      });
    }

    return this.finalizeBatch(
      manager,
      batch,
      installationId,
      status,
      acceptedStepDelta,
      earnedErtDelta,
      batch.localDate,
      resultCode,
      this.economyProjection(earnedErtDelta, limits.dailyStepLimitBase),
    );
  }

  private async applyM2eAccounting(
    manager: EntityManager,
    batch: StepSyncBatch,
    installationId: string,
  ): Promise<StepSyncBatchResponse> {
    const stats = await this.lockExactDailyStats(manager, batch.userId, batch.localDate);
    const existingSnapshot = await manager.getRepository(M2eDailyEconomicSnapshot).findOne({
      where: { userId: batch.userId, accountingDate: batch.localDate },
      lock: { mode: 'pessimistic_write' },
    });
    if (!existingSnapshot
      && (stats.acceptedSteps > 0 || !new ErtDecimal(stats.earnedErt).isZero())) {
      throw this.conflict(
        StepSyncConflictCode.M2eActivationDateConflict,
        'M2E earning cannot be activated after accounting has started for this date',
      );
    }

    const snapshot = existingSnapshot ?? await this.m2eDailySnapshotService.getOrCreateInTransaction(
      manager,
      batch.userId,
      batch.localDate,
    );
    const remainingSteps = Math.max(0, snapshot.stepCap - stats.acceptedSteps);
    if (remainingSteps === 0) {
      batch.m2eDailySnapshotId = snapshot.id;
      return this.finalizeBatch(
        manager,
        batch,
        installationId,
        StepSyncBatchStatus.Rejected,
        0,
        0,
        null,
        StepSyncResultCode.DailyCapReached,
        this.economyProjection(0, snapshot.stepCap, {
          rulesVersion: snapshot.rulesVersion,
          balanceConfigVersion: snapshot.balanceConfigVersion,
        }),
      );
    }

    const acceptedStepDelta = Math.min(batch.claimedStepCount, remainingSteps);
    const status = acceptedStepDelta === batch.claimedStepCount
      ? StepSyncBatchStatus.Accepted
      : StepSyncBatchStatus.PartiallyAccepted;
    const resultCode = status === StepSyncBatchStatus.Accepted
      ? StepSyncResultCode.Accepted
      : StepSyncResultCode.PartiallyAccepted;
    const cumulativeAcceptedSteps = stats.acceptedSteps + acceptedStepDelta;
    const settlement = await this.m2eSettlementService.settleInTransaction(manager, {
      userId: batch.userId,
      batchRecordId: batch.id,
      cumulativeAcceptedSteps,
      alreadyCreditedErt: stats.earnedErt,
      snapshot,
    });

    await manager.query(`
      UPDATE daily_user_stats
      SET accepted_steps = $3, earned_ert = $4::numeric, updated_at = now()
      WHERE user_id = $1 AND date = $2
    `, [batch.userId, batch.localDate, cumulativeAcceptedSteps, settlement.cumulativeAuthoritativeErt]);

    return this.finalizeM2eBatch(
      manager,
      batch,
      installationId,
      status,
      acceptedStepDelta,
      resultCode,
      settlement,
    );
  }

  private async lockExactDailyStats(
    manager: EntityManager,
    userId: string,
    accountingDate: string,
  ): Promise<ExactDailyStatsRow> {
    const rows = await manager.query(`
      SELECT id, accepted_steps AS "acceptedSteps", earned_ert::text AS "earnedErt"
      FROM daily_user_stats
      WHERE user_id = $1 AND date = $2
      FOR UPDATE
    `, [userId, accountingDate]) as ExactDailyStatsRow[];
    if (rows[0]) return rows[0];

    const inserted = await manager.query(`
      INSERT INTO daily_user_stats (
        user_id, date, accepted_steps, earned_ert, raffle_attempts, created_at, updated_at
      ) VALUES ($1, $2, 0, 0, 0, now(), now())
      RETURNING id, accepted_steps AS "acceptedSteps", earned_ert::text AS "earnedErt"
    `, [userId, accountingDate]) as ExactDailyStatsRow[];
    return inserted[0];
  }

  private async finalizeM2eBatch(
    manager: EntityManager,
    batch: StepSyncBatch,
    installationId: string,
    status: StepSyncBatchStatus.Accepted | StepSyncBatchStatus.PartiallyAccepted,
    acceptedStepDelta: number,
    resultCode: StepSyncResultCode.Accepted | StepSyncResultCode.PartiallyAccepted,
    settlement: M2eSettlementResult,
  ) {
    batch.status = status;
    batch.acceptedStepDelta = acceptedStepDelta;
    batch.earnedErtDelta = settlement.deltaAuthoritativeErt;
    batch.m2eDailySnapshotId = settlement.snapshotId;
    batch.accountingDate = batch.localDate;
    batch.resultCode = resultCode;
    batch.processedAt = this.stepSyncConfigService.now();
    const response: StepSyncBatchResponse = {
      batchId: batch.batchId,
      installationId,
      sequence: Number(batch.sequence),
      status,
      acceptedStepDelta,
      earnedErtDelta: Number(settlement.deltaAuthoritativeErt),
      ...this.economyProjection(settlement.deltaAuthoritativeErt, settlement.stepCap, {
        rulesVersion: settlement.rulesVersion,
        balanceConfigVersion: settlement.balanceConfigVersion,
      }),
      accountingDate: batch.localDate,
      resultCode,
      receivedAt: batch.createdAt.toISOString(),
      processedAt: batch.processedAt.toISOString(),
      m2eSettlement: settlement,
    };
    batch.resultSnapshot = response;
    await manager.getRepository(StepSyncBatch).save(batch);
    return response;
  }

  private async finalizeBatch(
    manager: EntityManager,
    batch: StepSyncBatch,
    installationId: string,
    status: StepSyncBatchStatus,
    acceptedStepDelta: number,
    earnedErtDelta: number,
    accountingDate: string | null,
    resultCode: StepSyncResultCode,
    economy = this.economyProjection(earnedErtDelta, null),
  ) {
    batch.status = status;
    batch.acceptedStepDelta = acceptedStepDelta;
    batch.earnedErtDelta = earnedErtDelta;
    batch.accountingDate = accountingDate;
    batch.resultCode = resultCode;
    batch.processedAt = this.stepSyncConfigService.now();
    const response = this.toResponse(batch, installationId, economy);
    batch.resultSnapshot = response;
    await manager.getRepository(StepSyncBatch).save(batch);
    return response;
  }

  private getTerminalPolicyCode(input: ValidatedBatchInput): StepSyncResultCode | null {
    const policy = this.stepSyncConfigService.getPolicy();
    const nowMs = this.stepSyncConfigService.now().getTime();
    if (input.observedEndedAt.getTime() > nowMs + policy.maxFutureSkewSeconds * 1000) {
      return StepSyncResultCode.FutureTimestamp;
    }
    if (input.observedStartedAt.getTime() < nowMs - policy.retentionSeconds * 1000) {
      return StepSyncResultCode.ExpiredBatch;
    }
    if (!this.matchesClaimedLocalDate(input)) {
      return StepSyncResultCode.LocalDateMismatch;
    }
    return null;
  }

  private async getHistoryResultCode(manager: EntityManager, batch: StepSyncBatch) {
    const batches = manager.getRepository(StepSyncBatch);
    const laterSequence = await batches.createQueryBuilder('batch')
      .where('batch.installationRecordId = :installationRecordId', {
        installationRecordId: batch.installationRecordId,
      })
      .andWhere('batch.id <> :currentBatchId', { currentBatchId: batch.id })
      .andWhere('batch.sequence > :sequence', { sequence: batch.sequence })
      .getOne();
    if (laterSequence) return StepSyncResultCode.SequenceOutOfOrder;

    const overlap = await batches.createQueryBuilder('batch')
      .where('batch.userId = :userId', { userId: batch.userId })
      .andWhere('batch.id <> :currentBatchId', { currentBatchId: batch.id })
      .andWhere('batch.status IN (:...accountedStatuses)', {
        accountedStatuses: [StepSyncBatchStatus.Accepted, StepSyncBatchStatus.PartiallyAccepted],
      })
      .andWhere('batch.observedStartedAt < :observedEndedAt', {
        observedEndedAt: batch.observedEndedAt,
      })
      .andWhere('batch.observedEndedAt > :observedStartedAt', {
        observedStartedAt: batch.observedStartedAt,
      })
      .getOne();
    if (overlap) return StepSyncResultCode.OverlappingInterval;

    const legacyWalkOverlap = await manager.getRepository(WalkSession)
      .createQueryBuilder('walk')
      .where('walk.userId = :userId', { userId: batch.userId })
      .andWhere('walk.status = :acceptedStatus', { acceptedStatus: WalkSessionStatus.Accepted })
      .andWhere('walk.startedAt < :observedEndedAt', { observedEndedAt: batch.observedEndedAt })
      .andWhere('walk.endedAt > :observedStartedAt', { observedStartedAt: batch.observedStartedAt })
      .getOne();
    return legacyWalkOverlap ? StepSyncResultCode.OverlappingInterval : null;
  }

  private matchesClaimedLocalDate(input: ValidatedBatchInput) {
    const offsetMs = input.timezoneOffsetMinutes * 60 * 1000;
    const startedLocal = new Date(input.observedStartedAt.getTime() + offsetMs).toISOString();
    const endedLocal = new Date(input.observedEndedAt.getTime() + offsetMs).toISOString();
    if (startedLocal.slice(0, 10) !== input.localDate) return false;
    if (endedLocal.slice(0, 10) === input.localDate) return true;

    const nextDate = new Date(`${input.localDate}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    return endedLocal === `${nextDate.toISOString().slice(0, 10)}T00:00:00.000Z`;
  }

  private validateInput(input: ReceiveStepSyncBatchInput): ValidatedBatchInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Batch body must be an object');
    }

    this.rejectUnknownFields(input as Record<string, unknown>);
    const installationId = this.uuidV4(input.installationId, 'installationId');
    const batchId = this.uuidV4(input.batchId, 'batchId');
    const sequence = this.boundedInteger(input.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER);
    const localDate = this.localDate(input.localDate);
    const timezoneOffsetMinutes = this.boundedInteger(
      input.timezoneOffsetMinutes,
      'timezoneOffsetMinutes',
      -1080,
      1080,
    );
    const observedStartedAt = this.offsetDate(input.observedStartedAt, 'observedStartedAt');
    const observedEndedAt = this.offsetDate(input.observedEndedAt, 'observedEndedAt');
    const durationMs = observedEndedAt.getTime() - observedStartedAt.getTime();
    if (durationMs <= 0 || durationMs > MAX_BATCH_DURATION_MS) {
      throw new BadRequestException('Batch observation interval must be positive and no longer than 24 hours');
    }

    const stepDelta = this.boundedInteger(input.stepDelta, 'stepDelta', 1, MAX_BATCH_STEPS);
    const sensorEventCount = this.boundedInteger(
      input.sensorEventCount,
      'sensorEventCount',
      1,
      MAX_SENSOR_EVENTS,
    );
    if (input.source !== StepSyncBatchSource.AndroidStepCounter) {
      throw new BadRequestException('source must be android_step_counter');
    }
    if (typeof input.algorithmVersion !== 'string' || !ALGORITHM_VERSION_PATTERN.test(input.algorithmVersion)) {
      throw new BadRequestException('algorithmVersion must contain 1-64 safe identifier characters');
    }

    const clientMetadata = input.clientMetadata === undefined
      ? null
      : this.clientMetadata(input.clientMetadata);

    return {
      installationId,
      batchId,
      sequence,
      localDate,
      timezoneOffsetMinutes,
      observedStartedAt,
      observedEndedAt,
      stepDelta,
      sensorEventCount,
      source: StepSyncBatchSource.AndroidStepCounter,
      algorithmVersion: input.algorithmVersion,
      clientMetadata,
    };
  }

  private rejectUnknownFields(input: Record<string, unknown>) {
    const allowed = new Set([
      'installationId',
      'batchId',
      'sequence',
      'localDate',
      'timezoneOffsetMinutes',
      'observedStartedAt',
      'observedEndedAt',
      'stepDelta',
      'sensorEventCount',
      'source',
      'algorithmVersion',
      'clientMetadata',
    ]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown batch fields: ${unknown.sort().join(', ')}`);
    }
  }

  private uuidV4(value: unknown, field: string) {
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must be an RFC 4122 UUID v4`);
    }
    return value.toLowerCase();
  }

  private boundedInteger(value: unknown, field: string, minimum: number, maximum: number) {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
    }
    return value as number;
  }

  private localDate(value: unknown) {
    if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
      throw new BadRequestException('localDate must use YYYY-MM-DD');
    }
    if (!this.isRealCalendarDate(value)) {
      throw new BadRequestException('localDate must be a real calendar date');
    }
    return value;
  }

  private offsetDate(value: unknown, field: string) {
    if (typeof value !== 'string' || !OFFSET_DATE_TIME_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must be an ISO 8601 date-time with an explicit offset`);
    }
    if (!this.isRealCalendarDate(value.slice(0, 10))) {
      throw new BadRequestException(`${field} must contain a real calendar date`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid date-time`);
    }
    return parsed;
  }

  private isRealCalendarDate(value: string) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private clientMetadata(value: unknown) {
    const normalized = this.normalizeJson(value, 0);
    if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
      throw new BadRequestException('clientMetadata must be a JSON object');
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CLIENT_METADATA_BYTES) {
      throw new BadRequestException(`clientMetadata must not exceed ${MAX_CLIENT_METADATA_BYTES} bytes`);
    }
    return normalized as Record<string, unknown>;
  }

  private normalizeJson(value: unknown, depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) {
      throw new BadRequestException(`clientMetadata must not exceed ${MAX_JSON_DEPTH} levels`);
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => this.normalizeJson(item, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.normalizeJson(item, depth + 1)]),
      );
    }
    throw new BadRequestException('clientMetadata must contain only JSON values');
  }

  private hashPayload(input: ValidatedBatchInput) {
    const canonicalPayload = {
      algorithmVersion: input.algorithmVersion,
      batchId: input.batchId,
      clientMetadata: input.clientMetadata,
      installationId: input.installationId,
      localDate: input.localDate,
      observedEndedAt: input.observedEndedAt.toISOString(),
      observedStartedAt: input.observedStartedAt.toISOString(),
      sensorEventCount: input.sensorEventCount,
      sequence: input.sequence,
      source: input.source,
      stepDelta: input.stepDelta,
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    };
    return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
  }

  private toResponse(
    batch: StepSyncBatch,
    installationId: string,
    economy?: StepSyncEconomyProjection,
  ): StepSyncBatchResponse {
    if (batch.resultSnapshot !== null) {
      return this.withEconomyProjection(batch.resultSnapshot, batch.earnedErtDelta);
    }
    return {
      batchId: batch.batchId,
      installationId,
      sequence: Number(batch.sequence),
      status: batch.status,
      acceptedStepDelta: batch.acceptedStepDelta,
      earnedErtDelta: batch.earnedErtDelta === null ? null : Number(batch.earnedErtDelta),
      ...(economy ?? this.economyProjection(batch.earnedErtDelta, null)),
      accountingDate: batch.accountingDate,
      resultCode: batch.resultCode,
      receivedAt: batch.createdAt.toISOString(),
      processedAt: batch.processedAt?.toISOString() ?? null,
    };
  }

  private withEconomyProjection(
    snapshot: Record<string, unknown>,
    persistedDelta: StepSyncBatch['earnedErtDelta'],
  ): StepSyncBatchResponse {
    const settlement = snapshot.m2eSettlement as Partial<M2eSettlementResult> | undefined;
    const projection = this.economyProjection(
      typeof snapshot.earnedErtDeltaExact === 'string'
        ? snapshot.earnedErtDeltaExact
        : settlement?.deltaAuthoritativeErt ?? persistedDelta,
      typeof snapshot.dailyStepCap === 'number' ? snapshot.dailyStepCap : settlement?.stepCap ?? null,
      {
        rulesVersion: typeof snapshot.rulesVersion === 'string'
          ? snapshot.rulesVersion
          : settlement?.rulesVersion ?? null,
        balanceConfigVersion: typeof snapshot.balanceConfigVersion === 'string'
          ? snapshot.balanceConfigVersion
          : settlement?.balanceConfigVersion ?? null,
      },
    );
    const response: StepSyncBatchResponse = {
      batchId: snapshot.batchId as string,
      installationId: snapshot.installationId as string,
      sequence: snapshot.sequence as number,
      status: snapshot.status as StepSyncBatchStatus,
      acceptedStepDelta: snapshot.acceptedStepDelta as number | null,
      earnedErtDelta: snapshot.earnedErtDelta as number | null,
      ...projection,
      accountingDate: snapshot.accountingDate as string | null,
      resultCode: snapshot.resultCode as string | null,
      receivedAt: snapshot.receivedAt as string,
      processedAt: snapshot.processedAt as string | null,
    };
    if (settlement) response.m2eSettlement = this.orderedSettlement(settlement);
    return response;
  }

  private orderedSettlement(settlement: Partial<M2eSettlementResult>): M2eSettlementResult {
    return {
      snapshotId: settlement.snapshotId as string,
      rulesVersion: settlement.rulesVersion as M2eSettlementResult['rulesVersion'],
      balanceConfigVersion: settlement.balanceConfigVersion as M2eSettlementResult['balanceConfigVersion'],
      ringCount: settlement.ringCount as number,
      selectedRingId: settlement.selectedRingId as string,
      selectedRingComfort: settlement.selectedRingComfort as number,
      stepCap: settlement.stepCap as number,
      cumulativeAcceptedSteps: settlement.cumulativeAcceptedSteps as number,
      validSteps: settlement.validSteps as number,
      exactNumerator: settlement.exactNumerator as string,
      exactDenominator: settlement.exactDenominator as string,
      comfortMultiplier: settlement.comfortMultiplier as string,
      cumulativeAuthoritativeErt: settlement.cumulativeAuthoritativeErt as string,
      cumulativeDisplayedErt: settlement.cumulativeDisplayedErt as string,
      deltaAuthoritativeErt: settlement.deltaAuthoritativeErt as string,
      deltaDisplayedErt: settlement.deltaDisplayedErt as string,
    };
  }

  private economyProjection(
    earnedErtDelta: number | string | null,
    dailyStepCap: number | null,
    versions: Pick<StepSyncEconomyProjection, 'rulesVersion' | 'balanceConfigVersion'> = {
      rulesVersion: null,
      balanceConfigVersion: null,
    },
  ): StepSyncEconomyProjection {
    if (earnedErtDelta === null) {
      return {
        earnedErtDeltaExact: null,
        earnedErtDeltaDisplay: null,
        dailyStepCap,
        ...versions,
      };
    }
    const exact = canonicalErt(String(earnedErtDelta));
    return {
      earnedErtDeltaExact: exact,
      earnedErtDeltaDisplay: displayErt(exact),
      dailyStepCap,
      ...versions,
    };
  }

  private isUniqueViolation(error: unknown) {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
    return candidate.code === '23505' || candidate.driverError?.code === '23505';
  }

  private conflict(code: StepSyncConflictCode, message: string) {
    return new ConflictException({ message, error: 'Conflict', code });
  }
}
