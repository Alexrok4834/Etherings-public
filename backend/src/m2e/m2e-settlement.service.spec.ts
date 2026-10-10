import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { LedgerService } from '../balance/ledger.service';
import { canonicalErt, ErtDecimal } from './ert-decimal';
import { M2eBalanceConfigService } from './m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';
import { M2eEarningCalculator } from './m2e-earning-calculator';
import { M2eSettlementService } from './m2e-settlement.service';

function setup() {
  const credits: Array<Record<string, unknown>> = [];
  const ledger = {
    async creditDecimalInTransaction(_manager: EntityManager, input: Record<string, unknown>) {
      credits.push(input);
      return {
        balance: { ertBalance: input.amount, lifetimeEarnedErt: input.amount, lifetimeSpentErt: '0' },
        ledgerTransaction: { id: 'ledger-1', amount: input.amount, balanceAfter: input.amount },
      };
    },
  } as unknown as LedgerService;
  const config = new M2eBalanceConfigService({ get: () => undefined } as unknown as ConfigService);
  return {
    service: new M2eSettlementService(new M2eEarningCalculator(config), ledger),
    credits,
    manager: {} as EntityManager,
  };
}

function snapshot(overrides: Partial<M2eDailyEconomicSnapshot> = {}) {
  return {
    id: 'snapshot-1',
    userId: 'user-1',
    accountingDate: '2026-08-21',
    selectedRingId: 'ring-1',
    ringCount: 1,
    selectedRingComfort: 20,
    stepCap: 5000,
    rulesVersion: 'move-to-earn-earning-v1',
    balanceConfigVersion: 'move-to-earn-balance-v1',
    baseSteps: 5000,
    extraStepsPerRing: 1000,
    baseErtPer1000Steps: '0.871',
    comfortCurveK: 20,
    ...overrides,
  } as M2eDailyEconomicSnapshot;
}

describe('M2eSettlementService', () => {
  it('credits the exact cumulative delta and returns complete immutable evidence', async () => {
    const state = setup();
    const result = await state.service.settleInTransaction(state.manager, {
      userId: 'user-1',
      batchRecordId: 'batch-1',
      cumulativeAcceptedSteps: 5000,
      alreadyCreditedErt: '0',
      snapshot: snapshot(),
    });

    assert.deepEqual(result, {
      snapshotId: 'snapshot-1',
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
      ringCount: 1,
      selectedRingId: 'ring-1',
      selectedRingComfort: 20,
      stepCap: 5000,
      cumulativeAcceptedSteps: 5000,
      validSteps: 5000,
      exactNumerator: '2613',
      exactDenominator: '400',
      comfortMultiplier: '1.5',
      cumulativeAuthoritativeErt: '6.5325',
      cumulativeDisplayedErt: '6.53',
      deltaAuthoritativeErt: '6.5325',
      deltaDisplayedErt: '6.53',
    });
    assert.deepEqual(state.credits.map((credit) => ({
      amount: credit.amount,
      referenceType: credit.referenceType,
      referenceId: credit.referenceId,
    })), [{
      amount: '6.5325',
      referenceType: 'm2e_step_sync_batch',
      referenceId: 'batch-1',
    }]);
  });

  it('makes cumulative settlement independent of batch partitioning', async () => {
    const state = setup();
    const first = await state.service.settleInTransaction(state.manager, {
      userId: 'user-1', batchRecordId: 'batch-1', cumulativeAcceptedSteps: 197,
      alreadyCreditedErt: '0', snapshot: snapshot(),
    });
    const second = await state.service.settleInTransaction(state.manager, {
      userId: 'user-1', batchRecordId: 'batch-2', cumulativeAcceptedSteps: 5000,
      alreadyCreditedErt: first.cumulativeAuthoritativeErt, snapshot: snapshot(),
    });

    assert.equal(second.cumulativeAuthoritativeErt, '6.5325');
    const credited = state.credits.reduce(
      (sum, credit) => sum.plus(String(credit.amount)),
      new ErtDecimal(0),
    );
    assert.equal(canonicalErt(credited), '6.5325');
  });

  it('records zero delta without creating a ledger row', async () => {
    const state = setup();
    const result = await state.service.settleInTransaction(state.manager, {
      userId: 'user-1', batchRecordId: 'batch-1', cumulativeAcceptedSteps: 5000,
      alreadyCreditedErt: '6.5325', snapshot: snapshot(),
    });
    assert.equal(result.deltaAuthoritativeErt, '0');
    assert.equal(result.deltaDisplayedErt, '0.00');
    assert.deepEqual(state.credits, []);
  });

  it('fails closed when prior credits exceed the frozen cumulative entitlement', async () => {
    const state = setup();
    await assert.rejects(() => state.service.settleInTransaction(state.manager, {
      userId: 'user-1', batchRecordId: 'batch-1', cumulativeAcceptedSteps: 5000,
      alreadyCreditedErt: '6.532500000000000001', snapshot: snapshot(),
    }), /below the already credited amount/);
    assert.deepEqual(state.credits, []);
  });

  it('rejects owner, version, and frozen-cap inconsistencies before ledger mutation', async () => {
    for (const invalidSnapshot of [
      snapshot({ userId: 'user-other' }),
      snapshot({ rulesVersion: 'future-rules' as never }),
      snapshot({ stepCap: 6000 }),
    ]) {
      const state = setup();
      await assert.rejects(() => state.service.settleInTransaction(state.manager, {
        userId: 'user-1', batchRecordId: 'batch-1', cumulativeAcceptedSteps: 1,
        alreadyCreditedErt: '0', snapshot: invalidSnapshot,
      }));
      assert.deepEqual(state.credits, []);
    }
  });
});
