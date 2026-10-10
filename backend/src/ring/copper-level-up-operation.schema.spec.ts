import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { LedgerTransaction } from '../balance/ledger-transaction.entity';
import { CopperLevelUpOperation } from './copper-level-up-operation.entity';
import {
  COPPER_ATTRIBUTE_ALLOCATION_V1,
  COPPER_ATTRIBUTE_ALLOCATION_VERSION,
  COPPER_ATTRIBUTE_ALLOCATION_VERSIONS,
  CopperAttributeAllocationOperation,
} from './copper-attribute-allocation-operation.entity';
import { RingEvent, RingEventType } from './ring-event.entity';

describe('Copper level-up persistence metadata', () => {
  it('defines account-scoped idempotency and immutable response fields', () => {
    const metadata = getMetadataArgsStorage();
    assert.equal(metadata.tables.find((table) => table.target === CopperLevelUpOperation)?.name,
      'copper_level_up_operations');
    const columns = metadata.columns
      .filter((column) => column.target === CopperLevelUpOperation)
      .map((column) => column.options.name ?? column.propertyName);
    assert.deepEqual(columns.sort(), [
      'created_at', 'id', 'idempotency_key', 'owner_user_id', 'request_fingerprint',
      'response_snapshot', 'ring_id', 'rules_version', 'status', 'updated_at',
    ].sort());
    assert.ok(metadata.indices.some((index) => index.target === CopperLevelUpOperation
      && index.name === 'UQ_copper_level_up_owner_key'
      && index.unique));
  });

  it('defines dedicated unique ledger evidence and a level-up audit type', () => {
    const metadata = getMetadataArgsStorage();
    const ledgerIndex = metadata.indices.find((index) => index.target === LedgerTransaction
      && index.name === 'UQ_ledger_copper_level_up_reference');
    assert.equal(ledgerIndex?.unique, true);
    assert.deepEqual(ledgerIndex?.columns, ['currency', 'referenceType', 'referenceId']);
    assert.equal(RingEventType.LevelUp, 'LEVEL_UP');
    assert.equal(RingEventType.AttributePointsAllocated, 'ATTRIBUTE_POINTS_ALLOCATED');
    assert.ok(metadata.checks.some((check) => check.target === RingEvent
      && check.name === 'CHK_ring_events_type'
      && String(check.expression).includes('LEVEL_UP')));
  });

  it('defines durable owner-scoped deferred allocation operations', () => {
    const metadata = getMetadataArgsStorage();
    assert.equal(COPPER_ATTRIBUTE_ALLOCATION_V1, 'copper-attribute-allocation-v1');
    assert.equal(COPPER_ATTRIBUTE_ALLOCATION_VERSION, 'copper-attribute-allocation-v2');
    assert.deepEqual(COPPER_ATTRIBUTE_ALLOCATION_VERSIONS, [
      COPPER_ATTRIBUTE_ALLOCATION_V1,
      COPPER_ATTRIBUTE_ALLOCATION_VERSION,
    ]);
    assert.equal(metadata.tables.find((table) => table.target === CopperAttributeAllocationOperation)?.name,
      'copper_attribute_allocation_operations');
    const columns = metadata.columns
      .filter((column) => column.target === CopperAttributeAllocationOperation)
      .map((column) => column.options.name ?? column.propertyName);
    assert.deepEqual(columns.sort(), [
      'created_at', 'id', 'idempotency_key', 'owner_user_id', 'request_fingerprint',
      'response_snapshot', 'ring_id', 'rules_version', 'status', 'updated_at',
    ].sort());
    assert.ok(metadata.indices.some((index) => index.target === CopperAttributeAllocationOperation
      && index.name === 'UQ_copper_attribute_allocation_owner_key'
      && index.unique));
    const checks = metadata.checks
      .filter((check) => check.target === CopperAttributeAllocationOperation)
      .map((check) => check.name);
    assert.deepEqual(checks.sort(), [
      'CHK_copper_attribute_allocation_operation_fingerprint',
      'CHK_copper_attribute_allocation_operation_response',
      'CHK_copper_attribute_allocation_operation_rules',
      'CHK_copper_attribute_allocation_operation_status',
    ].sort());
    const rulesCheck = metadata.checks.find((check) =>
      check.target === CopperAttributeAllocationOperation
      && check.name === 'CHK_copper_attribute_allocation_operation_rules');
    assert.match(String(rulesCheck?.expression), /copper-attribute-allocation-v1/);
    assert.match(String(rulesCheck?.expression), /copper-attribute-allocation-v2/);
  });
});
