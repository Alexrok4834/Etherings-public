export const COPPER_LEVEL_UP_V1_VERSION = 'copper-level-up-v1';
export const COPPER_LEVEL_UP_V2_VERSION = 'copper-level-up-v2';
export const COPPER_LEVEL_UP_VERSION = COPPER_LEVEL_UP_V2_VERSION;
export const COPPER_MAX_LEVEL = 20;
export const COPPER_LEVEL_ALLOCATION_POINTS = 4;

export const COPPER_ATTRIBUTE_NAMES = Object.freeze([
  'comfort',
  'charm',
  'quality',
  'luck',
] as const);

export type CopperAttributeName = typeof COPPER_ATTRIBUTE_NAMES[number];

export type CopperAttributeAllocation = Readonly<Record<CopperAttributeName, number>>;
export type CopperAttributes = Readonly<Record<CopperAttributeName, number>>;

export type CopperLevelTransition = Readonly<{
  rulesVersion: typeof COPPER_LEVEL_UP_VERSION;
  currentLevel: number;
  targetLevel: number;
  ertCost: number;
  eruCost: number;
  allocationPoints: typeof COPPER_LEVEL_ALLOCATION_POINTS;
  requiresEruLedger: boolean;
}>;

export enum CopperLevelRuleViolationCode {
  InvalidAllocation = 'INVALID_COPPER_ATTRIBUTE_ALLOCATION',
}

export class CopperLevelRuleViolation extends Error {
  constructor(readonly code: CopperLevelRuleViolationCode) {
    super(code);
    this.name = 'CopperLevelRuleViolation';
  }
}

function transition(
  currentLevel: number,
  targetLevel: number,
  ertCost: number,
  eruCost = 0,
): CopperLevelTransition {
  return Object.freeze({
    rulesVersion: COPPER_LEVEL_UP_VERSION,
    currentLevel,
    targetLevel,
    ertCost,
    eruCost,
    allocationPoints: COPPER_LEVEL_ALLOCATION_POINTS,
    requiresEruLedger: eruCost > 0,
  });
}

export const COPPER_LEVEL_TRANSITIONS: readonly CopperLevelTransition[] = Object.freeze([
  transition(1, 2, 12),
  transition(2, 3, 16),
  transition(3, 4, 20),
  transition(4, 5, 24, 30),
  transition(5, 6, 28),
  transition(6, 7, 32),
  transition(7, 8, 36),
  transition(8, 9, 40),
  transition(9, 10, 44),
  transition(10, 11, 48),
  transition(11, 12, 52),
  transition(12, 13, 56),
  transition(13, 14, 60),
  transition(14, 15, 64),
  transition(15, 16, 68),
  transition(16, 17, 72),
  transition(17, 18, 76),
  transition(18, 19, 80),
  transition(19, 20, 84, 60),
]);

const transitionsBySourceAndTarget = new Map(
  COPPER_LEVEL_TRANSITIONS.map((rule) => [`${rule.currentLevel}:${rule.targetLevel}`, rule]),
);

export function findCopperLevelTransition(
  currentLevel: number,
  targetLevel: number,
): CopperLevelTransition | null {
  return transitionsBySourceAndTarget.get(`${currentLevel}:${targetLevel}`) ?? null;
}

export function parseCopperAttributeAllocation(input: unknown): CopperAttributeAllocation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidAllocation();
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== COPPER_ATTRIBUTE_NAMES.length
    || keys.some((key) => !COPPER_ATTRIBUTE_NAMES.includes(key as CopperAttributeName))) {
    throw invalidAllocation();
  }

  const values = COPPER_ATTRIBUTE_NAMES.map((name) => record[name]);
  if (values.some((value) => typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0)) {
    throw invalidAllocation();
  }

  const points = values.reduce<number>((sum, value) => sum + (value as number), 0);
  if (points !== COPPER_LEVEL_ALLOCATION_POINTS) {
    throw invalidAllocation();
  }

  return Object.freeze({
    comfort: record.comfort as number,
    charm: record.charm as number,
    quality: record.quality as number,
    luck: record.luck as number,
  });
}

export function applyCopperAttributeAllocation(
  current: CopperAttributes,
  allocation: CopperAttributeAllocation,
): CopperAttributes {
  return Object.freeze({
    comfort: current.comfort + allocation.comfort,
    charm: current.charm + allocation.charm,
    quality: current.quality + allocation.quality,
    luck: current.luck + allocation.luck,
  });
}

function invalidAllocation() {
  return new CopperLevelRuleViolation(CopperLevelRuleViolationCode.InvalidAllocation);
}
