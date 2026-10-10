import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import {
  copperAttributeAllocationIdempotencyConflict,
  copperAttributeAllocationInvalid,
  copperAttributeAllocationRequestInvalid,
  copperAttributeAllocationWriteUnavailable,
  copperAttributePointsInsufficient,
  copperAttributePointsStale,
} from './copper-attribute-allocation-errors';
import {
  COPPER_ATTRIBUTE_ALLOCATION_V1,
  COPPER_ATTRIBUTE_ALLOCATION_VERSION,
  COPPER_ATTRIBUTE_ALLOCATION_VERSIONS,
  CopperAttributeAllocationOperationStatus,
} from './copper-attribute-allocation-operation.entity';
import {
  COPPER_ATTRIBUTE_NAMES,
  CopperAttributeAllocation,
  applyCopperAttributeAllocation,
} from './copper-level-up.rules';
import { copperRingNotFound, copperRingStateConflict } from './copper-ring-errors';
import { CopperRingRepository } from './copper-ring.repository';
import { COPPER_RULESET_VERSION } from './game-ring.entity';
import { RingEventType } from './ring-event.entity';

const requestFields = Object.freeze(['expectedUnspentPoints', 'allocation', 'idempotencyKey']);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COPPER_MAX_UNSPENT_POINTS = 76;
const COPPER_ATTRIBUTE_ALLOCATION_V1_MAX = 4;

type Request = {
  expectedUnspentPoints: number;
  allocation: CopperAttributeAllocation;
  allocatedPoints: number;
  idempotencyKey: string;
};

@Injectable()
export class CopperAttributeAllocationService {
  constructor(private readonly repository: CopperRingRepository) {}

  async allocate(user: User, ringId: string, input: unknown) {
    const request = this.parseRequest(input);
    const currentFingerprint = fingerprintFor(
      user.id,
      ringId,
      request,
      COPPER_ATTRIBUTE_ALLOCATION_VERSION,
    );

    try {
      return await this.repository.transaction(async (manager) => {
        const owner = await this.repository.lockOwner(manager, user.id);
        if (!owner) throw copperRingNotFound();
        const operation = await this.repository.claimAttributeAllocationOperation(manager, {
          ownerUserId: user.id,
          ringId,
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: currentFingerprint,
          rulesVersion: COPPER_ATTRIBUTE_ALLOCATION_VERSION,
        });
        if (!operation) throw copperRingNotFound();
        if (!COPPER_ATTRIBUTE_ALLOCATION_VERSIONS.includes(operation.rulesVersion)) {
          throw copperRingStateConflict();
        }
        const operationFingerprint = fingerprintFor(
          user.id,
          ringId,
          request,
          operation.rulesVersion,
        );
        if (operation.requestFingerprint !== operationFingerprint) {
          throw copperAttributeAllocationIdempotencyConflict();
        }
        if (operation.rulesVersion === COPPER_ATTRIBUTE_ALLOCATION_V1
          && request.allocatedPoints > COPPER_ATTRIBUTE_ALLOCATION_V1_MAX) {
          throw copperRingStateConflict();
        }
        if (operation.status === CopperAttributeAllocationOperationStatus.Completed) {
          if (!operation.responseSnapshot) throw copperRingStateConflict();
          return operation.responseSnapshot;
        }

        const ring = await this.repository.findOwnedRingForUpdate(manager, user.id, ringId);
        if (!ring) throw copperRingNotFound();
        if (ring.unspentAttributePoints !== request.expectedUnspentPoints) {
          throw copperAttributePointsStale();
        }
        if (request.allocatedPoints > ring.unspentAttributePoints) {
          throw copperAttributePointsInsufficient();
        }

        const previousAttributes = attributesOf(ring);
        const currentAttributes = applyCopperAttributeAllocation(previousAttributes, request.allocation);
        const unspentAfter = ring.unspentAttributePoints - request.allocatedPoints;
        ring.comfort = currentAttributes.comfort;
        ring.charm = currentAttributes.charm;
        ring.quality = currentAttributes.quality;
        ring.luck = currentAttributes.luck;
        ring.unspentAttributePoints = unspentAfter;
        await this.repository.saveRing(manager, ring);

        const snapshot = {
          operationId: operation.id,
          rulesVersion: operation.rulesVersion,
          ringId,
          idempotencyKey: request.idempotencyKey,
          allocation: request.allocation,
          attributes: { previous: previousAttributes, current: currentAttributes },
          unspentAttributePoints: {
            previous: request.expectedUnspentPoints,
            spent: request.allocatedPoints,
            current: unspentAfter,
          },
        };
        await this.repository.saveAttributeAllocationEvent(manager, {
          ringId,
          ownerUserId: user.id,
          operationKey: `attribute-allocation:${operation.id}`,
          eventType: RingEventType.AttributePointsAllocated,
          rulesetVersion: COPPER_RULESET_VERSION,
          snapshot,
        });
        await this.repository.completeAttributeAllocationOperation(manager, operation, snapshot);
        return snapshot;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof TypeORMError) throw copperAttributeAllocationWriteUnavailable();
      throw error;
    }
  }

  private parseRequest(input: unknown): Request {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw copperAttributeAllocationRequestInvalid();
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== requestFields.length || keys.some((key) => !requestFields.includes(key))) {
      throw copperAttributeAllocationRequestInvalid();
    }
    if (!Number.isSafeInteger(record.expectedUnspentPoints)
      || (record.expectedUnspentPoints as number) < 0
      || (record.expectedUnspentPoints as number) > COPPER_MAX_UNSPENT_POINTS
      || typeof record.idempotencyKey !== 'string'
      || !uuidV4.test(record.idempotencyKey)) {
      throw copperAttributeAllocationRequestInvalid();
    }

    const allocation = parseAllocation(
      record.allocation,
      record.expectedUnspentPoints as number,
    );
    return {
      expectedUnspentPoints: record.expectedUnspentPoints as number,
      allocation,
      allocatedPoints: Object.values(allocation).reduce((sum, points) => sum + points, 0),
      idempotencyKey: record.idempotencyKey.toLowerCase(),
    };
  }
}

function parseAllocation(input: unknown, expectedUnspentPoints: number): CopperAttributeAllocation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw copperAttributeAllocationInvalid();
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== COPPER_ATTRIBUTE_NAMES.length
    || keys.some((key) => !COPPER_ATTRIBUTE_NAMES.includes(key as typeof COPPER_ATTRIBUTE_NAMES[number]))) {
    throw copperAttributeAllocationInvalid();
  }
  const values = COPPER_ATTRIBUTE_NAMES.map((name) => record[name]);
  if (values.some((value) => typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > COPPER_MAX_UNSPENT_POINTS)) {
    throw copperAttributeAllocationInvalid();
  }
  const total = values.reduce<number>((sum, value) => sum + (value as number), 0);
  if (total < 1
    || total > expectedUnspentPoints
    || total > COPPER_MAX_UNSPENT_POINTS) {
    throw copperAttributeAllocationInvalid();
  }
  return Object.freeze({
    comfort: record.comfort as number,
    charm: record.charm as number,
    quality: record.quality as number,
    luck: record.luck as number,
  });
}

function attributesOf(ring: { comfort: number; charm: number; quality: number; luck: number }) {
  return { comfort: ring.comfort, charm: ring.charm, quality: ring.quality, luck: ring.luck };
}

function fingerprintFor(
  ownerUserId: string,
  ringId: string,
  request: Request,
  rulesVersion: string,
) {
  return createHash('sha256').update(JSON.stringify({
    ownerUserId,
    ringId,
    expectedUnspentPoints: request.expectedUnspentPoints,
    allocation: request.allocation,
    rulesVersion,
  })).digest('hex');
}
