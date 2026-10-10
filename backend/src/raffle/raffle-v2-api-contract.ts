import { displayErt } from '../m2e/ert-decimal';
import { canonicalEru, displayEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { RAFFLE_V2_CONTRACT_VERSION } from './raffle-v2-draw-core.service';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveInteger = /^[1-9][0-9]*$/;
const historyQueryFields = new Set(['limit', 'cursor']);

export class RaffleV2ApiContractError extends Error {
  constructor(readonly boundary: 'REQUEST' | 'STATE' = 'STATE') {
    super('Invalid Raffle v2 API contract value');
    this.name = 'RaffleV2ApiContractError';
  }
}

export type RaffleV2HistoryCursor = Readonly<{ createdAt: string; drawResultId: string }>;
export type RaffleV2HistoryQuery = Readonly<{ limit: number; cursor: RaffleV2HistoryCursor | null }>;

export function parseRaffleV2HistoryQuery(input: unknown): RaffleV2HistoryQuery {
  try {
    const record = requireObject(input);
    if (Object.keys(record).some((key) => !historyQueryFields.has(key))) fail();
    const limit = record.limit === undefined ? 20 : parseLimit(record.limit);
    const cursor = record.cursor === undefined ? null : decodeRaffleV2HistoryCursor(record.cursor);
    return Object.freeze({ limit, cursor });
  } catch (error) {
    return requestFailure(error);
  }
}

export function encodeRaffleV2HistoryCursor(input: RaffleV2HistoryCursor) {
  const cursor = validateCursor(input);
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

export function decodeRaffleV2HistoryCursor(input: unknown): RaffleV2HistoryCursor {
  try {
    if (typeof input !== 'string' || input.length === 0 || input.length > 512) fail();
    const decoded = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as unknown;
    const record = requireObject(decoded);
    if (record.v !== 1 || Object.keys(record).sort().join(',') !== 'createdAt,drawResultId,v') fail();
    return validateCursor(record);
  } catch (error) {
    return requestFailure(error);
  }
}

export function mapRaffleV2Reward(input: {
  rewardId: string;
  segmentIndex: number;
  weight: number;
  totalWeight: number;
  snapshot: unknown;
}) {
  const snapshot = requireObject(input.snapshot);
  const rewardId = requireUuid(input.rewardId);
  if (!Number.isSafeInteger(input.segmentIndex) || input.segmentIndex < 0
    || !Number.isSafeInteger(input.weight) || input.weight <= 0
    || !Number.isSafeInteger(input.totalWeight) || input.totalWeight < input.weight
    || snapshot.rewardId !== rewardId || snapshot.segmentIndex !== input.segmentIndex
    || snapshot.weight !== String(input.weight)) fail();
  const base = {
    rewardId,
    code: requireBoundedString(snapshot.code, 64),
    title: requireBoundedString(snapshot.title, 128),
    type: snapshot.type,
    segmentIndex: input.segmentIndex,
    weight: String(input.weight),
    probability: { numerator: String(input.weight), denominator: String(input.totalWeight) },
    imageUrl: nullableBoundedString(snapshot.imageUrl, 512),
  };
  if (snapshot.type === 'ERT') {
    const amountExact = requirePositiveInteger(snapshot.amountExact, 48);
    return frozenJson({ ...base, type: 'ERT', amountExact, amountDisplay: displayErt(amountExact) });
  }
  if (snapshot.type === 'ERU') {
    const amountExact = requirePositiveEru(snapshot.amountExact);
    return frozenJson({ ...base, type: 'ERU', amountExact, amountDisplay: displayEru(amountExact) });
  }
  if (snapshot.type === 'COPPER_RING' && (snapshot.amountExact === null || snapshot.amountExact === undefined)) {
    const asset = requireObject(snapshot.asset);
    if (asset.kind !== 'RING' || asset.rarity !== 'COPPER'
      || asset.displayRarity !== 'Cooper' || asset.quantity !== 1) fail();
    return frozenJson({ ...base, type: 'COPPER_RING', asset: {
      kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1,
    } });
  }
  return fail();
}

export function mapRaffleV2HistoryItem(snapshot: unknown, expected?: {
  operationId: string;
  drawResultId: string;
  createdAt: string;
}) {
  const response = requireObject(snapshot);
  const operation = requireObject(response.operation);
  const draw = requireObject(response.draw);
  if (response.contractVersion !== RAFFLE_V2_CONTRACT_VERSION
    || operation.status !== 'COMPLETED') fail();
  const operationId = requireUuid(operation.operationId);
  if (expected && (operationId !== requireUuid(expected.operationId)
    || draw.drawResultId !== requireUuid(expected.drawResultId)
    || draw.createdAt !== canonicalTimestamp(expected.createdAt))) fail();
  const item = {
    operationId,
    draw,
    selection: requireObject(response.selection),
    reward: historyReward(response.selection, response.reward),
    fulfillment: historyFulfillment(response.fulfillment),
  };
  return frozenJson(item);
}

function historyFulfillment(value: unknown) {
  const fulfillment = requireObject(value);
  if (fulfillment.type !== 'ERU_CREDIT') return fulfillment;
  try {
    const balanceAfterExact = canonicalEru(fulfillment.balanceAfterExact, 'fulfillment.balanceAfterExact');
    return {
      ...fulfillment,
      balanceAfterExact,
      balanceAfterDisplay: displayEru(balanceAfterExact),
    };
  } catch {
    return fail();
  }
}

function historyReward(selectionValue: unknown, rewardValue: unknown) {
  const selection = requireObject(selectionValue);
  const reward = requireObject(rewardValue);
  return mapRaffleV2Reward({
    rewardId: requireUuid(reward.rewardId),
    segmentIndex: requireNonNegativeInteger(reward.segmentIndex),
    weight: requireSafePositiveInteger(reward.weight),
    totalWeight: requireSafePositiveInteger(selection.totalWeight),
    snapshot: reward,
  });
}

function validateCursor(input: { createdAt?: unknown; drawResultId?: unknown }): RaffleV2HistoryCursor {
  return Object.freeze({
    createdAt: canonicalTimestamp(input.createdAt),
    drawResultId: requireUuid(input.drawResultId),
  });
}

function canonicalTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.endsWith('Z')) fail();
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) fail();
  return value;
}

function parseLimit(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) fail();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail();
  return limit;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown) {
  if (typeof value !== 'string' || !uuidV4.test(value)) fail();
  return value;
}

function requirePositiveInteger(value: unknown, maxLength: number) {
  if (typeof value !== 'string' || value.length > maxLength || !positiveInteger.test(value)) fail();
  return value;
}

function requirePositiveEru(value: unknown) {
  try {
    const amount = canonicalEru(value, 'raffle reward amount');
    parseUnsignedEruDecimal(amount, 'raffle reward amount', false);
    return amount;
  } catch {
    return fail();
  }
}

function requireSafePositiveInteger(value: unknown) {
  const parsed = Number(requirePositiveInteger(value, 15));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail();
  return parsed;
}

function requireNonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}

function requireBoundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail();
  return value;
}

function nullableBoundedString(value: unknown, maxLength: number) {
  return value === null ? null : requireBoundedString(value, maxLength);
}

function frozenJson<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function fail(): never {
  throw new RaffleV2ApiContractError();
}

function requestFailure(error: unknown): never {
  if (error instanceof RaffleV2ApiContractError && error.boundary === 'REQUEST') throw error;
  throw new RaffleV2ApiContractError('REQUEST');
}
