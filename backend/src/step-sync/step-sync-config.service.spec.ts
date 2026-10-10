import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StepSyncConfigService } from './step-sync-config.service';

class FakeConfigService {
  constructor(private readonly values: Record<string, string | number | undefined> = {}) {}

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

describe('StepSyncConfigService', () => {
  it('returns conservative retention and future-skew defaults', () => {
    const service = new StepSyncConfigService(new FakeConfigService() as never);
    assert.deepEqual(service.getPolicy(), {
      retentionSeconds: 604800,
      maxFutureSkewSeconds: 600,
    });
  });

  it('reads positive integer overrides and ignores unsafe values', () => {
    const configured = new StepSyncConfigService(new FakeConfigService({
      STEP_SYNC_RETENTION_SECONDS: '259200',
      STEP_SYNC_MAX_FUTURE_SKEW_SECONDS: '300',
    }) as never);
    assert.deepEqual(configured.getPolicy(), {
      retentionSeconds: 259200,
      maxFutureSkewSeconds: 300,
    });

    const invalid = new StepSyncConfigService(new FakeConfigService({
      STEP_SYNC_RETENTION_SECONDS: '-1',
      STEP_SYNC_MAX_FUTURE_SKEW_SECONDS: '1.5',
    }) as never);
    assert.deepEqual(invalid.getPolicy(), {
      retentionSeconds: 604800,
      maxFutureSkewSeconds: 600,
    });
  });
});
