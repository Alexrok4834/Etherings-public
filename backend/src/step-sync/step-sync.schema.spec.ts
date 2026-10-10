import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { StepSyncBatch, StepSyncBatchSource, StepSyncBatchStatus } from './step-sync-batch.entity';
import { StepSyncInstallation, StepSyncInstallationStatus } from './step-sync-installation.entity';

function databaseColumnsFor(target: Function) {
  return getMetadataArgsStorage()
    .columns.filter((column) => column.target === target)
    .map((column) => column.options.name ?? column.propertyName);
}

function uniqueIndexFor(target: Function, properties: string[]) {
  return getMetadataArgsStorage().indices.find(
    (index) => index.target === target
      && index.unique === true
      && JSON.stringify(index.columns) === JSON.stringify(properties),
  );
}

describe('step sync schema', () => {
  it('maps owner-bound installations and their lifecycle fields', () => {
    const table = getMetadataArgsStorage().tables.find((entry) => entry.target === StepSyncInstallation);

    assert.equal(table?.name, 'step_sync_installations');
    assert.deepEqual(databaseColumnsFor(StepSyncInstallation).sort(), [
      'created_at',
      'id',
      'installation_id',
      'last_seen_at',
      'revoked_at',
      'status',
      'updated_at',
      'user_id',
    ].sort());
    assert.ok(uniqueIndexFor(StepSyncInstallation, ['userId', 'installationId']));
    assert.ok(uniqueIndexFor(StepSyncInstallation, ['id', 'userId']));
    assert.deepEqual(Object.values(StepSyncInstallationStatus).sort(), ['ACTIVE', 'REVOKED']);
    assert.equal(
      getMetadataArgsStorage().checks.find((check) => check.target === StepSyncInstallation)?.name,
      'CHK_step_sync_installation_status',
    );
  });

  it('maps immutable identity, claimed input, result, and audit fields for batches', () => {
    const table = getMetadataArgsStorage().tables.find((entry) => entry.target === StepSyncBatch);

    assert.equal(table?.name, 'step_sync_batches');
    assert.deepEqual(databaseColumnsFor(StepSyncBatch).sort(), [
      'accepted_step_delta',
      'accounting_date',
      'algorithm_version',
      'batch_id',
      'claimed_step_count',
      'client_metadata',
      'created_at',
      'earned_ert_delta',
      'id',
      'installation_record_id',
      'local_date',
      'm2e_daily_snapshot_id',
      'observed_ended_at',
      'observed_started_at',
      'payload_hash',
      'processed_at',
      'result_code',
      'result_snapshot',
      'sensor_event_count',
      'sequence',
      'source',
      'status',
      'timezone_offset_minutes',
      'updated_at',
      'user_id',
    ].sort());
    assert.ok(uniqueIndexFor(StepSyncBatch, ['userId', 'installationRecordId', 'batchId']));
    assert.ok(uniqueIndexFor(StepSyncBatch, ['installationRecordId', 'sequence']));
  });

  it('defines only explicit terminal and non-terminal batch states and the native source', () => {
    assert.deepEqual(Object.values(StepSyncBatchStatus).sort(), [
      'ACCEPTED',
      'PARTIALLY_ACCEPTED',
      'RECEIVED',
      'REJECTED',
    ]);
    assert.deepEqual(Object.values(StepSyncBatchSource), ['android_step_counter']);
  });

  it('declares database checks for bounds and terminal result consistency', () => {
    const checks = getMetadataArgsStorage().checks
      .filter((check) => check.target === StepSyncBatch)
      .map((check) => check.name)
      .sort();

    assert.deepEqual(checks, [
      'CHK_step_sync_batch_accepted_steps',
      'CHK_step_sync_batch_claimed_steps',
      'CHK_step_sync_batch_earned_ert',
      'CHK_step_sync_batch_interval',
      'CHK_step_sync_batch_processing_state',
      'CHK_step_sync_batch_result_semantics',
      'CHK_step_sync_batch_sensor_events',
      'CHK_step_sync_batch_sequence',
      'CHK_step_sync_batch_timezone',
    ]);
  });
});
