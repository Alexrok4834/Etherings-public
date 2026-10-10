// COPPER_BREEDING_RULES_V1.md: only pre-operation counters 0 and 1 exist.
// Keep all ERU arithmetic in Token-2022 base units, including the additive fee.
const PRINCIPAL_ERU_UNITS = [
  [30_000_000_000n, 40_000_000_000n],
  [40_000_000_000n, 50_000_000_000n],
];
const ERT_COST = [[150, 200], [200, 250]];
const ERU_SCALE = 1_000_000_000n;

function decimal(units) {
  const fraction = (units % ERU_SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return `${units / ERU_SCALE}${fraction ? `.${fraction}` : ''}`;
}

export function cooperBreedingPrice(firstUses, secondUses) {
  if (!Number.isInteger(firstUses) || !Number.isInteger(secondUses) ||
      firstUses < 0 || firstUses > 1 || secondUses < 0 || secondUses > 1)
    return null;
  const principal = PRINCIPAL_ERU_UNITS[firstUses][secondUses];
  const fee = (principal * 200n + 9_999n) / 10_000n;
  return Object.freeze({ firstUses, secondUses, ertExact: String(ERT_COST[firstUses][secondUses]),
    eruPrincipalExact: decimal(principal), eruFeeExact: decimal(fee),
    eruTotalExact: decimal(principal + fee),
    eruPrincipalUnits: principal, eruFeeUnits: fee });
}
