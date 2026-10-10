import { RAFFLE_V2_DAILY_ATTEMPT_LIMIT, RAFFLE_V2_ENTRY_COST_ERT } from './raffle-v2-economy-rules';

export const RAFFLE_V2_CONSOLIDATION_MANIFEST_VERSION = 'raffle-v2-consolidation-v1';

export type RaffleV2ManifestReward = Readonly<{
  code: string;
  title: string;
  type: 'ERT' | 'ERU' | 'COPPER_RING';
  amountExact: string | null;
  segmentIndex: number;
  weight: number;
  stockTotal: null;
  stockRemaining: null;
}>;

export type RaffleV2ConsolidationManifest = Readonly<{
  version: string;
  machineCode: string;
  contractVersion: 'raffle-v2';
  title: string;
  description: string;
  costErtExact: string;
  dailyUserAttemptLimit: number;
  rewards: readonly RaffleV2ManifestReward[];
}>;

export const RAFFLE_V2_CONSOLIDATION_MANIFEST = deepFreeze({
  version: RAFFLE_V2_CONSOLIDATION_MANIFEST_VERSION,
  machineCode: 'daily-draw',
  contractVersion: 'raffle-v2',
  title: 'Daily Draw',
  description: 'Five paid Draws per UTC day with one server-selected reward per Draw.',
  costErtExact: RAFFLE_V2_ENTRY_COST_ERT,
  dailyUserAttemptLimit: RAFFLE_V2_DAILY_ATTEMPT_LIMIT,
  rewards: [
    reward('raffle-v2-ert-5-v1', '5 ERT', 'ERT', '5', 0, 30),
    reward('raffle-v2-ert-10-v1', '10 ERT', 'ERT', '10', 1, 20),
    reward('raffle-v2-ert-20-v1', '20 ERT', 'ERT', '20', 2, 12),
    reward('raffle-v2-ert-50-v1', '50 ERT', 'ERT', '50', 3, 6),
    reward('raffle-v2-eru-1-v1', '1 ERU', 'ERU', '1', 4, 15),
    reward('raffle-v2-eru-5-v1', '5 ERU', 'ERU', '5', 5, 9),
    reward('raffle-v2-eru-10-v1', '10 ERU', 'ERU', '10', 6, 5),
    reward('raffle-v2-eru-30-v1', '30 ERU', 'ERU', '30', 7, 2),
    reward('raffle-v2-cooper-ring-v1', 'Cooper Ring', 'COPPER_RING', null, 8, 1),
  ],
} satisfies RaffleV2ConsolidationManifest);

export function validateRaffleV2ConsolidationManifest(input: unknown): RaffleV2ConsolidationManifest {
  const manifest = requireRecord(input, 'manifest');
  exactKeys(manifest, [
    'version', 'machineCode', 'contractVersion', 'title', 'description',
    'costErtExact', 'dailyUserAttemptLimit', 'rewards',
  ], 'manifest');
  equal(manifest.version, RAFFLE_V2_CONSOLIDATION_MANIFEST_VERSION, 'manifest version');
  equal(manifest.machineCode, 'daily-draw', 'machine code');
  equal(manifest.contractVersion, 'raffle-v2', 'contract version');
  boundedText(manifest.title, 128, 'title');
  boundedText(manifest.description, 512, 'description');
  equal(manifest.costErtExact, RAFFLE_V2_ENTRY_COST_ERT, 'entry cost');
  equal(manifest.dailyUserAttemptLimit, RAFFLE_V2_DAILY_ATTEMPT_LIMIT, 'daily attempt limit');
  if (!Array.isArray(manifest.rewards) || manifest.rewards.length !== 9) invalid('reward count');

  const codes = new Set<string>();
  let totalWeight = 0;
  const familyAmounts = new Map<string, string[]>();
  for (const [position, value] of manifest.rewards.entries()) {
    const item = requireRecord(value, `reward ${position}`);
    exactKeys(item, [
      'code', 'title', 'type', 'amountExact', 'segmentIndex', 'weight', 'stockTotal', 'stockRemaining',
    ], `reward ${position}`);
    const code = boundedText(item.code, 64, `reward ${position} code`);
    if (codes.has(code)) invalid('duplicate reward code');
    codes.add(code);
    boundedText(item.title, 128, `reward ${position} title`);
    if (!['ERT', 'ERU', 'COPPER_RING'].includes(String(item.type))) invalid('unsupported reward type');
    equal(item.segmentIndex, position, `reward ${position} segment`);
    if (!Number.isSafeInteger(item.weight) || Number(item.weight) <= 0) invalid('nonpositive reward weight');
    totalWeight += Number(item.weight);
    equal(item.stockTotal, null, `reward ${position} stockTotal`);
    equal(item.stockRemaining, null, `reward ${position} stockRemaining`);

    if (item.type === 'COPPER_RING') {
      equal(item.amountExact, null, 'Cooper amount');
      equal(position, 8, 'Cooper segment');
      equal(item.weight, 1, 'Cooper weight');
    } else {
      const amount = canonicalPositiveInteger(item.amountExact, `reward ${position} amount`);
      const amounts = familyAmounts.get(String(item.type)) ?? [];
      amounts.push(amount);
      familyAmounts.set(String(item.type), amounts);
    }
  }
  equal(totalWeight, 100, 'total weight');
  equal(familyAmounts.get('ERT')?.join(','), '5,10,20,50', 'ERT amounts');
  equal(familyAmounts.get('ERU')?.join(','), '1,5,10,30', 'ERU amounts');

  return deepFreeze(structuredClone(input) as RaffleV2ConsolidationManifest);
}

function reward(
  code: string,
  title: string,
  type: RaffleV2ManifestReward['type'],
  amountExact: string | null,
  segmentIndex: number,
  weight: number,
): RaffleV2ManifestReward {
  return { code, title, type, amountExact, segmentIndex, weight, stockTotal: null, stockRemaining: null };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid(`${label} fields`);
}

function boundedText(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) invalid(label);
  return value;
}

function canonicalPositiveInteger(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalid(label);
  return value;
}

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) invalid(label);
}

function invalid(label: string): never {
  throw new Error(`Invalid Raffle v2 consolidation manifest: ${label}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
