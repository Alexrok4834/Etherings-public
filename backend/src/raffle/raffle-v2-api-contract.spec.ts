import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeRaffleV2HistoryCursor,
  encodeRaffleV2HistoryCursor,
  mapRaffleV2HistoryItem,
  mapRaffleV2Reward,
  parseRaffleV2HistoryQuery,
  RaffleV2ApiContractError,
} from './raffle-v2-api-contract';

const rewardId = '10000000-0000-4000-8000-000000000001';
const drawResultId = '10000000-0000-4000-8000-000000000002';

describe('Raffle v2 pure API contract', () => {
  it('parses bounded history queries and a versioned opaque cursor', () => {
    const cursor = { createdAt: '2026-08-31T12:30:00.000Z', drawResultId };
    const encoded = encodeRaffleV2HistoryCursor(cursor);
    assert.equal(encoded.includes('{'), false);
    assert.deepEqual(decodeRaffleV2HistoryCursor(encoded), cursor);
    assert.deepEqual(parseRaffleV2HistoryQuery({}), { limit: 20, cursor: null });
    assert.deepEqual(parseRaffleV2HistoryQuery({ limit: '50', cursor: encoded }), { limit: 50, cursor });
  });

  it('rejects malformed, non-canonical, unknown, and out-of-range history input', () => {
    for (const input of [null, [], { limit: 20 }, { limit: '0' }, { limit: '51' },
      { limit: '01' }, { unknown: '1' }, { cursor: 'broken' }]) {
      assert.throws(() => parseRaffleV2HistoryQuery(input), RaffleV2ApiContractError);
    }
    const malformed = Buffer.from(JSON.stringify({
      v: 2, createdAt: '2026-08-31T12:30:00.000Z', drawResultId,
    })).toString('base64url');
    assert.throws(() => decodeRaffleV2HistoryCursor(malformed), RaffleV2ApiContractError);
  });

  it('maps ERT, ERU, and Cooper snapshots with account-specific exact probabilities', () => {
    assert.deepEqual(mapRaffleV2Reward(mapping('ERT', '5')), {
      ...baseReward('ERT'), amountExact: '5', amountDisplay: '5.00',
    });
    assert.deepEqual(mapRaffleV2Reward(mapping('ERU', '1.235')), {
      ...baseReward('ERU'), amountExact: '1.235', amountDisplay: '1.24',
    });
    assert.deepEqual(mapRaffleV2Reward(mapping('COPPER_RING', null, {
      kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1,
    })), {
      ...baseReward('COPPER_RING'),
      asset: { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 },
    });
  });

  it('fails closed for cross-type, malformed amount, asset, and identity snapshots', () => {
    const inputs = [
      mapping('ERT', '0'),
      mapping('ERU', '0'),
      mapping('ERU', '1.1234567890123456789'),
      mapping('COPPER_RING', null, { kind: 'NFT', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 }),
      { ...mapping('ERT', '5'), rewardId: drawResultId },
      { ...mapping('ERT', '5'), weight: 101 },
    ];
    for (const input of inputs) assert.throws(() => mapRaffleV2Reward(input), RaffleV2ApiContractError);
  });

  it('maps immutable history from the stored response and omits the idempotency key', () => {
    const snapshot = {
      contractVersion: 'raffle-v2',
      operation: { operationId: rewardId, idempotencyKey: drawResultId, status: 'COMPLETED', replayed: false },
      draw: { drawResultId }, selection: { ticket: '1', totalWeight: '30' },
      reward: {
        rewardId, code: 'reward-code', title: 'Reward', type: 'ERT', segmentIndex: 0,
        weight: '30', probability: { numerator: '30', denominator: '30' }, imageUrl: null,
        amountExact: '5', amountDisplay: null,
      },
      fulfillment: { type: 'ERT_CREDIT' },
    };
    const item = mapRaffleV2HistoryItem(snapshot);
    assert.deepEqual(item, {
      operationId: rewardId, draw: { drawResultId }, selection: { ticket: '1', totalWeight: '30' },
      reward: {
        rewardId, code: 'reward-code', title: 'Reward', type: 'ERT', segmentIndex: 0,
        weight: '30', probability: { numerator: '30', denominator: '30' }, imageUrl: null,
        amountExact: '5', amountDisplay: '5.00',
      },
      fulfillment: { type: 'ERT_CREDIT' },
    });
    assert.equal('idempotencyKey' in item, false);
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.draw), true);
  });
});

function mapping(type: 'ERT' | 'ERU' | 'COPPER_RING', amountExact: string | null, asset?: object) {
  return {
    rewardId, segmentIndex: 0, weight: 30, totalWeight: 99,
    snapshot: {
      rewardId, code: 'reward-code', title: 'Reward', type, segmentIndex: 0, weight: '30',
      imageUrl: null, amountExact, ...(asset ? { asset } : {}),
    },
  };
}

function baseReward(type: string) {
  return {
    rewardId, code: 'reward-code', title: 'Reward', type, segmentIndex: 0, weight: '30',
    probability: { numerator: '30', denominator: '99' }, imageUrl: null,
  };
}
