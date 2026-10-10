import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CopperRingEntitlementService } from '../ring/copper-ring-entitlement.service';
import { CopperRingRepository } from '../ring/copper-ring.repository';
import { CopperIssuanceReason } from '../ring/game-ring.entity';
import { M2eBalanceConfigService, M2E_EARNING_RULES_VERSION } from './m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';
import { m2eRingSelectionUnavailable } from './m2e-daily-snapshot.errors';
import { M2eEarningCalculator } from './m2e-earning-calculator';

@Injectable()
export class M2eDailySnapshotService {
  constructor(
    private readonly balanceConfig: M2eBalanceConfigService,
    private readonly calculator: M2eEarningCalculator,
    private readonly entitlement: CopperRingEntitlementService,
    private readonly rings: CopperRingRepository,
  ) {}

  async getOrCreateInTransaction(
    manager: EntityManager,
    userId: string,
    accountingDate: string,
  ): Promise<M2eDailyEconomicSnapshot> {
    const owner = await this.rings.lockOwner(manager, userId);
    if (!owner) throw m2eRingSelectionUnavailable();

    const repository = manager.getRepository(M2eDailyEconomicSnapshot);
    const existing = await repository.findOne({
      where: { userId, accountingDate },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) return existing;

    await this.entitlement.ensureStarterCopperInTransaction(
      manager,
      userId,
      CopperIssuanceReason.LazyEnsure,
    );
    const ownedRings = await this.rings.listActiveOwnedRings(manager, userId);
    if (ownedRings.length < 1) throw m2eRingSelectionUnavailable();

    const equipment = await this.rings.findEquipment(manager, userId);
    if (!equipment) throw m2eRingSelectionUnavailable();
    const selectedRing = ownedRings.find((ring) => ring.id === equipment.ringId);
    if (!selectedRing) throw m2eRingSelectionUnavailable();

    const config = this.balanceConfig.getConfig();
    const calculation = this.calculator.calculate({
      validatedDailySteps: 0,
      ringCount: ownedRings.length,
      comfort: selectedRing.comfort,
    });
    const snapshot = repository.create({
      userId,
      accountingDate,
      selectedRingId: selectedRing.id,
      ringCount: ownedRings.length,
      selectedRingComfort: selectedRing.comfort,
      stepCap: calculation.stepCap,
      rulesVersion: M2E_EARNING_RULES_VERSION,
      balanceConfigVersion: config.version,
      baseSteps: config.baseSteps,
      extraStepsPerRing: config.extraStepsPerRing,
      baseErtPer1000Steps: config.baseErtPer1000Steps,
      comfortCurveK: config.comfortCurveK,
    });
    return repository.save(snapshot);
  }
}
