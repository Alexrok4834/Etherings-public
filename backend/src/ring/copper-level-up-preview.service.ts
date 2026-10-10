import { Injectable } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { canonicalEru, displayEru, eruCompatibilityNumber, hasEnoughEru } from '../balance/eru-decimal';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import {
  COPPER_LEVEL_UP_VERSION,
  COPPER_LEVEL_ALLOCATION_POINTS,
  findCopperLevelTransition,
} from './copper-level-up.rules';
import {
  copperLevelPreviewRequestInvalid,
  copperLevelStale,
  copperLevelTransitionInvalid,
} from './copper-level-up-errors';
import { CopperRingRepository } from './copper-ring.repository';
import {
  copperRingNotFound,
  copperRingStateConflict,
  withCopperRingReadContract,
} from './copper-ring-errors';

const previewRequestFields = Object.freeze(['expectedCurrentLevel', 'targetLevel']);

export enum CopperLevelUpBlocker {
  InsufficientErt = 'INSUFFICIENT_ERT',
  InsufficientEru = 'INSUFFICIENT_ERU',
}

export type CopperLevelPreviewRequest = {
  expectedCurrentLevel: number;
  targetLevel: number;
};

export type CopperMilestonePreview = {
  level: number;
  utilities: ReadonlyArray<{
    code: string;
    available: false;
  }>;
};

@Injectable()
export class CopperLevelUpPreviewService {
  constructor(private readonly repository: CopperRingRepository) {}

  async preview(user: User, ringId: string, input: unknown) {
    const request = this.parseRequest(input);
    return withCopperRingReadContract(() => this.repository.transaction(async (manager) => {
      const ring = await this.repository.findOwnedRing(manager, user.id, ringId);
      if (!ring) throw copperRingNotFound();
      if (ring.level !== request.expectedCurrentLevel) throw copperLevelStale();

      const transition = findCopperLevelTransition(ring.level, request.targetLevel);
      if (!transition) throw copperLevelTransitionInvalid();

      const balance = await this.repository.findErtBalance(manager, user.id);
      if (!balance) throw copperRingStateConflict();
      const ertBalanceExact = canonicalErt(
        parseUnsignedErtDecimal(balance.ertBalance, 'ertBalance'),
      );
      const ertCostExact = canonicalErt(String(transition.ertCost));
      const canAffordErt = new ErtDecimal(ertBalanceExact).greaterThanOrEqualTo(ertCostExact);
      const eruBalanceExact = canonicalEru(balance.eruBalance, 'eruBalance');
      const eruCostExact = canonicalEru(String(transition.eruCost), 'eruCost');
      const canAffordEru = hasEnoughEru(eruBalanceExact, eruCostExact);

      const currentAttributes = {
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
      };
      const resultingUnspentPoints = ring.unspentAttributePoints + COPPER_LEVEL_ALLOCATION_POINTS;
      if (!Number.isSafeInteger(ring.unspentAttributePoints)
        || ring.unspentAttributePoints < 0
        || resultingUnspentPoints > 76) {
        throw copperRingStateConflict();
      }
      const blockers: CopperLevelUpBlocker[] = [];
      if (!canAffordErt) blockers.push(CopperLevelUpBlocker.InsufficientErt);
      if (!canAffordEru) blockers.push(CopperLevelUpBlocker.InsufficientEru);

      return {
        rulesVersion: COPPER_LEVEL_UP_VERSION,
        ringId: ring.id,
        current: {
          level: ring.level,
          attributes: currentAttributes,
          unspentAttributePoints: ring.unspentAttributePoints,
        },
        target: {
          level: transition.targetLevel,
          attributes: currentAttributes,
          unspentAttributePoints: resultingUnspentPoints,
        },
        grantedAttributePoints: COPPER_LEVEL_ALLOCATION_POINTS,
        cost: {
          ert: transition.ertCost,
          ertExact: ertCostExact,
          ertDisplay: displayErt(ertCostExact),
          eru: transition.eruCost,
          eruExact: eruCostExact,
          eruDisplay: displayEru(eruCostExact),
        },
        balances: {
          ert: Number(ertBalanceExact),
          ertExact: ertBalanceExact,
          ertDisplay: displayErt(ertBalanceExact),
          eru: eruCompatibilityNumber(eruBalanceExact),
          eruExact: eruBalanceExact,
          eruDisplay: displayEru(eruBalanceExact),
        },
        affordability: {
          ert: canAffordErt,
          eru: canAffordEru,
        },
        dependencies: {
          ertLedger: { required: true, available: true },
          eruLedger: {
            required: transition.requiresEruLedger,
            available: transition.requiresEruLedger ? true : null,
          },
        },
        available: blockers.length === 0,
        blockers,
        milestone: milestoneFor(transition.targetLevel),
      };
    }));
  }

  private parseRequest(input: unknown): CopperLevelPreviewRequest {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw copperLevelPreviewRequestInvalid();
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== previewRequestFields.length
      || keys.some((key) => !previewRequestFields.includes(key))) {
      throw copperLevelPreviewRequestInvalid();
    }
    if (!Number.isSafeInteger(record.expectedCurrentLevel)
      || !Number.isSafeInteger(record.targetLevel)) {
      throw copperLevelPreviewRequestInvalid();
    }

    return {
      expectedCurrentLevel: record.expectedCurrentLevel as number,
      targetLevel: record.targetLevel as number,
    };
  }
}

function milestoneFor(targetLevel: number): CopperMilestonePreview | null {
  const utilities = targetLevel === 5
    ? ['BREEDING', 'GEM_SLOT']
    : targetLevel === 10
      ? ['RING_SHOW_STAKING']
      : targetLevel === 20
        ? ['TRANSFORMATION']
        : null;
  if (!utilities) return null;
  return {
    level: targetLevel,
    utilities: utilities.map((code) => ({ code, available: false as const })),
  };
}
