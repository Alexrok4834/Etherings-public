import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { StepSyncBatch, StepSyncBatchStatus } from '../step-sync/step-sync-batch.entity';
import { DailyUserStats } from './daily-user-stats.entity';
import { WalkConfigService } from './walk-config.service';
import { WalkSession, WalkSessionSource, WalkSessionStatus } from './walk-session.entity';

export enum WalkRejectionReason {
  SessionTooShort = 'SESSION_TOO_SHORT',
  SessionTooLong = 'SESSION_TOO_LONG',
  ImpossibleSpeed = 'IMPOSSIBLE_SPEED',
  AndroidLegacyPathRetired = 'ANDROID_LEGACY_PATH_RETIRED',
}

export const ANDROID_LEGACY_WALK_RETIRED_CODE = 'ANDROID_LEGACY_WALK_RETIRED';

export type FinishWalkSessionInput = {
  clientStepCount: number;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceMeters?: number | null;
  samplesCount: number;
  algorithmVersion: string;
};

export type StartWalkSessionInput = {
  source?: unknown;
};

@Injectable()
export class WalkService {
  constructor(
    @InjectRepository(WalkSession)
    private readonly walkSessionRepository: Repository<WalkSession>,
    private readonly walkConfigService: WalkConfigService,
    private readonly dataSource: DataSource,
    private readonly ledgerService: LedgerService,
  ) {}

  startSession(user: User, input: StartWalkSessionInput = {}) {
    const source = this.parseSource(input.source);
    if (source === WalkSessionSource.AndroidStepCounter) {
      throw this.androidLegacyPathRetired();
    }
    const session = this.walkSessionRepository.create({
      userId: user.id,
      status: WalkSessionStatus.Started,
      startedAt: new Date(),
      endedAt: null,
      clientStepCount: null,
      acceptedStepCount: null,
      durationSeconds: null,
      distanceMeters: null,
      avgSpeedMps: null,
      source,
      rejectionReason: null,
      rawSummary: null,
      earnedErt: 0,
    });

    return this.walkSessionRepository.save(session);
  }

  private parseSource(source: unknown) {
    if (source === undefined) {
      return WalkSessionSource.TelegramAccelerometer;
    }

    if (typeof source === 'string' && Object.values(WalkSessionSource).includes(source as WalkSessionSource)) {
      return source as WalkSessionSource;
    }

    throw new BadRequestException('source must be a supported walk session source');
  }

  async finishSession(user: User, sessionId: string, input: FinishWalkSessionInput) {
    this.validateFinishInput(input);

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(WalkSession);
      const session = await repository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!session) {
        throw new NotFoundException('Walk session not found');
      }

      if (session.userId !== user.id) {
        throw new ForbiddenException('Walk session belongs to another user');
      }

      if (session.status !== WalkSessionStatus.Started) {
        throw new BadRequestException('Walk session is already finished');
      }

      if (session.source === WalkSessionSource.AndroidStepCounter) {
        session.status = WalkSessionStatus.Rejected;
        session.startedAt = new Date(input.startedAt);
        session.endedAt = new Date(input.endedAt);
        session.clientStepCount = Number.isInteger(input.clientStepCount) ? input.clientStepCount : null;
        session.acceptedStepCount = 0;
        session.durationSeconds = Number.isInteger(input.durationSeconds) ? input.durationSeconds : null;
        session.distanceMeters = input.distanceMeters ?? null;
        session.avgSpeedMps = null;
        session.rejectionReason = WalkRejectionReason.AndroidLegacyPathRetired;
        session.rawSummary = { ...input };
        session.earnedErt = 0;
        return repository.save(session);
      }

      this.validateSessionInterval(session, input);

      await manager.getRepository(User).findOne({
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      return this.applyFinish(manager, session, input);
    });
  }

  listSessions(user: User) {
    return this.walkSessionRepository.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  private async applyFinish(manager: EntityManager, session: WalkSession, input: FinishWalkSessionInput) {
    const endedAt = new Date(input.endedAt);
    const startedAt = new Date(input.startedAt);
    const distanceMeters = input.distanceMeters ?? null;
    const avgSpeedMps = distanceMeters === null ? null : distanceMeters / input.durationSeconds;
    const rejectionReason = this.getRejectionReason(input.durationSeconds, avgSpeedMps);

    session.startedAt = startedAt;
    session.endedAt = endedAt;
    session.clientStepCount = input.clientStepCount;
    session.durationSeconds = input.durationSeconds;
    session.distanceMeters = distanceMeters;
    session.avgSpeedMps = avgSpeedMps;
    session.rejectionReason = rejectionReason;
    session.rawSummary = { ...input };

    if (rejectionReason !== null) {
      session.status = WalkSessionStatus.Rejected;
      session.acceptedStepCount = null;
      session.earnedErt = 0;
      return manager.getRepository(WalkSession).save(session);
    }

    const limits = this.walkConfigService.getLimits();
    const overlappingBatch = await manager.getRepository(StepSyncBatch)
      .createQueryBuilder('batch')
      .where('batch.userId = :userId', { userId: session.userId })
      .andWhere('batch.status IN (:...acceptedStatuses)', {
        acceptedStatuses: [StepSyncBatchStatus.Accepted, StepSyncBatchStatus.PartiallyAccepted],
      })
      .andWhere('batch.observedStartedAt < :endedAt', { endedAt })
      .andWhere('batch.observedEndedAt > :startedAt', { startedAt })
      .getOne();
    if (overlappingBatch) {
      throw new BadRequestException('Walk interval overlaps an accepted step-sync batch');
    }

    const stats = await this.getOrCreateDailyStats(manager, session.userId, this.toStatsDate(startedAt));
    const remainingSteps = Math.max(0, limits.dailyStepLimitBase - stats.acceptedSteps);
    const acceptedStepCount = Math.min(input.clientStepCount, remainingSteps);
    const earnedErt = Math.floor((acceptedStepCount * limits.ertPer1000Steps) / 1000);

    stats.acceptedSteps += acceptedStepCount;
    stats.earnedErt += earnedErt;

    session.status = WalkSessionStatus.Accepted;
    session.acceptedStepCount = acceptedStepCount;
    session.earnedErt = earnedErt;

    await manager.getRepository(DailyUserStats).save(stats);
    const savedSession = await manager.getRepository(WalkSession).save(session);

    if (earnedErt > 0) {
      await this.ledgerService.creditInTransaction(manager, {
        userId: session.userId,
        amount: earnedErt,
        type: LedgerTransactionType.WalkReward,
        referenceType: 'walk_session',
        referenceId: session.id,
        metadata: {
          acceptedStepCount,
          clientStepCount: input.clientStepCount,
          statsDate: stats.date,
        },
      });
    }

    return savedSession;
  }

  private async getOrCreateDailyStats(manager: EntityManager, userId: string, date: string) {
    const repository = manager.getRepository(DailyUserStats);
    const existingStats = await repository.findOne({
      where: { userId, date },
      lock: { mode: 'pessimistic_write' },
    });

    if (existingStats) {
      return existingStats;
    }

    return repository.create({
      userId,
      date,
      acceptedSteps: 0,
      earnedErt: 0,
      raffleAttempts: 0,
    });
  }

  private validateFinishInput(input: FinishWalkSessionInput) {
    if (!Number.isInteger(input.clientStepCount) || input.clientStepCount < 0) {
      throw new BadRequestException('clientStepCount must be a non-negative integer');
    }

    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new BadRequestException('durationSeconds must be a positive integer');
    }

    if (!Number.isInteger(input.samplesCount) || input.samplesCount < 0) {
      throw new BadRequestException('samplesCount must be a non-negative integer');
    }

    if (!input.algorithmVersion || typeof input.algorithmVersion !== 'string') {
      throw new BadRequestException('algorithmVersion is required');
    }

    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);

    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      throw new BadRequestException('startedAt and endedAt must be valid dates');
    }

    if (endedAt <= startedAt) {
      throw new BadRequestException('endedAt must be after startedAt');
    }

    if (input.distanceMeters !== undefined && input.distanceMeters !== null && input.distanceMeters < 0) {
      throw new BadRequestException('distanceMeters must be non-negative');
    }
  }

  private validateSessionInterval(session: WalkSession, input: FinishWalkSessionInput) {
    const startedAtMs = new Date(input.startedAt).getTime();
    const endedAtMs = new Date(input.endedAt).getTime();
    if (startedAtMs !== session.startedAt.getTime()) {
      throw new BadRequestException('startedAt must match the server-started session');
    }
    if (endedAtMs > Date.now() + this.walkConfigService.getMaxFutureSkewSeconds() * 1000) {
      throw new BadRequestException('endedAt exceeds the allowed future skew');
    }
    if (input.durationSeconds !== Math.floor((endedAtMs - startedAtMs) / 1000)) {
      throw new BadRequestException('durationSeconds must match the session interval');
    }
  }

  private getRejectionReason(durationSeconds: number, avgSpeedMps: number | null) {
    const limits = this.walkConfigService.getLimits();

    if (durationSeconds < limits.minSessionSeconds) {
      return WalkRejectionReason.SessionTooShort;
    }

    if (durationSeconds > limits.maxSessionDurationSeconds) {
      return WalkRejectionReason.SessionTooLong;
    }

    if (avgSpeedMps !== null && avgSpeedMps > limits.maxAcceptedSpeedMps) {
      return WalkRejectionReason.ImpossibleSpeed;
    }

    return null;
  }

  private toStatsDate(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private androidLegacyPathRetired() {
    return new GoneException({
      message: 'Legacy Android walk submission is retired; use step-sync batches',
      error: 'Gone',
      code: ANDROID_LEGACY_WALK_RETIRED_CODE,
    });
  }
}
