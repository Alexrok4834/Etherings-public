import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlphaDraw } from '../src/draw.js';

const configId = '12345678-1234-4234-8234-123456789abc';
const types = ['ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX'];
const rewards = types.map((type, segmentIndex) => {
  const rewardId = `12345678-1234-4234-8234-123456789ab${segmentIndex}`;
  const weight = [90, 6, 3, 1][segmentIndex];
  return { reward_id: rewardId, reward_type: type, segment_index: segmentIndex,
    weight, amount_exact: [ '10', '5', null, null ][segmentIndex],
    reward_snapshot: { rewardId, type, segmentIndex, weight: String(weight),
      title: type, code: type } };
});

test('Draw read separates ineligible Cooper from confirmed receipt and returns exact ERT', async () => {
  for (const state of [null, 'PENDING', 'CONFIRMED']) {
    const pool = { async query(sql) {
      if (sql.includes('alpha_draw_configurations')) return { rows: [{ id: configId,
        title: 'Draw', cost_ert: '5', daily_user_attempt_limit: 5 }] };
      if (sql.includes('alpha_draw_configuration_rewards')) return { rows: rewards };
      if (sql.includes('count(*)::int AS used')) return { rows: [{ used: 0 }] };
      if (sql.includes('SELECT f.state FROM alpha_draw_results'))
        return { rows: state ? [{ state }] : [] };
      if (sql.includes('alpha_ert_available')) return { rows: [{ available: '1.91' }] };
      throw new Error('Unexpected Draw query');
    } };
    const draw = createAlphaDraw({ pool,
      auth: { async me() { return { status: 200, body: { id: 'account' } }; } },
      walletEnvironment: 'alpha-dev' });
    const response = await draw.current('token');
    assert.equal(response.status, 200);
    assert.equal(response.body.draw.availableErtExact, '1.91');
    const cooper = response.body.draw.displayRewards[2];
    assert.equal(cooper.eligible, state === null);
    assert.equal(cooper.receivedToday, state === 'CONFIRMED');
  }
});
