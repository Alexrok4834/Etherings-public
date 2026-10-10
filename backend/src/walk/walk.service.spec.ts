import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { StepSyncBatch } from '../step-sync/step-sync-batch.entity';
import { DailyUserStats } from './daily-user-stats.entity';
import { WalkSession, WalkSessionSource, WalkSessionStatus } from './walk-session.entity';
import {
  ANDROID_LEGACY_WALK_RETIRED_CODE,
  FinishWalkSessionInput,
  WalkRejectionReason,
  WalkService,
} from './walk.service';

type CreditCall = {
  userId: string;
  amount: number;
  type: LedgerTransactionType;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

class FakeWalkSessionRepository {
  sessions = new Map<string, WalkSession>();
  nextId = 1;

  create(input: Partial<WalkSession>) {
    return { ...input, startedAt: new Date('2026-06-20T10:00:00.000Z') } as WalkSession;
  }

  async save(session: WalkSession) {
    session.id = session.id ?? `session-${this.nextId++}`;
    session.createdAt = session.createdAt ?? new Date('2026-06-20T00:00:00.000Z');
    this.sessions.set(session.id, { ...session });
    return this.sessions.get(session.id) as WalkSession;
  }

  async findOne(options: { where: { id: string } }) {
    return this.sessions.get(options.where.id) ?? null;
  }

  async find(options: { where: { userId: string }; order: { createdAt: 'DESC' }; take: number }) {
    return Array.from(this.sessions.values())
      .filter((session) => session.userId === options.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, options.take);
  }
}

class FakeDailyUserStatsRepository {
  stats = new Map<string, DailyUserStats>();
  nextId = 1;

  create(input: Partial<DailyUserStats>) {
    return { ...input } as DailyUserStats;
  }

  async findOne(options: { where: { userId: string; date: string } }) {
    return this.stats.get(this.key(options.where.userId, options.where.date)) ?? null;
  }

  async save(stats: DailyUserStats) {
    stats.id = stats.id ?? `stats-${this.nextId++}`;
    stats.createdAt = stats.createdAt ?? new Date('2026-06-20T00:00:00.000Z');
    stats.updatedAt = new Date('2026-06-20T00:00:01.000Z');
    this.stats.set(this.key(stats.userId, stats.date), { ...stats });
    return this.stats.get(this.key(stats.userId, stats.date)) as DailyUserStats;
  }

  private key(userId: string, date: string) {
    return `${userId}:${date}`;
  }
}

class FakeEntityManager {
  userLocks = 0;
  overlappingBatch = false;

  constructor(
    private readonly walkSessionRepository: FakeWalkSessionRepository,
    private readonly dailyUserStatsRepository: FakeDailyUserStatsRepository,
  ) {}

  getRepository(entity: unknown) {
    if (entity === User) {
      return {
        findOne: async () => {
          this.userLocks += 1;
          return createUser();
        },
      };
    }

    if (entity === WalkSession) {
      return this.walkSessionRepository;
    }

    if (entity === DailyUserStats) {
      return this.dailyUserStatsRepository;
    }

    if (entity === StepSyncBatch) {
      const manager = this;
      return {
        createQueryBuilder: () => ({
          where() { return this; },
          andWhere() { return this; },
          async getOne() { return manager.overlappingBatch ? {} : null; },
        }),
      };
    }

    throw new Error('Unknown repository');
  }
}

class FakeDataSource {
  manager: FakeEntityManager;
  transactions = 0;

  constructor(walkSessionRepository: FakeWalkSessionRepository, dailyUserStatsRepository: FakeDailyUserStatsRepository) {
    this.manager = new FakeEntityManager(walkSessionRepository, dailyUserStatsRepository);
  }

  async transaction<T>(callback: (manager: FakeEntityManager) => Promise<T>) {
    this.transactions += 1;
    return callback(this.manager);
  }
}

class FakeWalkConfigService {
  getMaxFutureSkewSeconds() { return 600; }

  getLimits() {
    return {
      dailyStepLimitBase: 5000,
      ertPer1000Steps: 10,
      minSessionSeconds: 30,
      maxAcceptedSpeedMps: 3.5,
      maxSessionDurationSeconds: 604800,
    };
  }
}

class FakeLedgerService {
  credits: CreditCall[] = [];

  async creditInTransaction(_manager: unknown, input: CreditCall) {
    this.credits.push(input);
    return {};
  }
}

function createUser(id = 'user-1') {
  return { id } as User;
}

function createService() {
  const repository = new FakeWalkSessionRepository();
  const dailyStatsRepository = new FakeDailyUserStatsRepository();
  const dataSource = new FakeDataSource(repository, dailyStatsRepository);
  const ledgerService = new FakeLedgerService();
  const service = new WalkService(
    repository as never,
    new FakeWalkConfigService() as never,
    dataSource as never,
    ledgerService as never,
  );

  return { dailyStatsRepository, dataSource, ledgerService, repository, service };
}

function finishInput(overrides: Partial<FinishWalkSessionInput> = {}): FinishWalkSessionInput {
  return {
    clientStepCount: 1200,
    startedAt: '2026-06-20T10:00:00.000Z',
    endedAt: '2026-06-20T10:12:00.000Z',
    durationSeconds: 720,
    distanceMeters: 900,
    samplesCount: 60,
    algorithmVersion: 'mvp-v1',
    ...overrides,
  };
}

describe('WalkService lifecycle', () => {
  it('starts a walk session for the current user', async () => {
    const { service } = createService();

    const session = await service.startSession(createUser());

    assert.equal(session.id, 'session-1');
    assert.equal(session.userId, 'user-1');
    assert.equal(session.status, WalkSessionStatus.Started);
    assert.equal(session.source, WalkSessionSource.TelegramAccelerometer);
    assert.equal(session.endedAt, null);
    assert.equal(session.clientStepCount, null);
    assert.equal(session.earnedErt, 0);
  });

  it('retires creation of legacy native Android walk sessions with a stable code', () => {
    const { repository, service } = createService();

    assert.throws(
      () => service.startSession(createUser(), { source: WalkSessionSource.AndroidStepCounter }),
      (error: unknown) => {
        assert.ok(error instanceof GoneException);
        assert.equal((error.getResponse() as { code?: string }).code, ANDROID_LEGACY_WALK_RETIRED_CODE);
        return true;
      },
    );
    assert.equal(repository.sessions.size, 0);
  });

  it('rejects an unsupported walk session source', async () => {
    const { service } = createService();

    assert.throws(
      () => service.startSession(createUser(), { source: 'unknown_client' }),
      BadRequestException,
    );
  });

  it('finishes an owned valid session as accepted and credits ERT', async () => {
    const { dailyStatsRepository, dataSource, ledgerService, service } = createService();
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(createUser(), started.id, finishInput());

    assert.equal(finished.status, WalkSessionStatus.Accepted);
    assert.equal(finished.clientStepCount, 1200);
    assert.equal(finished.acceptedStepCount, 1200);
    assert.equal(finished.durationSeconds, 720);
    assert.equal(finished.distanceMeters, 900);
    assert.equal(finished.avgSpeedMps, 1.25);
    assert.equal(finished.rejectionReason, null);
    assert.equal(finished.earnedErt, 12);
    assert.deepEqual(finished.rawSummary, finishInput());

    const stats = await dailyStatsRepository.findOne({ where: { userId: 'user-1', date: '2026-06-20' } });
    assert.equal(stats?.acceptedSteps, 1200);
    assert.equal(stats?.earnedErt, 12);
    assert.equal(stats?.raffleAttempts, 0);
    assert.deepEqual(ledgerService.credits, [
      {
        userId: 'user-1',
        amount: 12,
        type: LedgerTransactionType.WalkReward,
        referenceType: 'walk_session',
        referenceId: started.id,
        metadata: {
          acceptedStepCount: 1200,
          clientStepCount: 1200,
          statsDate: '2026-06-20',
        },
      },
    ]);
    assert.equal(dataSource.manager.userLocks, 1);
  });

  it('rejects a claimed start date, inconsistent duration and accepted step-sync overlap', async () => {
    const { dataSource, ledgerService, service } = createService();
    const started = await service.startSession(createUser());
    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput({ startedAt: '2026-06-19T10:00:00.000Z' })),
      BadRequestException,
    );
    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput({ durationSeconds: 60 })),
      BadRequestException,
    );
    dataSource.manager.overlappingBatch = true;
    await assert.rejects(() => service.finishSession(createUser(), started.id, finishInput()), BadRequestException);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('uses floor earning formula for non-round step counts', async () => {
    const { dailyStatsRepository, ledgerService, service } = createService();
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(createUser(), started.id, finishInput({ clientStepCount: 1999 }));

    assert.equal(finished.status, WalkSessionStatus.Accepted);
    assert.equal(finished.acceptedStepCount, 1999);
    assert.equal(finished.earnedErt, 19);

    const stats = await dailyStatsRepository.findOne({ where: { userId: 'user-1', date: '2026-06-20' } });
    assert.equal(stats?.acceptedSteps, 1999);
    assert.equal(stats?.earnedErt, 19);
    assert.equal(ledgerService.credits[0].amount, 19);
    assert.deepEqual(ledgerService.credits[0].metadata, {
      acceptedStepCount: 1999,
      clientStepCount: 1999,
      statsDate: '2026-06-20',
    });
  });
  it('caps accepted steps by remaining daily limit', async () => {
    const { dailyStatsRepository, ledgerService, service } = createService();
    await dailyStatsRepository.save({
      userId: 'user-1',
      date: '2026-06-20',
      acceptedSteps: 4800,
      earnedErt: 48,
      raffleAttempts: 0,
    } as DailyUserStats);
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(createUser(), started.id, finishInput({ clientStepCount: 1200 }));

    assert.equal(finished.status, WalkSessionStatus.Accepted);
    assert.equal(finished.acceptedStepCount, 200);
    assert.equal(finished.earnedErt, 2);

    const stats = await dailyStatsRepository.findOne({ where: { userId: 'user-1', date: '2026-06-20' } });
    assert.equal(stats?.acceptedSteps, 5000);
    assert.equal(stats?.earnedErt, 50);
    assert.equal(ledgerService.credits[0].amount, 2);
  });

  it('does not credit ledger when daily cap leaves zero accepted steps', async () => {
    const { dailyStatsRepository, ledgerService, service } = createService();
    await dailyStatsRepository.save({
      userId: 'user-1',
      date: '2026-06-20',
      acceptedSteps: 5000,
      earnedErt: 50,
      raffleAttempts: 0,
    } as DailyUserStats);
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(createUser(), started.id, finishInput({ clientStepCount: 1200 }));

    assert.equal(finished.status, WalkSessionStatus.Accepted);
    assert.equal(finished.acceptedStepCount, 0);
    assert.equal(finished.earnedErt, 0);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('stores short sessions as rejected without daily stats or ledger credit', async () => {
    const { dailyStatsRepository, ledgerService, service } = createService();
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(
      createUser(),
      started.id,
      finishInput({ durationSeconds: 20, endedAt: '2026-06-20T10:00:20.000Z', distanceMeters: 15 }),
    );

    assert.equal(finished.status, WalkSessionStatus.Rejected);
    assert.equal(finished.rejectionReason, WalkRejectionReason.SessionTooShort);
    assert.equal(finished.acceptedStepCount, null);
    assert.equal(finished.earnedErt, 0);
    assert.equal(dailyStatsRepository.stats.size, 0);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('stores impossible-speed sessions as rejected', async () => {
    const { service } = createService();
    const started = await service.startSession(createUser());

    const finished = await service.finishSession(
      createUser(),
      started.id,
      finishInput({ durationSeconds: 120, endedAt: '2026-06-20T10:02:00.000Z', distanceMeters: 600 }),
    );

    assert.equal(finished.status, WalkSessionStatus.Rejected);
    assert.equal(finished.avgSpeedMps, 5);
    assert.equal(finished.rejectionReason, WalkRejectionReason.ImpossibleSpeed);
    assert.equal(finished.earnedErt, 0);
  });

  it('terminally rejects an already-started legacy Android session without accounting', async () => {
    const { dailyStatsRepository, dataSource, ledgerService, repository, service } = createService();
    const started = await repository.save({
      userId: createUser().id,
      status: WalkSessionStatus.Started,
      startedAt: new Date('2026-06-20T10:00:00.000Z'),
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
    } as WalkSession);

    const finished = await service.finishSession(
      createUser(),
      started.id,
      finishInput({
        clientStepCount: 3042,
        durationSeconds: 32347,
        endedAt: '2026-06-20T18:59:07.000Z',
        distanceMeters: null,
        algorithmVersion: 'android-step-counter-v1',
      }),
    );

    assert.equal(finished.status, WalkSessionStatus.Rejected);
    assert.equal(finished.rejectionReason, WalkRejectionReason.AndroidLegacyPathRetired);
    assert.equal(finished.acceptedStepCount, 0);
    assert.equal(finished.earnedErt, 0);
    assert.equal(dailyStatsRepository.stats.size, 0);
    assert.equal(dataSource.manager.userLocks, 0);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('rejects finishing another user session', async () => {
    const { service } = createService();
    const started = await service.startSession(createUser('owner'));

    await assert.rejects(
      () => service.finishSession(createUser('other'), started.id, finishInput()),
      ForbiddenException,
    );
  });

  it('rejects finishing a missing session', async () => {
    const { service } = createService();

    await assert.rejects(
      () => service.finishSession(createUser(), 'missing', finishInput()),
      NotFoundException,
    );
  });

  it('rejects finishing a session twice', async () => {
    const { service } = createService();
    const started = await service.startSession(createUser());

    await service.finishSession(createUser(), started.id, finishInput());

    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput()),
      BadRequestException,
    );
  });

  it('lists only current user sessions', async () => {
    const { service } = createService();
    const ownSession = await service.startSession(createUser('user-1'));
    await service.startSession(createUser('user-2'));

    const sessions = await service.listSessions(createUser('user-1'));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, ownSession.id);
  });

  it('validates required finish body fields', async () => {
    const { service } = createService();
    const started = await service.startSession(createUser());

    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput({ durationSeconds: 0 })),
      BadRequestException,
    );
    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput({ endedAt: 'bad-date' })),
      BadRequestException,
    );
    await assert.rejects(
      () => service.finishSession(createUser(), started.id, finishInput({ distanceMeters: -1 })),
      BadRequestException,
    );
  });
});
