import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import {
  RING_EQUIPMENT_CONTRACT_VERSION,
  RingEquipmentOperation,
  RingEquipmentOperationStatus,
} from './ring-equipment-operation.entity';
import { RingEventType } from './ring-event.entity';

describe('Ring equipment operation persistence metadata', () => {
  it('defines the frozen owner-scoped idempotent command identity', () => {
    const metadata = getMetadataArgsStorage();
    assert.equal(RING_EQUIPMENT_CONTRACT_VERSION, 'ring-equipment-v1');
    assert.deepEqual(Object.values(RingEquipmentOperationStatus), ['PENDING', 'COMPLETED']);
    assert.equal(
      metadata.tables.find((table) => table.target === RingEquipmentOperation)?.name,
      'ring_equipment_operations',
    );
    assert.deepEqual(
      metadata.columns
        .filter((column) => column.target === RingEquipmentOperation)
        .map((column) => column.options.name ?? column.propertyName)
        .sort(),
      [
        'completed_at',
        'contract_version',
        'created_at',
        'expected_equipped_ring_id',
        'id',
        'idempotency_key',
        'owner_user_id',
        'request_fingerprint',
        'response_snapshot',
        'status',
        'target_ring_id',
        'updated_at',
      ].sort(),
    );
    const ownerKey = metadata.indices.find((index) => index.target === RingEquipmentOperation
      && index.name === 'UQ_ring_equipment_operations_owner_key');
    assert.equal(ownerKey?.unique, true);
    assert.deepEqual(ownerKey?.columns, ['ownerUserId', 'idempotencyKey']);
  });

  it('guards lifecycle, contract, UUID, and fingerprint in database metadata', () => {
    const checks = getMetadataArgsStorage().checks
      .filter((check) => check.target === RingEquipmentOperation)
      .map((check) => check.name)
      .sort();
    assert.deepEqual(checks, [
      'CHK_ring_equipment_operations_contract',
      'CHK_ring_equipment_operations_fingerprint',
      'CHK_ring_equipment_operations_idempotency_v4',
      'CHK_ring_equipment_operations_lifecycle',
      'CHK_ring_equipment_operations_status',
      'CHK_ring_equipment_operations_updated_at',
    ]);
    assert.equal(RingEventType.Equipped, 'EQUIPPED');
  });
});
