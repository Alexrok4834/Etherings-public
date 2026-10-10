import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { WalkSession, WalkSessionSource, WalkSessionStatus } from '../walk/walk-session.entity';
import { StepSyncBatch, StepSyncBatchSource, StepSyncBatchStatus } from './step-sync-batch.entity';
import { StepSyncInstallation, StepSyncInstallationStatus } from './step-sync-installation.entity';
import { M2eDailyEconomicSnapshot } from '../m2e/m2e-daily-economic-snapshot.entity';
import { M2E_BALANCE_CONFIG_VERSION, M2E_EARNING_RULES_VERSION } from '../m2e/m2e-balance-config.service';
import { M2eSettlementResult } from '../m2e/m2e-settlement.service';
import {
  ReceiveStepSyncBatchInput,
  StepSyncConflictCode,
  StepSyncResultCode,
  StepSyncService,
} from './step-sync.service';

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonKeys(item)]),
    );
  }
  return value;
}

class FakeInstallationRepository {
  rows: StepSyncInstallation[] = [];
  nextId = 1;

  create(input: Partial<StepSyncInstallation>) {
    return { ...input } as StepSyncInstallation;
  }

  async findOne(options: { where: Partial<StepSyncInstallation> }) {
    return this.rows.find((row) => this.matches(row, options.where)) ?? null;
  }

  async save(row: StepSyncInstallation) {
    if (!row.id) {
      row.id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
      row.createdAt = new Date('2026-08-11T09:00:00.000Z');
    }
    row.updatedAt = new Date('2026-08-11T09:00:01.000Z');
    const index = this.rows.findIndex((candidate) => candidate.id === row.id);
    const saved = { ...row };
    if (index === -1) this.rows.push(saved);
    else this.rows[index] = saved;
    return saved;
  }

  private matches(row: StepSyncInstallation, where: Partial<StepSyncInstallation>) {
    return Object.entries(where).every(([key, value]) => row[key as keyof StepSyncInstallation] === value);
  }
}

class FakeBatchRepository {
  rows: StepSyncBatch[] = [];
  saves = 0;
  nextId = 1;

  create(input: Partial<StepSyncBatch>) {
    return { ...input } as StepSyncBatch;
  }

  async findOne(options: { where: Partial<StepSyncBatch> }) {
    return this.rows.find((row) => this.matches(row, options.where)) ?? null;
  }

  async save(row: StepSyncBatch) {
    this.saves += 1;
    row.id = row.id ?? `10000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    row.createdAt = row.createdAt ?? new Date('2026-08-11T09:00:02.000Z');
    row.updatedAt = new Date('2026-08-11T09:00:02.000Z');
    const saved = { ...row };
    const index = this.rows.findIndex((candidate) => candidate.id === row.id);
    if (index === -1) this.rows.push(saved);
    else this.rows[index] = saved;
    return saved;
  }

  createQueryBuilder() {
    return new FakeBatchQueryBuilder(this.rows);
  }

  private matches(row: StepSyncBatch, where: Partial<StepSyncBatch>) {
    return Object.entries(where).every(([key, value]) => row[key as keyof StepSyncBatch] === value);
  }
}

class FakeBatchQueryBuilder {
  private clauses: string[] = [];
  private parameters: Record<string, unknown> = {};

  constructor(private readonly rows: StepSyncBatch[]) {}

  where(clause: string, parameters: Record<string, unknown>) {
    this.clauses = [clause];
    Object.assign(this.parameters, parameters);
    return this;
  }

  andWhere(clause: string, parameters: Record<string, unknown>) {
    this.clauses.push(clause);
    Object.assign(this.parameters, parameters);
    return this;
  }

  async getOne() {
    const query = this.clauses.join(' ');
    if (query.includes('batch.sequence > :sequence')) {
      return this.rows.find((row) => row.installationRecordId === this.parameters.installationRecordId
        && row.id !== this.parameters.currentBatchId
        && BigInt(row.sequence) > BigInt(this.parameters.sequence as string)) ?? null;
    }
    const statuses = this.parameters.accountedStatuses as StepSyncBatchStatus[];
    const startedAt = this.parameters.observedStartedAt as Date;
    const endedAt = this.parameters.observedEndedAt as Date;
    return this.rows.find((row) => row.userId === this.parameters.userId
      && row.id !== this.parameters.currentBatchId
      && statuses.includes(row.status)
      && row.observedStartedAt < endedAt
      && row.observedEndedAt > startedAt) ?? null;
  }
}

class FakeUserRepository {
  async findOne(options: { where: { id: string } }) {
    return options.where.id === 'user-1' ? user() : null;
  }
}

class FakeWalkSessionRepository {
  rows: WalkSession[] = [];

  createQueryBuilder() {
    return new FakeWalkSessionQueryBuilder(this.rows);
  }
}

class FakeWalkSessionQueryBuilder {
  private parameters: Record<string, unknown> = {};

  constructor(private readonly rows: WalkSession[]) {}

  where(_clause: string, parameters: Record<string, unknown>) {
    Object.assign(this.parameters, parameters);
    return this;
  }

  andWhere(_clause: string, parameters: Record<string, unknown>) {
    Object.assign(this.parameters, parameters);
    return this;
  }

  async getOne() {
    const startedAt = this.parameters.observedStartedAt as Date;
    const endedAt = this.parameters.observedEndedAt as Date;
    return this.rows.find((row) => row.userId === this.parameters.userId
      && row.status === this.parameters.acceptedStatus
      && row.startedAt < endedAt
      && row.endedAt !== null
      && row.endedAt > startedAt) ?? null;
  }
}

class FakeDailyStatsRepository {
  rows: DailyUserStats[] = [];
  nextId = 1;

  create(input: Partial<DailyUserStats>) {
    return { ...input } as DailyUserStats;
  }

  async findOne(options: { where: Partial<DailyUserStats> }) {
    return this.rows.find((row) => Object.entries(options.where)
      .every(([key, value]) => row[key as keyof DailyUserStats] === value)) ?? null;
  }

  async save(row: DailyUserStats) {
    row.id = row.id ?? `stats-${this.nextId++}`;
    row.createdAt = row.createdAt ?? new Date('2026-08-11T09:00:00.000Z');
    row.updatedAt = new Date('2026-08-11T09:00:03.000Z');
    const saved = { ...row };
    const index = this.rows.findIndex((candidate) => candidate.id === row.id);
    if (index === -1) this.rows.push(saved);
    else this.rows[index] = saved;
    return saved;
  }
}

class FakeSnapshotRepository {
  rows: M2eDailyEconomicSnapshot[] = [];

  async findOne(options: { where: Partial<M2eDailyEconomicSnapshot> }) {
    return this.rows.find((row) => Object.entries(options.where)
      .every(([key, value]) => row[key as keyof M2eDailyEconomicSnapshot] === value)) ?? null;
  }
}

class FakeManager {
  readonly users = new FakeUserRepository();
  readonly dailyStats = new FakeDailyStatsRepository();
  readonly walkSessions = new FakeWalkSessionRepository();
  readonly snapshots = new FakeSnapshotRepository();

  constructor(
    readonly installations: FakeInstallationRepository,
    readonly batches: FakeBatchRepository,
  ) {}

  getRepository(entity: unknown) {
    if (entity === StepSyncInstallation) return this.installations;
    if (entity === StepSyncBatch) return this.batches;
    if (entity === User) return this.users;
    if (entity === DailyUserStats) return this.dailyStats;
    if (entity === WalkSession) return this.walkSessions;
    if (entity === M2eDailyEconomicSnapshot) return this.snapshots;
    throw new Error('Unknown repository');
  }

  async query(sql: string, parameters: unknown[]) {
    const [userId, date] = parameters as [string, string];
    if (sql.includes('SELECT id, accepted_steps')) {
      const row = this.dailyStats.rows.find((candidate) => candidate.userId === userId && candidate.date === date);
      return row ? [{ id: row.id, acceptedSteps: row.acceptedSteps, earnedErt: String(row.earnedErt) }] : [];
    }
    if (sql.includes('INSERT INTO daily_user_stats')) {
      const row = await this.dailyStats.save({
        userId,
        date,
        acceptedSteps: 0,
        earnedErt: 0,
        raffleAttempts: 0,
      } as DailyUserStats);
      return [{ id: row.id, acceptedSteps: 0, earnedErt: '0' }];
    }
    if (sql.includes('UPDATE daily_user_stats')) {
      const row = this.dailyStats.rows.find((candidate) => candidate.userId === userId && candidate.date === date);
      if (!row) throw new Error('Missing fake daily stats row');
      row.acceptedSteps = parameters[2] as number;
      row.earnedErt = Number(parameters[3]);
      return [];
    }
    throw new Error(`Unsupported fake query: ${sql}`);
  }
}

class FakeDataSource {
  readonly manager = new FakeManager(new FakeInstallationRepository(), new FakeBatchRepository());
  transactions = 0;
  throwUniqueAfterFirstCommit = false;

  async transaction<T>(callback: (manager: FakeManager) => Promise<T>) {
    this.transactions += 1;
    const installationSnapshot = this.manager.installations.rows.map((row) => ({ ...row }));
    const batchSnapshot = this.manager.batches.rows.map((row) => ({ ...row }));
    const statsSnapshot = this.manager.dailyStats.rows.map((row) => ({ ...row }));
    const walkSnapshot = this.manager.walkSessions.rows.map((row) => ({ ...row }));
    let result: T;
    try {
      result = await callback(this.manager);
    } catch (error) {
      this.manager.installations.rows = installationSnapshot;
      this.manager.batches.rows = batchSnapshot;
      this.manager.dailyStats.rows = statsSnapshot;
      this.manager.walkSessions.rows = walkSnapshot;
      throw error;
    }
    if (this.throwUniqueAfterFirstCommit && this.transactions === 1) {
      throw { code: '23505' };
    }
    return result;
  }
}

function input(overrides: Partial<ReceiveStepSyncBatchInput> = {}): ReceiveStepSyncBatchInput {
  return {
    installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sequence: 1,
    localDate: '2026-08-11',
    timezoneOffsetMinutes: 180,
    observedStartedAt: '2026-08-11T08:00:00.000Z',
    observedEndedAt: '2026-08-11T08:15:00.000Z',
    stepDelta: 100,
    sensorEventCount: 5,
    source: StepSyncBatchSource.AndroidStepCounter,
    algorithmVersion: 'android-step-counter-v1',
    clientMetadata: { model: 'Samsung A8', api: 28 },
    ...overrides,
  };
}

function user() {
  return { id: 'user-1' } as User;
}

function createService(
  m2eEnabled: boolean | ((userId: string) => boolean) = false,
  now = new Date('2026-08-11T09:00:03.000Z'),
) {
  const dataSource = new FakeDataSource();
  const ledgerService = new FakeLedgerService();
  const m2eSnapshotService = new FakeM2eSnapshotService(dataSource.manager.snapshots);
  const m2eSettlementService = new FakeM2eSettlementService();
  const service = new StepSyncService(
    dataSource as never,
    new FakeWalkConfigService() as never,
    ledgerService as never,
    new FakeStepSyncConfigService(now) as never,
    {
      isEarningEnabledForUser: (userId: string) => (
        typeof m2eEnabled === 'function' ? m2eEnabled(userId) : m2eEnabled
      ),
    } as never,
    m2eSnapshotService as never,
    m2eSettlementService as never,
  );
  return { dataSource, ledgerService, m2eSettlementService, service };
}

class FakeM2eSnapshotService {
  private nextId = 1;

  constructor(private readonly repository: FakeSnapshotRepository) {}

  async getOrCreateInTransaction(_manager: unknown, userId: string, accountingDate: string) {
    const existing = await this.repository.findOne({ where: { userId, accountingDate } });
    if (existing) return existing;

    const snapshot = {
      id: `20000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`,
      userId,
      accountingDate,
      selectedRingId: '30000000-0000-4000-8000-000000000001',
      ringCount: 1,
      selectedRingComfort: 20,
      stepCap: 5000,
      rulesVersion: M2E_EARNING_RULES_VERSION,
      balanceConfigVersion: M2E_BALANCE_CONFIG_VERSION,
      baseSteps: 5000,
      extraStepsPerRing: 1000,
      baseErtPer1000Steps: '0.871',
      comfortCurveK: 20,
    } as M2eDailyEconomicSnapshot;
    this.repository.rows.push(snapshot);
    return snapshot;
  }
}

class FakeM2eSettlementService {
  calls = 0;

  async settleInTransaction(_manager: unknown, input: { cumulativeAcceptedSteps: number; snapshot: M2eDailyEconomicSnapshot }) {
    this.calls += 1;
    const result: M2eSettlementResult = {
      snapshotId: input.snapshot.id,
      rulesVersion: M2E_EARNING_RULES_VERSION,
      balanceConfigVersion: M2E_BALANCE_CONFIG_VERSION,
      ringCount: 1,
      selectedRingId: input.snapshot.selectedRingId,
      selectedRingComfort: 20,
      stepCap: 5000,
      cumulativeAcceptedSteps: input.cumulativeAcceptedSteps,
      validSteps: input.cumulativeAcceptedSteps,
      exactNumerator: '13065',
      exactDenominator: '100000',
      comfortMultiplier: '1.5',
      cumulativeAuthoritativeErt: '0.13065',
      cumulativeDisplayedErt: '0.13',
      deltaAuthoritativeErt: '0.13065',
      deltaDisplayedErt: '0.13',
    };
    return result;
  }
}

class FakeWalkConfigService {
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

class FakeStepSyncConfigService {
  constructor(private readonly currentTime = new Date('2026-08-11T09:00:03.000Z')) {}

  getPolicy() {
    return { retentionSeconds: 604800, maxFutureSkewSeconds: 600 };
  }

  now() {
    return this.currentTime;
  }
}

class FakeLedgerService {
  credits: Array<{ amount: number; referenceType?: string | null; referenceId?: string | null }> = [];
  failCredit = false;

  async creditInTransaction(_manager: unknown, input: { amount: number; referenceType?: string | null; referenceId?: string | null }) {
    if (this.failCredit) throw new Error('Injected ledger failure');
    this.credits.push(input);
    return {};
  }
}

function conflictCode(error: unknown) {
  assert.ok(error instanceof ConflictException);
  return (error.getResponse() as { code: string }).code;
}

describe('StepSyncService receipt idempotency', () => {
  it('creates an owner-bound installation and terminal ACCEPTED receipt', async () => {
    const { dataSource, ledgerService, service } = createService();

    const response = await service.receiveBatch(user(), input());

    assert.deepEqual(response, {
      batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: 1,
      status: StepSyncBatchStatus.Accepted,
      acceptedStepDelta: 100,
      earnedErtDelta: 1,
      earnedErtDeltaExact: '1',
      earnedErtDeltaDisplay: '1.00',
      dailyStepCap: 5000,
      accountingDate: '2026-08-11',
      resultCode: StepSyncResultCode.Accepted,
      receivedAt: '2026-08-11T09:00:02.000Z',
      processedAt: '2026-08-11T09:00:03.000Z',
      rulesVersion: null,
      balanceConfigVersion: null,
    });
    assert.equal(dataSource.manager.installations.rows[0].userId, 'user-1');
    assert.equal(dataSource.manager.batches.rows[0].claimedStepCount, 100);
    assert.equal(dataSource.manager.batches.rows[0].payloadHash.length, 64);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
    assert.equal(ledgerService.credits.length, 1);
  });

  it('returns the same receipt for an identical retry without another batch insert', async () => {
    const { dataSource, service } = createService();
    const first = await service.receiveBatch(user(), input());
    const second = await service.receiveBatch(user(), input());

    assert.deepEqual(second, first);
    assert.equal(dataSource.manager.batches.saves, 2);
  });

  it('canonicalizes metadata key order before hashing', async () => {
    const { dataSource, service } = createService();
    const first = await service.receiveBatch(user(), input({ clientMetadata: { z: 1, a: { y: 2, x: 3 } } }));
    const second = await service.receiveBatch(user(), input({ clientMetadata: { a: { x: 3, y: 2 }, z: 1 } }));

    assert.deepEqual(second, first);
    assert.equal(dataSource.manager.batches.saves, 2);
  });

  it('rejects the same batch identity with a different payload', async () => {
    const { service } = createService();
    await service.receiveBatch(user(), input());

    await assert.rejects(
      () => service.receiveBatch(user(), input({ stepDelta: 101 })),
      (error) => conflictCode(error) === StepSyncConflictCode.IdempotencyConflict,
    );
  });

  it('rejects sequence reuse by a different batch', async () => {
    const { service } = createService();
    await service.receiveBatch(user(), input());

    await assert.rejects(
      () => service.receiveBatch(user(), input({ batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })),
      (error) => conflictCode(error) === StepSyncConflictCode.SequenceConflict,
    );
  });

  it('rejects a revoked installation', async () => {
    const { dataSource, service } = createService();
    await dataSource.manager.installations.save({
      userId: 'user-1',
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: StepSyncInstallationStatus.Revoked,
      revokedAt: new Date('2026-08-11T08:00:00.000Z'),
      lastSeenAt: null,
    } as StepSyncInstallation);

    await assert.rejects(() => service.receiveBatch(user(), input()), ForbiddenException);
  });

  it('adds the decimal compatibility contract to a previously stored terminal response snapshot', async () => {
    const { dataSource, service } = createService();
    await service.receiveBatch(user(), input());
    const expected = {
      batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: 1,
      status: StepSyncBatchStatus.Accepted,
      acceptedStepDelta: 100,
      earnedErtDelta: 1,
      accountingDate: '2026-08-11',
      resultCode: 'ACCEPTED',
      receivedAt: '2026-08-11T09:00:02.000Z',
      processedAt: '2026-08-11T09:00:03.000Z',
    };
    dataSource.manager.batches.rows[0].resultSnapshot = expected;

    assert.deepEqual(await service.receiveBatch(user(), input()), {
      ...expected,
      earnedErtDeltaExact: '1',
      earnedErtDeltaDisplay: '1.00',
      dailyStepCap: null,
      rulesVersion: null,
      balanceConfigVersion: null,
    });
  });

  it('re-reads the winning receipt after a concurrent unique violation', async () => {
    const { dataSource, service } = createService();
    dataSource.throwUniqueAfterFirstCommit = true;

    const response = await service.receiveBatch(user(), input());

    assert.equal(response.status, StepSyncBatchStatus.Accepted);
    assert.equal(dataSource.transactions, 2);
    assert.equal(dataSource.manager.batches.saves, 2);
  });
});

describe('StepSyncService daily accounting', () => {
  it('persists exact M2E settlement evidence only when the activation gate is enabled', async () => {
    const { dataSource, ledgerService, m2eSettlementService, service } = createService(true);

    const response = await service.receiveBatch(user(), input());
    const storedBatch = dataSource.manager.batches.rows[0];

    assert.equal(response.earnedErtDelta, 0.13065);
    assert.equal(response.earnedErtDeltaExact, '0.13065');
    assert.equal(response.earnedErtDeltaDisplay, '0.13');
    assert.equal(response.dailyStepCap, 5000);
    assert.equal(response.rulesVersion, M2E_EARNING_RULES_VERSION);
    assert.equal(response.balanceConfigVersion, 'move-to-earn-balance-v1');
    assert.equal(response.m2eSettlement?.deltaAuthoritativeErt, '0.13065');
    assert.equal(response.m2eSettlement?.cumulativeDisplayedErt, '0.13');
    assert.equal(storedBatch.earnedErtDelta, '0.13065');
    assert.equal(storedBatch.m2eDailySnapshotId, '20000000-0000-4000-8000-000000000001');
    assert.deepEqual(storedBatch.resultSnapshot, response);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
    assert.equal(dataSource.manager.dailyStats.rows[0].earnedErt, 0.13065);
    assert.equal(m2eSettlementService.calls, 1);
    assert.equal(ledgerService.credits.length, 0, 'legacy ledger path must remain unused');
  });

  it('keeps an owner outside the active canary scope on legacy accounting', async () => {
    const { dataSource, ledgerService, m2eSettlementService, service } = createService(
      (userId) => userId === 'listed-user',
    );

    const response = await service.receiveBatch(user(), input());

    assert.equal(response.m2eSettlement == null, true);
    assert.equal(response.rulesVersion == null, true);
    assert.equal(response.dailyStepCap, 5000);
    assert.equal(dataSource.manager.snapshots.rows.length, 0);
    assert.equal(m2eSettlementService.calls, 0);
    assert.equal(ledgerService.credits.length, 1);
  });

  it('returns stored M2E settlement evidence on retry without settling again', async () => {
    const { dataSource, m2eSettlementService, service } = createService(true);

    const first = await service.receiveBatch(user(), input());
    dataSource.manager.batches.rows[0].resultSnapshot = sortJsonKeys(
      dataSource.manager.batches.rows[0].resultSnapshot,
    ) as Record<string, unknown>;
    const second = await service.receiveBatch(user(), input());

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(m2eSettlementService.calls, 1);
    assert.equal(dataSource.manager.batches.rows.length, 1);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
  });

  it('returns the frozen M2E cap and zero exact delta after that cap is exhausted', async () => {
    const { service } = createService(true);
    await service.receiveBatch(user(), input({ stepDelta: 5000 }));

    const response = await service.receiveBatch(user(), input({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 2,
      observedStartedAt: '2026-08-11T08:15:00.000Z',
      observedEndedAt: '2026-08-11T08:30:00.000Z',
      stepDelta: 1,
    }));

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.resultCode, StepSyncResultCode.DailyCapReached);
    assert.equal(response.earnedErtDelta, 0);
    assert.equal(response.earnedErtDeltaExact, '0');
    assert.equal(response.earnedErtDeltaDisplay, '0.00');
    assert.equal(response.dailyStepCap, 5000);
    assert.equal(response.rulesVersion, M2E_EARNING_RULES_VERSION);
    assert.equal(response.balanceConfigVersion, M2E_BALANCE_CONFIG_VERSION);
  });

  it('fails closed when M2E is enabled after legacy accounting started for the date', async () => {
    const { dataSource, service } = createService(true);
    await dataSource.manager.dailyStats.save({
      userId: 'user-1',
      date: '2026-08-11',
      acceptedSteps: 100,
      earnedErt: 1,
      raffleAttempts: 0,
    } as DailyUserStats);

    await assert.rejects(
      () => service.receiveBatch(user(), input()),
      (error) => conflictCode(error) === StepSyncConflictCode.M2eActivationDateConflict,
    );
    assert.equal(dataSource.manager.batches.rows.length, 0);
  });

  it('starts an independent immutable M2E accounting context after local-day rollover', async () => {
    const { dataSource, m2eSettlementService, service } = createService(
      true,
      new Date('2026-08-12T09:00:03.000Z'),
    );

    const firstDay = await service.receiveBatch(user(), input());
    const secondDay = await service.receiveBatch(user(), input({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 2,
      localDate: '2026-08-12',
      observedStartedAt: '2026-08-12T08:00:00.000Z',
      observedEndedAt: '2026-08-12T08:15:00.000Z',
    }));

    assert.equal(firstDay.accountingDate, '2026-08-11');
    assert.equal(secondDay.accountingDate, '2026-08-12');
    assert.notEqual(firstDay.m2eSettlement?.snapshotId, secondDay.m2eSettlement?.snapshotId);
    assert.deepEqual(
      dataSource.manager.dailyStats.rows.map((row) => [row.date, row.acceptedSteps]),
      [['2026-08-11', 100], ['2026-08-12', 100]],
    );
    assert.deepEqual(
      dataSource.manager.snapshots.rows.map((row) => row.accountingDate),
      ['2026-08-11', '2026-08-12'],
    );
    assert.equal(m2eSettlementService.calls, 2);
  });

  it('calculates ERT from cumulative daily steps without per-batch rounding loss', async () => {
    const { dataSource, ledgerService, service } = createService();

    const first = await service.receiveBatch(user(), input({ stepDelta: 69 }));
    const second = await service.receiveBatch(user(), input({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 2,
      observedStartedAt: '2026-08-11T08:15:00.000Z',
      observedEndedAt: '2026-08-11T08:30:00.000Z',
      stepDelta: 69,
    }));

    assert.equal(first.earnedErtDelta, 0);
    assert.equal(second.earnedErtDelta, 1);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 138);
    assert.equal(dataSource.manager.dailyStats.rows[0].earnedErt, 1);
    assert.deepEqual(ledgerService.credits.map((credit) => credit.amount), [1]);
  });

  it('partially accepts only the remaining global daily allowance', async () => {
    const { dataSource, ledgerService, service } = createService();
    await dataSource.manager.dailyStats.save({
      userId: 'user-1',
      date: '2026-08-11',
      acceptedSteps: 4950,
      earnedErt: 49,
      raffleAttempts: 0,
    } as DailyUserStats);

    const response = await service.receiveBatch(user(), input());

    assert.equal(response.status, StepSyncBatchStatus.PartiallyAccepted);
    assert.equal(response.acceptedStepDelta, 50);
    assert.equal(response.earnedErtDelta, 1);
    assert.equal(response.resultCode, StepSyncResultCode.PartiallyAccepted);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 5000);
    assert.deepEqual(ledgerService.credits.map((credit) => credit.amount), [1]);
  });

  it('terminally rejects a batch when the daily cap is already exhausted', async () => {
    const { dataSource, ledgerService, service } = createService();
    await dataSource.manager.dailyStats.save({
      userId: 'user-1',
      date: '2026-08-11',
      acceptedSteps: 5000,
      earnedErt: 50,
      raffleAttempts: 0,
    } as DailyUserStats);

    const response = await service.receiveBatch(user(), input());

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.acceptedStepDelta, 0);
    assert.equal(response.earnedErtDelta, 0);
    assert.equal(response.earnedErtDeltaExact, '0');
    assert.equal(response.earnedErtDeltaDisplay, '0.00');
    assert.equal(response.dailyStepCap, 5000);
    assert.equal(response.resultCode, StepSyncResultCode.DailyCapReached);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('catches up only the missing cumulative daily reward', async () => {
    const { dataSource, ledgerService, service } = createService();
    await dataSource.manager.dailyStats.save({
      userId: 'user-1',
      date: '2026-08-11',
      acceptedSteps: 999,
      earnedErt: 9,
      raffleAttempts: 0,
    } as DailyUserStats);

    const response = await service.receiveBatch(user(), input({ stepDelta: 1 }));

    assert.equal(response.earnedErtDelta, 1);
    assert.equal(dataSource.manager.dailyStats.rows[0].earnedErt, 10);
    assert.deepEqual(ledgerService.credits.map((credit) => credit.amount), [1]);
  });

  it('rolls back receipt and daily stats when ledger credit fails', async () => {
    const { dataSource, ledgerService, service } = createService();
    ledgerService.failCredit = true;

    await assert.rejects(() => service.receiveBatch(user(), input()), /Injected ledger failure/);
    assert.equal(dataSource.manager.installations.rows.length, 0);
    assert.equal(dataSource.manager.batches.rows.length, 0);
    assert.equal(dataSource.manager.dailyStats.rows.length, 0);
  });

  it('terminally rejects a replayed overlapping interval under a new batch identity', async () => {
    const { dataSource, service } = createService();
    await service.receiveBatch(user(), input());

    const response = await service.receiveBatch(user(), input({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 2,
    }));

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.resultCode, StepSyncResultCode.OverlappingInterval);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
  });

  it('terminally rejects an interval already accepted by the retired walk path', async () => {
    const { dataSource, ledgerService, service } = createService();
    dataSource.manager.walkSessions.rows.push({
      id: 'legacy-session',
      userId: 'user-1',
      status: WalkSessionStatus.Accepted,
      startedAt: new Date('2026-08-11T07:55:00.000Z'),
      endedAt: new Date('2026-08-11T08:05:00.000Z'),
      source: WalkSessionSource.AndroidStepCounter,
    } as WalkSession);

    const response = await service.receiveBatch(user(), input());

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.resultCode, StepSyncResultCode.OverlappingInterval);
    assert.equal(dataSource.manager.dailyStats.rows.length, 0);
    assert.deepEqual(ledgerService.credits, []);
  });

  it('detects overlap across two installations owned by the same user', async () => {
    const { dataSource, service } = createService();
    await service.receiveBatch(user(), input());

    const response = await service.receiveBatch(user(), input({
      installationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 1,
    }));

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.resultCode, StepSyncResultCode.OverlappingInterval);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
  });

  it('terminally rejects an older sequence received after a newer one', async () => {
    const { dataSource, service } = createService();
    await service.receiveBatch(user(), input({ sequence: 2 }));

    const response = await service.receiveBatch(user(), input({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sequence: 1,
      observedStartedAt: '2026-08-11T08:15:00.000Z',
      observedEndedAt: '2026-08-11T08:30:00.000Z',
    }));

    assert.equal(response.status, StepSyncBatchStatus.Rejected);
    assert.equal(response.resultCode, StepSyncResultCode.SequenceOutOfOrder);
    assert.equal(dataSource.manager.dailyStats.rows[0].acceptedSteps, 100);
  });
});

describe('StepSyncService terminal time policy', () => {
  const cases: Array<[StepSyncResultCode, Partial<ReceiveStepSyncBatchInput>]> = [
    [StepSyncResultCode.ExpiredBatch, {
      observedStartedAt: '2026-08-04T08:59:59.000Z',
      observedEndedAt: '2026-08-04T09:14:59.000Z',
      localDate: '2026-08-04',
    }],
    [StepSyncResultCode.FutureTimestamp, {
      observedStartedAt: '2026-08-11T09:00:01.000Z',
      observedEndedAt: '2026-08-11T09:10:04.000Z',
    }],
    [StepSyncResultCode.LocalDateMismatch, { localDate: '2026-08-10' }],
  ];

  for (const [resultCode, overrides] of cases) {
    it(`stores ${resultCode} as a terminal rejection without accounting`, async () => {
      const { dataSource, ledgerService, service } = createService();

      const response = await service.receiveBatch(user(), input(overrides));

      assert.equal(response.status, StepSyncBatchStatus.Rejected);
      assert.equal(response.resultCode, resultCode);
      assert.equal(response.acceptedStepDelta, 0);
      assert.equal(dataSource.manager.dailyStats.rows.length, 0);
      assert.deepEqual(ledgerService.credits, []);
      assert.deepEqual(await service.receiveBatch(user(), input(overrides)), response);
    });
  }
});

describe('StepSyncService request bounds', () => {
  const invalidCases: Array<[string, Partial<ReceiveStepSyncBatchInput>]> = [
    ['installation UUID', { installationId: 'not-a-uuid' }],
    ['batch UUID', { batchId: 'not-a-uuid' }],
    ['unsafe sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['calendar date', { localDate: '2026-02-30' }],
    ['timezone', { timezoneOffsetMinutes: 1081 }],
    ['timestamp offset', { observedStartedAt: '2026-08-11T08:00:00' }],
    ['timestamp calendar date', { observedStartedAt: '2026-02-30T08:00:00.000Z' }],
    ['positive interval', { observedEndedAt: '2026-08-11T08:00:00.000Z' }],
    ['interval maximum', { observedEndedAt: '2026-08-12T08:00:00.001Z' }],
    ['step maximum', { stepDelta: 100_001 }],
    ['sensor events', { sensorEventCount: 0 }],
    ['source', { source: 'accelerometer' }],
    ['algorithm identifier', { algorithmVersion: 'bad version' }],
    ['metadata type', { clientMetadata: [] }],
    ['metadata size', { clientMetadata: { value: 'x'.repeat(5000) } }],
  ];

  for (const [name, overrides] of invalidCases) {
    it(`rejects invalid ${name}`, async () => {
      const { service } = createService();
      await assert.rejects(() => service.receiveBatch(user(), input(overrides)), BadRequestException);
    });
  }

  it('rejects unknown fields instead of silently changing the hash contract', async () => {
    const { service } = createService();
    const body = { ...input(), unexpected: true } as ReceiveStepSyncBatchInput;
    await assert.rejects(() => service.receiveBatch(user(), body), BadRequestException);
  });
});
