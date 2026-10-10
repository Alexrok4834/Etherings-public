import { randomInt } from 'node:crypto';

// Shared Alpha adaptation of MVP CopperRingRandomService: both starter and
// raffle issuance use the same 2..20 attributes and approved visual variants.
export const COOPER_VISUAL_CODES = Object.freeze([
  'copper_plain_polished', 'copper_rune_rough', 'copper_twisted',
  'copper_geometric', 'copper_milgrain', 'copper_leaves',
  'copper_celtic', 'copper_filigree', 'copper_signet'
]);

export function generateCooperInitial(sample = randomInt) {
  function next(min, max) {
    const value = sample(min, max);
    if (!Number.isInteger(value) || value < min || value >= max)
      throw new Error('Cooper RNG returned an out-of-contract value');
    return value;
  }
  return {
    comfort: next(2, 21), charm: next(2, 21),
    quality: next(2, 21), luck: next(2, 21),
    visualVariantCode: COOPER_VISUAL_CODES[next(0, COOPER_VISUAL_CODES.length)]
  };
}
