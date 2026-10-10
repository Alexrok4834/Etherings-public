import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { displayErt } from '../m2e/ert-decimal';
import { canonicalEru, displayEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import {
  RAFFLE_V2_DRAW_REPOSITORY,
  RaffleV2DrawTransactionRepository,
  RaffleV2ResultEvidence,
} from './raffle-v2-draw.repository';
import {
  RAFFLE_V2_FULFILLMENT_PORT,
  RaffleV2FulfillmentPort,
  RaffleV2LockedDraw,
} from './raffle-v2-fulfillment.port';
import {
  RaffleV2EligibleSegment,
  RaffleV2IntegerSelectionService,
} from './raffle-v2-integer-selection.service';

export const RAFFLE_V2_CONTRACT_VERSION = 'raffle-v2' as const;
const requestFields = Object.freeze(['contractVersion', 'configurationVersion', 'idempotencyKey']);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveInteger = /^[1-9][0-9]*$/;

export enum RaffleV2DrawCoreFailure {
  InvalidRequest = 'INVALID_REQUEST',
  OwnerNotFound = 'OWNER_NOT_FOUND',
  Unavailable = 'UNAVAILABLE',
  ConfigurationStale = 'CONFIGURATION_STALE',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  InvalidState = 'INVALID_STATE',
}

export class RaffleV2DrawCoreError extends Error {
  constructor(readonly reason: RaffleV2DrawCoreFailure) {
    super(`Raffle v2 draw core failed: ${reason}`);
    this.name = 'RaffleV2DrawCoreError';
  }
}

export type RaffleV2DrawRequest = Readonly<{
  contractVersion: typeof RAFFLE_V2_CONTRACT_VERSION;
  configurationVersion: string;
  idempotencyKey: string;
}>;

@Injectable()
export class RaffleV2DrawCoreService {
  constructor(
    @Inject(RAFFLE_V2_DRAW_REPOSITORY)
    private readonly repository: RaffleV2DrawTransactionRepository,
    private readonly selector: RaffleV2IntegerSelectionService,
    @Inject(RAFFLE_V2_FULFILLMENT_PORT)
    private readonly fulfillment: RaffleV2FulfillmentPort,
  ) {}

  async execute(ownerUserId: string, input: unknown): Promise<Record<string, unknown>> {
    const ownerId = normalizeUuid(ownerUserId);
    const request = parseRaffleV2DrawRequest(input);
    const requestFingerprint = raffleV2RequestFingerprint(ownerId, request.configurationVersion);

    return this.repository.transaction(async (manager) => {
      const owner = await this.repository.lockOwner(manager, ownerId);
      if (!owner) throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.OwnerNotFound);

      const existing = await this.repository.findOperationForUpdate(
        manager,
        ownerId,
        request.idempotencyKey,
      );
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.IdempotencyConflict);
        }
        if (existing.status !== RaffleDrawOperationStatus.Completed || !existing.responseSnapshot) {
          throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
        }
        return replaySnapshot(existing.responseSnapshot);
      }

      const machine = await this.repository.lockSingletonMachine(manager);
      if (!machine || !machine.isAvailable) throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.Unavailable);
      const configuration = await this.repository.lockActiveConfiguration(manager, machine.id);
      if (!configuration) throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.Unavailable);
      if (configuration.id.toLowerCase() !== request.configurationVersion) {
        throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.ConfigurationStale);
      }

      const operation = await this.repository.claimOperation(manager, {
        ownerUserId: ownerId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        contractVersion: RAFFLE_V2_CONTRACT_VERSION,
        configurationId: configuration.id,
      });
      if (!operation
        || operation.requestFingerprint !== requestFingerprint
        || operation.status !== RaffleDrawOperationStatus.Pending) {
        throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
      }

      const rewards = await this.repository.lockConfigurationRewards(manager, configuration.id);
      const draw: RaffleV2LockedDraw = Object.freeze({ machine, configuration, rewards });
      const prepared = await this.fulfillment.lockAndValidate(manager, {
        ownerUserId: ownerId,
        operation,
        draw,
      });
      const eligibleSegments = selectEligibleSegments(rewards, prepared.eligibleRewardIds);
      const selection = this.selector.select(eligibleSegments);
      const rangesSnapshot = {
        ranges: selection.ranges.map((range) => ({
          segmentIndex: range.segmentIndex,
          rewardId: range.rewardId,
          weight: range.weight,
          startInclusive: range.startInclusive,
          endExclusive: range.endExclusive,
          rewardSnapshot: range.rewardSnapshot,
        })),
      };
      const resultInput: RaffleV2ResultEvidence = {
        operationId: operation.id,
        ownerUserId: ownerId,
        machineId: machine.id,
        configurationId: configuration.id,
        selectedRewardId: selection.selectedRewardId,
        selectedSegmentIndex: selection.selectedSegmentIndex,
        algorithm: selection.algorithm,
        ticket: selection.ticket,
        totalWeight: selection.totalWeight,
        rangesSnapshot,
        costErtExact: configuration.costErtExact,
      };
      const result = await this.repository.saveResult(manager, resultInput);
      const fulfilled = await this.fulfillment.fulfill(manager, {
        ownerUserId: ownerId,
        operation,
        draw,
        selection,
        result,
        preparedState: prepared.state,
      });
      const response = buildResponse({
        request,
        operationId: operation.id,
        resultId: result.id,
        machineId: machine.id,
        createdAt: result.createdAt,
        selection,
        cost: fulfilled.cost,
        attempts: fulfilled.attempts,
        fulfillment: fulfilled.fulfillment,
      });
      await this.repository.completeOperation(manager, operation, response);
      return response;
    });
  }
}

export function parseRaffleV2DrawRequest(input: unknown): RaffleV2DrawRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest);
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== requestFields.length || keys.some((key) => !requestFields.includes(key))) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest);
  }
  if (record.contractVersion !== RAFFLE_V2_CONTRACT_VERSION
    || typeof record.configurationVersion !== 'string'
    || typeof record.idempotencyKey !== 'string'
    || !uuidV4.test(record.configurationVersion)
    || !uuidV4.test(record.idempotencyKey)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest);
  }
  return Object.freeze({
    contractVersion: RAFFLE_V2_CONTRACT_VERSION,
    configurationVersion: record.configurationVersion.toLowerCase(),
    idempotencyKey: record.idempotencyKey.toLowerCase(),
  });
}

export function raffleV2RequestFingerprint(ownerUserId: string, configurationVersion: string) {
  const canonical = JSON.stringify({
    ownerUserId: normalizeUuid(ownerUserId),
    contractVersion: RAFFLE_V2_CONTRACT_VERSION,
    configurationVersion: normalizeUuid(configurationVersion),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function normalizeUuid(value: string) {
  if (typeof value !== 'string' || !uuidV4.test(value)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest);
  }
  return value.toLowerCase();
}

function selectEligibleSegments(
  rewards: ReadonlyArray<{ rewardId: string; segmentIndex: number; weight: number; rewardSnapshot: Record<string, unknown> }>,
  eligibleRewardIds: ReadonlyArray<string>,
): RaffleV2EligibleSegment[] {
  if (!Array.isArray(eligibleRewardIds)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  const eligible = new Set(eligibleRewardIds.map((rewardId) => normalizeUuid(rewardId)));
  if (eligible.size !== eligibleRewardIds.length) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  const segments = rewards
    .filter((reward) => eligible.has(reward.rewardId.toLowerCase()))
    .map((reward) => ({
      segmentIndex: reward.segmentIndex,
      rewardId: reward.rewardId,
      weight: reward.weight,
      rewardSnapshot: reward.rewardSnapshot,
    }));
  if (segments.length !== eligible.size) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  return segments;
}

function replaySnapshot(snapshot: Record<string, unknown>) {
  const clone = cloneJsonObject(snapshot);
  const operation = clone.operation;
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  clone.operation = { ...(operation as Record<string, unknown>), replayed: true };
  const geometry = selectedRewardGeometry(clone.selection);
  clone.reward = commandReward(clone.reward, geometry.weight, geometry.totalWeight);
  return clone;
}

function buildResponse(input: {
  request: RaffleV2DrawRequest;
  operationId: string;
  resultId: string;
  machineId: string;
  createdAt: Date;
  selection: ReturnType<RaffleV2IntegerSelectionService['select']>;
  cost: Readonly<Record<string, unknown>>;
  attempts: Readonly<Record<string, unknown>>;
  fulfillment: Readonly<Record<string, unknown>>;
}) {
  return cloneJsonObject({
    contractVersion: RAFFLE_V2_CONTRACT_VERSION,
    operation: {
      operationId: input.operationId,
      idempotencyKey: input.request.idempotencyKey,
      status: RaffleDrawOperationStatus.Completed,
      replayed: false,
    },
    draw: {
      drawResultId: input.resultId,
      drawId: input.machineId,
      configurationVersion: input.request.configurationVersion,
      createdAt: input.createdAt.toISOString(),
      cost: input.cost,
      attempts: input.attempts,
    },
    selection: {
      algorithm: input.selection.algorithm,
      ticket: String(input.selection.ticket),
      totalWeight: String(input.selection.totalWeight),
      selectedSegmentIndex: input.selection.selectedSegmentIndex,
      ranges: input.selection.ranges.map((range) => ({
        segmentIndex: range.segmentIndex,
        rewardId: range.rewardId,
        weight: String(range.weight),
        startInclusive: String(range.startInclusive),
        endExclusive: String(range.endExclusive),
      })),
    },
    reward: commandReward(
      input.selection.selectedRewardSnapshot,
      String(input.selection.ranges.find(
        (range) => range.segmentIndex === input.selection.selectedSegmentIndex,
      )?.weight),
      String(input.selection.totalWeight),
    ),
    fulfillment: input.fulfillment,
  });
}

function commandReward(value: unknown, weight: string, totalWeight: string) {
  if (!positiveInteger.test(weight) || !positiveInteger.test(totalWeight)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  const reward = cloneJsonObject(value);
  reward.weight = weight;
  reward.probability = { numerator: weight, denominator: totalWeight };
  if (reward.type === 'ERT') {
    if (typeof reward.amountExact !== 'string' || !positiveInteger.test(reward.amountExact)) {
      throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
    }
    reward.amountDisplay = displayErt(reward.amountExact);
  } else if (reward.type === 'ERU') {
    try {
      reward.amountExact = canonicalEru(reward.amountExact, 'reward.amountExact');
      parseUnsignedEruDecimal(reward.amountExact, 'reward.amountExact', false);
    } catch {
      throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
    }
    reward.amountDisplay = displayEru(reward.amountExact);
  } else if (reward.type !== 'COPPER_RING') {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  return reward;
}

function selectedRewardGeometry(value: unknown) {
  const selection = cloneJsonObject(value);
  if (!Number.isSafeInteger(selection.selectedSegmentIndex)
    || !Array.isArray(selection.ranges)
    || typeof selection.totalWeight !== 'string'
    || !positiveInteger.test(selection.totalWeight)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  const selected = selection.ranges.find((item) => {
    return item !== null && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).segmentIndex === selection.selectedSegmentIndex;
  }) as Record<string, unknown> | undefined;
  if (!selected || typeof selected.weight !== 'string' || !positiveInteger.test(selected.weight)) {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
  return { weight: selected.weight, totalWeight: selection.totalWeight };
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  try {
    const clone = JSON.parse(JSON.stringify(value)) as unknown;
    if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) throw new Error('not an object');
    return clone as Record<string, unknown>;
  } catch {
    throw new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState);
  }
}
