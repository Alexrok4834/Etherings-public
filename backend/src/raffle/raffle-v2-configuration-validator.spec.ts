import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRaffleV2Configuration } from './raffle-v2-configuration-validator';

function reward(index: number, type: 'ERT' | 'ERU' | 'COPPER_RING', amount: string | null, weight: number) {
  const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return {
    rewardId: id,
    segmentIndex: index,
    weight,
    snapshot: { rewardId: id, type, amountExact: amount },
    live: {
      id, type, active: true,
      amount: type === 'ERT' ? amount : null,
      amountExact: type === 'ERU' ? amount : null,
      stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
    },
  };
}

describe('Raffle v2 canonical configuration validation', () => {
  it('derives exact weighted economy without selecting or fulfilling a reward', () => {
    const result = validateRaffleV2Configuration({
      costErtExact: '5',
      dailyUserAttemptLimit: 5,
      rewards: [
        reward(0, 'ERT', '5', 50),
        reward(1, 'ERT', '10', 30),
        reward(2, 'ERU', '1', 19),
        reward(3, 'COPPER_RING', null, 1),
      ],
    });

    assert.equal(result.valid, true);
    assert.equal(result.totalWeight, '100');
    assert.deepEqual(result.economy.expectedPerDraw, {
      ertExact: '5.5', eruExact: '0.19', ringsExact: '0.01',
    });
    assert.deepEqual(result.economy.expectedPerUserDayAtLimit, {
      ertExact: '27.5', eruExact: '0.95', ringsExact: '0.05',
    });
    assert.equal(result.issues[0].code, 'ERT_EXPECTED_RETURN_NOT_BELOW_COST');
    assert.equal(result.issues[0].severity, 'WARNING');
  });

  it('rejects runtime-unsupported limits and malformed snapshot identity', () => {
    const limited = reward(0, 'ERT', '5', 1);
    const result = validateRaffleV2Configuration({
      costErtExact: '5', dailyUserAttemptLimit: 5,
      rewards: [{
        ...limited,
        snapshot: { ...limited.snapshot, rewardId: '20000000-0000-4000-8000-000000000001' },
        live: { ...limited.live, perUserLimit: 1 },
      }],
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.filter((issue) => issue.severity === 'ERROR').map((issue) => issue.code),
      ['REWARD_IDENTITY_MISMATCH', 'REWARD_LIMIT_UNSUPPORTED'],
    );
  });

  it('validates fractional ERU against fixed-scale PostgreSQL values and calculates exactly', () => {
    const fractional = reward(0, 'ERU', '1.235', 1);
    fractional.live.amountExact = '1.235000000000000000';
    const result = validateRaffleV2Configuration({
      costErtExact: '5', dailyUserAttemptLimit: 5, rewards: [fractional],
    });
    assert.equal(result.valid, true);
    assert.equal(result.economy.expectedPerDraw.eruExact, '1.235');
    assert.equal(result.economy.expectedPerUserDayAtLimit.eruExact, '6.175');
  });
});
