import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import { CopperRingRepository } from './copper-ring.repository';
import { copperRingNotFound, copperRingStateConflict } from './copper-ring-errors';
import { GameRing, GameRingStatus, COPPER_RULESET_VERSION } from './game-ring.entity';
import {
  ringEquipmentIdempotencyConflict,
  ringEquipmentRequestInvalid,
  ringEquipmentStale,
  ringEquipmentWriteUnavailable,
} from './ring-equipment-errors';
import {
  RING_EQUIPMENT_CONTRACT_VERSION,
  RingEquipmentOperationStatus,
} from './ring-equipment-operation.entity';
import { RingEventType } from './ring-event.entity';

const requestFields = Object.freeze(['contractVersion', 'expectedEquippedRingId', 'idempotencyKey']);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EquipmentRequest = Readonly<{
  contractVersion: typeof RING_EQUIPMENT_CONTRACT_VERSION;
  expectedEquippedRingId: string;
  idempotencyKey: string;
}>;

@Injectable()
export class RingEquipmentService {
  constructor(private readonly repository: CopperRingRepository) {}

  async equip(user: User, targetRingIdInput: string, input: unknown) {
    const targetRingId = normalizeUuidV4(targetRingIdInput);
    const request = parseRequest(input);
    const fingerprint = fingerprintFor(user.id, targetRingId, request);

    try {
      return await this.repository.transaction(async (manager) => {
        const owner = await this.repository.lockOwner(manager, user.id);
        if (!owner) throw copperRingNotFound();

        const existing = await this.repository.findEquipmentOperationForUpdate(
          manager,
          user.id,
          request.idempotencyKey,
        );
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) throw ringEquipmentIdempotencyConflict();
          if (existing.status !== RingEquipmentOperationStatus.Completed || !existing.responseSnapshot) {
            throw copperRingStateConflict();
          }
          return { ...existing.responseSnapshot, replay: true };
        }

        const equipment = await this.repository.lockEquipment(manager, user.id);
        if (!equipment) throw copperRingStateConflict();
        if (equipment.ringId !== request.expectedEquippedRingId) throw ringEquipmentStale();

        const targetRing = await this.repository.findOwnedRingForUpdate(manager, user.id, targetRingId);
        if (!targetRing || targetRing.status !== GameRingStatus.Active) throw copperRingNotFound();

        const operation = await this.repository.claimEquipmentOperation(manager, {
          ownerUserId: user.id,
          targetRingId,
          expectedEquippedRingId: request.expectedEquippedRingId,
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: fingerprint,
          contractVersion: RING_EQUIPMENT_CONTRACT_VERSION,
        });
        if (!operation || operation.requestFingerprint !== fingerprint) {
          throw ringEquipmentIdempotencyConflict();
        }
        if (operation.status !== RingEquipmentOperationStatus.Pending) throw copperRingStateConflict();

        const previousRingId = equipment.ringId;
        const noChange = previousRingId === targetRingId;
        const changedAt = this.currentTime();
        if (!noChange) {
          equipment.ringId = targetRingId;
          equipment.equippedAt = changedAt;
          equipment.updatedAt = changedAt;
          await this.repository.saveEquipment(manager, equipment);
          await this.repository.saveEquipmentEvent(manager, {
            ringId: targetRingId,
            ownerUserId: user.id,
            operationKey: `ring-equipment:${operation.id}`,
            eventType: RingEventType.Equipped,
            rulesetVersion: COPPER_RULESET_VERSION,
            snapshot: {
              operationId: operation.id,
              contractVersion: RING_EQUIPMENT_CONTRACT_VERSION,
              ownerUserId: user.id,
              previousRingId,
              currentRingId: targetRingId,
              equippedAt: changedAt.toISOString(),
            },
          });
        }

        const response = {
          operationId: operation.id,
          contractVersion: RING_EQUIPMENT_CONTRACT_VERSION,
          replay: false,
          noChange,
          previousRingId,
          currentRingId: targetRingId,
          equippedAt: equipment.equippedAt.toISOString(),
          ring: toPlayerView(targetRing),
        };
        await this.repository.completeEquipmentOperation(manager, operation, response, changedAt);
        return response;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof TypeORMError) throw ringEquipmentWriteUnavailable();
      throw error;
    }
  }

  protected currentTime() {
    return new Date();
  }
}

function parseRequest(input: unknown): EquipmentRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw ringEquipmentRequestInvalid();
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== requestFields.length || keys.some((key) => !requestFields.includes(key))) {
    throw ringEquipmentRequestInvalid();
  }
  if (record.contractVersion !== RING_EQUIPMENT_CONTRACT_VERSION
    || typeof record.expectedEquippedRingId !== 'string'
    || !uuidV4.test(record.expectedEquippedRingId)
    || typeof record.idempotencyKey !== 'string'
    || !uuidV4.test(record.idempotencyKey)) {
    throw ringEquipmentRequestInvalid();
  }
  return Object.freeze({
    contractVersion: RING_EQUIPMENT_CONTRACT_VERSION,
    expectedEquippedRingId: record.expectedEquippedRingId.toLowerCase(),
    idempotencyKey: record.idempotencyKey.toLowerCase(),
  });
}

function normalizeUuidV4(value: string) {
  if (typeof value !== 'string' || !uuidV4.test(value)) throw ringEquipmentRequestInvalid();
  return value.toLowerCase();
}

function fingerprintFor(ownerUserId: string, targetRingId: string, request: EquipmentRequest) {
  return createHash('sha256').update(JSON.stringify({
    ownerUserId: ownerUserId.toLowerCase(),
    targetRingId,
    expectedEquippedRingId: request.expectedEquippedRingId,
    contractVersion: request.contractVersion,
  })).digest('hex');
}

function toPlayerView(ring: GameRing) {
  return {
    id: ring.id,
    ringKind: ring.ringKind,
    status: ring.status,
    level: ring.level,
    shine: ring.shine,
    unspentAttributePoints: ring.unspentAttributePoints,
    attributes: {
      comfort: ring.comfort,
      charm: ring.charm,
      quality: ring.quality,
      luck: ring.luck,
    },
    visualVariantCode: ring.visualVariantCode,
    visualSetVersion: ring.visualSetVersion,
    rulesetVersion: ring.rulesetVersion,
    equipped: true,
    createdAt: ring.createdAt.toISOString(),
    updatedAt: ring.updatedAt.toISOString(),
  };
}
