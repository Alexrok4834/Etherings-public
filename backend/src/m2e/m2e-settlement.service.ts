import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { canonicalErt, displayErt, ErtDecimal, parseUnsignedErtDecimal } from './ert-decimal';
import { M2E_BALANCE_CONFIG_VERSION, M2E_EARNING_RULES_VERSION } from './m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';
import { M2eEarningCalculator } from './m2e-earning-calculator';

export type M2eSettlementInput = {
  userId: string;
  batchRecordId: string;
  cumulativeAcceptedSteps: number;
  alreadyCreditedErt: string;
  snapshot: M2eDailyEconomicSnapshot;
};

export type M2eSettlementResult = {
  snapshotId: string;
  rulesVersion: typeof M2E_EARNING_RULES_VERSION;
  balanceConfigVersion: typeof M2E_BALANCE_CONFIG_VERSION;
  ringCount: number;
  selectedRingId: string;
  selectedRingComfort: number;
  stepCap: number;
  cumulativeAcceptedSteps: number;
  validSteps: number;
  exactNumerator: string;
  exactDenominator: string;
  comfortMultiplier: string;
  cumulativeAuthoritativeErt: string;
  cumulativeDisplayedErt: string;
  deltaAuthoritativeErt: string;
  deltaDisplayedErt: string;
};

@Injectable()
export class M2eSettlementService {
  constructor(
    private readonly calculator: M2eEarningCalculator,
    private readonly ledger: LedgerService,
  ) {}

  async settleInTransaction(
    manager: EntityManager,
    input: M2eSettlementInput,
  ): Promise<M2eSettlementResult> {
    const snapshot = input.snapshot;
    if (snapshot.userId !== input.userId) throw new Error('M2E snapshot owner mismatch');
    if (snapshot.rulesVersion !== M2E_EARNING_RULES_VERSION
      || snapshot.balanceConfigVersion !== M2E_BALANCE_CONFIG_VERSION) {
      throw new Error('Unsupported M2E snapshot version');
    }

    const calculation = this.calculator.calculateWithConfig({
      validatedDailySteps: input.cumulativeAcceptedSteps,
      ringCount: snapshot.ringCount,
      comfort: snapshot.selectedRingComfort,
    }, {
      version: M2E_BALANCE_CONFIG_VERSION,
      baseSteps: snapshot.baseSteps,
      extraStepsPerRing: snapshot.extraStepsPerRing,
      baseErtPer1000Steps: snapshot.baseErtPer1000Steps,
      comfortCurveK: snapshot.comfortCurveK,
    });
    if (calculation.stepCap !== snapshot.stepCap) {
      throw new Error('M2E snapshot step cap does not match its frozen constants');
    }

    const alreadyCredited = parseUnsignedErtDecimal(input.alreadyCreditedErt, 'alreadyCreditedErt');
    const delta = new ErtDecimal(calculation.authoritativeErt).minus(alreadyCredited);
    if (delta.isNegative()) {
      throw new Error('M2E cumulative entitlement is below the already credited amount');
    }
    const deltaAuthoritativeErt = canonicalErt(delta);
    if (!delta.isZero()) {
      await this.ledger.creditDecimalInTransaction(manager, {
        userId: input.userId,
        amount: deltaAuthoritativeErt,
        type: LedgerTransactionType.WalkReward,
        referenceType: 'm2e_step_sync_batch',
        referenceId: input.batchRecordId,
        metadata: {
          snapshotId: snapshot.id,
          accountingDate: snapshot.accountingDate,
          rulesVersion: snapshot.rulesVersion,
          balanceConfigVersion: snapshot.balanceConfigVersion,
          cumulativeAcceptedSteps: input.cumulativeAcceptedSteps,
          cumulativeAuthoritativeErt: calculation.authoritativeErt,
          deltaAuthoritativeErt,
        },
      });
    }

    return {
      snapshotId: snapshot.id,
      rulesVersion: snapshot.rulesVersion,
      balanceConfigVersion: snapshot.balanceConfigVersion,
      ringCount: snapshot.ringCount,
      selectedRingId: snapshot.selectedRingId,
      selectedRingComfort: snapshot.selectedRingComfort,
      stepCap: snapshot.stepCap,
      cumulativeAcceptedSteps: input.cumulativeAcceptedSteps,
      validSteps: calculation.validSteps,
      exactNumerator: calculation.exactNumerator,
      exactDenominator: calculation.exactDenominator,
      comfortMultiplier: calculation.comfortMultiplier,
      cumulativeAuthoritativeErt: calculation.authoritativeErt,
      cumulativeDisplayedErt: calculation.displayedErt,
      deltaAuthoritativeErt,
      deltaDisplayedErt: displayErt(deltaAuthoritativeErt),
    };
  }
}
