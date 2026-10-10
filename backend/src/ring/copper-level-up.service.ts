import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import {
  ERU_COPPER_LEVEL_UP_REFERENCE,
  EruLedgerService,
} from '../balance/eru-ledger.service';
import { canonicalEru, displayEru, eruCompatibilityNumber, hasEnoughEru } from '../balance/eru-decimal';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import {
  copperLevelIdempotencyConflict,
  copperLevelInsufficientEru,
  copperLevelInsufficientErt,
  copperLevelMutationRequestInvalid,
  copperLevelStale,
  copperLevelTransitionInvalid,
  copperLevelWriteUnavailable,
} from './copper-level-up-errors';
import { CopperLevelUpOperationStatus } from './copper-level-up-operation.entity';
import {
  COPPER_LEVEL_UP_VERSION,
  COPPER_LEVEL_ALLOCATION_POINTS,
  findCopperLevelTransition,
} from './copper-level-up.rules';
import { CopperRingRepository } from './copper-ring.repository';
import { copperRingNotFound, copperRingStateConflict } from './copper-ring-errors';
import { COPPER_RULESET_VERSION } from './game-ring.entity';
import { RingEventType } from './ring-event.entity';

const requestFields = Object.freeze([
  'expectedCurrentLevel',
  'targetLevel',
  'idempotencyKey',
]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CopperLevelUpRequest = {
  expectedCurrentLevel: number;
  targetLevel: number;
  idempotencyKey: string;
};

@Injectable()
export class CopperLevelUpService {
  constructor(
    private readonly repository: CopperRingRepository,
    private readonly ledger: LedgerService,
    private readonly eruLedger: EruLedgerService,
  ) {}

  async levelUp(user: User, ringId: string, input: unknown) {
    const request = this.parseRequest(input);
    const fingerprint = fingerprintFor(user.id, ringId, request);

    try {
      return await this.repository.transaction(async (manager) => {
        // Account-first locking prevents FK-to-FOR-UPDATE conversion deadlocks.
        const owner = await this.repository.lockOwner(manager, user.id);
        if (!owner) throw copperRingNotFound();
        const operation = await this.repository.claimLevelUpOperation(manager, {
          ownerUserId: user.id,
          ringId,
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: fingerprint,
          rulesVersion: COPPER_LEVEL_UP_VERSION,
        });
        if (!operation) throw copperRingStateConflict();
        if (operation.requestFingerprint !== fingerprint) throw copperLevelIdempotencyConflict();
        if (operation.status === CopperLevelUpOperationStatus.Completed) {
          if (!operation.responseSnapshot) throw copperRingStateConflict();
          return withExactCurrencyContract(operation.responseSnapshot);
        }

        const ring = await this.repository.findOwnedRingForUpdate(manager, user.id, ringId);
        if (!ring) throw copperRingNotFound();
        if (ring.level !== request.expectedCurrentLevel) throw copperLevelStale();

        const transition = findCopperLevelTransition(ring.level, request.targetLevel);
        if (!transition) throw copperLevelTransitionInvalid();
        const balance = await this.repository.findErtBalanceForUpdate(manager, user.id);
        if (!balance) throw copperRingStateConflict();
        const balanceBeforeExact = canonicalErt(
          parseUnsignedErtDecimal(balance.ertBalance, 'ertBalance'),
        );
        const ertCostExact = canonicalErt(String(transition.ertCost));
        if (new ErtDecimal(balanceBeforeExact).lessThan(ertCostExact)) {
          throw copperLevelInsufficientErt();
        }
        const eruBalanceBeforeExact = canonicalEru(balance.eruBalance, 'eruBalance');
        const eruCostExact = canonicalEru(String(transition.eruCost), 'eruCost');
        if (!hasEnoughEru(eruBalanceBeforeExact, eruCostExact)) {
          throw copperLevelInsufficientEru();
        }

        const attributes = attributesOf(ring);
        const unspentBefore = ring.unspentAttributePoints;
        const unspentAfter = unspentBefore + COPPER_LEVEL_ALLOCATION_POINTS;
        if (!Number.isSafeInteger(unspentBefore) || unspentBefore < 0 || unspentAfter > 76) {
          throw copperRingStateConflict();
        }
        const metadata = {
          rulesVersion: COPPER_LEVEL_UP_VERSION,
          ringId,
          currentLevel: ring.level,
          targetLevel: transition.targetLevel,
        };
        const ertDebit = await this.ledger.debitDecimalInTransaction(manager, {
          userId: user.id,
          amount: ertCostExact,
          type: LedgerTransactionType.CopperLevelUpSpend,
          referenceType: 'COPPER_LEVEL_UP',
          referenceId: operation.id,
          metadata,
        });
        const eruDebit = transition.eruCost === 0
          ? null
          : await this.eruLedger.debitInTransaction(manager, {
            userId: user.id,
            amount: eruCostExact,
            type: LedgerTransactionType.CopperLevelUpSpend,
            referenceType: ERU_COPPER_LEVEL_UP_REFERENCE,
            referenceId: operation.id,
            metadata,
          });
        const eruBalanceAfterExact = eruDebit?.ledgerTransaction.balanceAfter
          ?? eruBalanceBeforeExact;

        ring.level = transition.targetLevel;
        ring.unspentAttributePoints = unspentAfter;
        await this.repository.saveRing(manager, ring);

        const snapshot = {
          operationId: operation.id,
          rulesVersion: COPPER_LEVEL_UP_VERSION,
          ringId,
          idempotencyKey: request.idempotencyKey,
          level: { previous: transition.currentLevel, current: transition.targetLevel },
          unspentAttributePoints: {
            previous: unspentBefore,
            granted: COPPER_LEVEL_ALLOCATION_POINTS,
            current: unspentAfter,
          },
          attributes,
          cost: {
            ert: transition.ertCost,
            ertExact: ertCostExact,
            ertDisplay: displayErt(ertCostExact),
            eru: transition.eruCost,
            eruExact: eruCostExact,
            eruDisplay: displayEru(eruCostExact),
          },
          balances: {
            ertBefore: Number(balanceBeforeExact),
            ertBeforeExact: balanceBeforeExact,
            ertBeforeDisplay: displayErt(balanceBeforeExact),
            ertAfter: Number(ertDebit.balance.ertBalance),
            ertAfterExact: ertDebit.balance.ertBalance,
            ertAfterDisplay: displayErt(ertDebit.balance.ertBalance),
            eruBefore: eruCompatibilityNumber(eruBalanceBeforeExact),
            eruBeforeExact: eruBalanceBeforeExact,
            eruBeforeDisplay: displayEru(eruBalanceBeforeExact),
            eruAfter: eruCompatibilityNumber(eruBalanceAfterExact),
            eruAfterExact: eruBalanceAfterExact,
            eruAfterDisplay: displayEru(eruBalanceAfterExact),
          },
          ledgerTransactionId: ertDebit.ledgerTransaction.id,
          ledgerTransactionIds: {
            ert: ertDebit.ledgerTransaction.id,
            eru: eruDebit?.ledgerTransaction.id ?? null,
          },
        };

        await this.repository.saveLevelUpEvent(manager, {
          ringId,
          ownerUserId: user.id,
          operationKey: `level-up:${operation.id}`,
          eventType: RingEventType.LevelUp,
          rulesetVersion: COPPER_RULESET_VERSION,
          snapshot,
        });
        await this.repository.completeLevelUpOperation(manager, operation, snapshot);
        return snapshot;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof TypeORMError) throw copperLevelWriteUnavailable();
      throw error;
    }
  }

  private parseRequest(input: unknown): CopperLevelUpRequest {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw copperLevelMutationRequestInvalid();
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== requestFields.length || keys.some((key) => !requestFields.includes(key))) {
      throw copperLevelMutationRequestInvalid();
    }
    if (!Number.isSafeInteger(record.expectedCurrentLevel)
      || !Number.isSafeInteger(record.targetLevel)
      || typeof record.idempotencyKey !== 'string'
      || !uuidV4.test(record.idempotencyKey)) {
      throw copperLevelMutationRequestInvalid();
    }

    return {
      expectedCurrentLevel: record.expectedCurrentLevel as number,
      targetLevel: record.targetLevel as number,
      idempotencyKey: record.idempotencyKey.toLowerCase(),
    };
  }
}

function attributesOf(ring: { comfort: number; charm: number; quality: number; luck: number }) {
  return { comfort: ring.comfort, charm: ring.charm, quality: ring.quality, luck: ring.luck };
}

function fingerprintFor(ownerUserId: string, ringId: string, request: CopperLevelUpRequest) {
  const canonical = JSON.stringify({
    ownerUserId,
    ringId,
    expectedCurrentLevel: request.expectedCurrentLevel,
    targetLevel: request.targetLevel,
    rulesVersion: COPPER_LEVEL_UP_VERSION,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function withExactCurrencyContract(snapshot: Record<string, unknown>) {
  const cost = snapshot.cost as Record<string, unknown> | undefined;
  const balances = snapshot.balances as Record<string, unknown> | undefined;
  if (!cost || !balances) return snapshot;
  const ertCostExact = canonicalErt(String(cost.ertExact ?? cost.ert));
  const ertBeforeExact = canonicalErt(String(balances.ertBeforeExact ?? balances.ertBefore));
  const ertAfterExact = canonicalErt(String(balances.ertAfterExact ?? balances.ertAfter));
  const eruCostExact = canonicalEru(String(cost.eruExact ?? cost.eru), 'eruCost');
  const hasEruBalanceSnapshot = (balances.eruBeforeExact ?? balances.eruBefore) !== null
    && (balances.eruBeforeExact ?? balances.eruBefore) !== undefined
    && (balances.eruAfterExact ?? balances.eruAfter) !== null
    && (balances.eruAfterExact ?? balances.eruAfter) !== undefined;
  const eruBeforeExact = hasEruBalanceSnapshot
    ? canonicalEru(String(balances.eruBeforeExact ?? balances.eruBefore), 'eruBefore')
    : null;
  const eruAfterExact = hasEruBalanceSnapshot
    ? canonicalEru(String(balances.eruAfterExact ?? balances.eruAfter), 'eruAfter')
    : null;
  return {
    ...snapshot,
    cost: {
      ...cost,
      ertExact: ertCostExact,
      ertDisplay: displayErt(ertCostExact),
      eruExact: eruCostExact,
      eruDisplay: displayEru(eruCostExact),
    },
    balances: {
      ...balances,
      ertBeforeExact,
      ertBeforeDisplay: displayErt(ertBeforeExact),
      ertAfterExact,
      ertAfterDisplay: displayErt(ertAfterExact),
      ...(eruBeforeExact === null || eruAfterExact === null ? {} : {
        eruBefore: eruCompatibilityNumber(eruBeforeExact),
        eruBeforeExact,
        eruBeforeDisplay: displayEru(eruBeforeExact),
        eruAfter: eruCompatibilityNumber(eruAfterExact),
        eruAfterExact,
        eruAfterDisplay: displayEru(eruAfterExact),
      }),
    },
  };
}
