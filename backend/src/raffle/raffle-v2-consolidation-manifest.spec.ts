import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RAFFLE_V2_CONSOLIDATION_MANIFEST,
  validateRaffleV2ConsolidationManifest,
} from './raffle-v2-consolidation-manifest';

describe('Raffle v2 consolidation manifest', () => {
  it('freezes the approved nine-outcome economy', () => {
    const result = validateRaffleV2ConsolidationManifest(RAFFLE_V2_CONSOLIDATION_MANIFEST);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.rewards), true);
    assert.deepEqual(result.rewards.map(({ type, amountExact, weight }) => ({ type, amountExact, weight })), [
      { type: 'ERT', amountExact: '5', weight: 30 },
      { type: 'ERT', amountExact: '10', weight: 20 },
      { type: 'ERT', amountExact: '20', weight: 12 },
      { type: 'ERT', amountExact: '50', weight: 6 },
      { type: 'ERU', amountExact: '1', weight: 15 },
      { type: 'ERU', amountExact: '5', weight: 9 },
      { type: 'ERU', amountExact: '10', weight: 5 },
      { type: 'ERU', amountExact: '30', weight: 2 },
      { type: 'COPPER_RING', amountExact: null, weight: 1 },
    ]);
  });

  for (const [name, mutate] of Object.entries({
    'unknown top-level field': (value: any) => { value.extra = true; },
    'economy mismatch': (value: any) => { value.costErtExact = '6'; },
    'duplicate code': (value: any) => { value.rewards[1].code = value.rewards[0].code; },
    'noncanonical amount': (value: any) => { value.rewards[0].amountExact = '05'; },
    'unsupported type': (value: any) => { value.rewards[0].type = 'BADGE'; },
    'noncontiguous segment': (value: any) => { value.rewards[2].segmentIndex = 3; },
    'nonpositive weight': (value: any) => { value.rewards[0].weight = 0; },
    'wrong total weight': (value: any) => { value.rewards[0].weight = 29; },
    'mutable Cooper stock': (value: any) => { value.rewards[8].stockTotal = 1; },
    'numeric Cooper amount': (value: any) => { value.rewards[8].amountExact = '1'; },
  })) {
    it(`rejects ${name}`, () => {
      const changed = structuredClone(RAFFLE_V2_CONSOLIDATION_MANIFEST) as any;
      mutate(changed);
      assert.throws(() => validateRaffleV2ConsolidationManifest(changed), /Invalid Raffle v2 consolidation manifest/);
    });
  }
});
