import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { DailyUserStats } from './daily-user-stats.entity';
import { WalkConfigService } from './walk-config.service';
import { WalkSession, WalkSessionSource, WalkSessionStatus } from './walk-session.entity';

function tableFor(target: Function) {
  return getMetadataArgsStorage().tables.find((table) => table.target === target);
}

function columnsFor(target: Function) {
  return getMetadataArgsStorage().columns.filter((column) => column.target === target);
}

function indexFor(target: Function, properties: string[]) {
  return getMetadataArgsStorage().indices.find(
    (index) => index.target === target && JSON.stringify(index.columns) === JSON.stringify(properties),
  );
}

class FakeConfigService {
  constructor(private readonly values: Record<string, string | number | undefined> = {}) {}

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

describe('walk schema and config', () => {
  it('maps WalkSession to walk_sessions with required fields', () => {
    assert.equal(tableFor(WalkSession)?.name, 'walk_sessions');

    const databaseNames = columnsFor(WalkSession).map((column) => column.options.name ?? column.propertyName);

    assert.deepEqual(databaseNames.sort(), [
      'accepted_step_count',
      'avg_speed_mps',
      'client_step_count',
      'created_at',
      'distance_meters',
      'duration_seconds',
      'earned_ert',
      'ended_at',
      'id',
      'raw_summary',
      'rejection_reason',
      'source',
      'started_at',
      'status',
      'user_id',
    ].sort());
  });

  it('defines all MVP walk session statuses and sources', () => {
    assert.deepEqual(Object.values(WalkSessionStatus).sort(), ['ACCEPTED', 'REJECTED', 'STARTED', 'SUBMITTED'].sort());
    assert.deepEqual(Object.values(WalkSessionSource).sort(), ['android_step_counter', 'telegram_accelerometer'].sort());
  });

  it('maps DailyUserStats to daily_user_stats with unique user/date index', () => {
    assert.equal(tableFor(DailyUserStats)?.name, 'daily_user_stats');

    const databaseNames = columnsFor(DailyUserStats).map((column) => column.options.name ?? column.propertyName);

    assert.deepEqual(databaseNames.sort(), [
      'accepted_steps',
      'created_at',
      'date',
      'earned_ert',
      'id',
      'raffle_attempts',
      'updated_at',
      'user_id',
    ].sort());
    assert.equal(indexFor(DailyUserStats, ['userId', 'date'])?.unique, true);
  });

  it('returns default walk limits', () => {
    const service = new WalkConfigService(new FakeConfigService() as never);

    assert.deepEqual(service.getLimits(), {
      dailyStepLimitBase: 5000,
      ertPer1000Steps: 10,
      minSessionSeconds: 30,
      maxAcceptedSpeedMps: 3.5,
      maxSessionDurationSeconds: 604800,
    });
  });

  it('reads configured walk limits and ignores invalid values', () => {
    const service = new WalkConfigService(new FakeConfigService({
      WALK_DAILY_STEP_LIMIT_BASE: '8000',
      WALK_ERT_PER_1000_STEPS: '12',
      WALK_MIN_SESSION_SECONDS: '45',
      WALK_MAX_ACCEPTED_SPEED_MPS: '4.25',
      WALK_MAX_SESSION_DURATION_SECONDS: '259200',
    }) as never);

    assert.deepEqual(service.getLimits(), {
      dailyStepLimitBase: 8000,
      ertPer1000Steps: 12,
      minSessionSeconds: 45,
      maxAcceptedSpeedMps: 4.25,
      maxSessionDurationSeconds: 259200,
    });
  });
});
