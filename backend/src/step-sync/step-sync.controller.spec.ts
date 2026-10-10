import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { StepSyncBatchSource } from './step-sync-batch.entity';
import { StepSyncController } from './step-sync.controller';
import { ReceiveStepSyncBatchInput } from './step-sync.service';

const body: ReceiveStepSyncBatchInput = {
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
};

describe('StepSyncController', () => {
  it('passes the authenticated user and body to the receipt service', async () => {
    const calls: unknown[][] = [];
    const expected = { status: 'RECEIVED' };
    const controller = new StepSyncController({
      receiveBatch: async (...args: unknown[]) => {
        calls.push(args);
        return expected;
      },
    } as never);
    const user = { id: 'user-1' } as User;

    assert.equal(await controller.receive({ headers: {}, user }, body), expected);
    assert.deepEqual(calls, [[user, body]]);
  });

  it('fails closed if a request reaches the controller without a user', () => {
    const controller = new StepSyncController({ receiveBatch: async () => ({}) } as never);
    assert.throws(() => controller.receive({ headers: {} }, body), UnauthorizedException);
  });
});
