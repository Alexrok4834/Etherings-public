import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CopperVisualVariant } from './game-ring.entity';
import { CopperRingRandomService } from './copper-ring-random.service';

class SequenceRandomService extends CopperRingRandomService {
  readonly calls: Array<{ min: number; maxExclusive: number }> = [];

  constructor(private readonly values: number[]) {
    super();
  }

  protected override nextInt(min: number, maxExclusive: number) {
    this.calls.push({ min, maxExclusive });
    const value = this.values.shift();
    if (value === undefined) throw new Error('Test RNG sequence exhausted');
    return value;
  }
}

describe('CopperRingRandomService', () => {
  it('draws every initial attribute independently from the inclusive 2..20 range', () => {
    const random = new SequenceRandomService([2, 20, 7, 11]);

    assert.deepEqual(random.generateAttributes(), {
      comfort: 2,
      charm: 20,
      quality: 7,
      luck: 11,
    });
    assert.deepEqual(random.calls, Array.from({ length: 4 }, () => ({ min: 2, maxExclusive: 21 })));
  });

  it('selects one of the nine approved visual variants with a uniform index draw', () => {
    const variants = Object.values(CopperVisualVariant);
    const random = new SequenceRandomService([variants.length - 1]);

    assert.equal(random.selectVisualVariant(), variants.at(-1));
    assert.deepEqual(random.calls, [{ min: 0, maxExclusive: 9 }]);
  });
});
