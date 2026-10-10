import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CopperInitialAttributes, CopperRingRandomService } from '../ring/copper-ring-random.service';
import {
  COPPER_GENERATION_VERSION,
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRingKind,
  GameRingStatus,
  RAFFLE_COPPER_ENTITLEMENT_PREFIX,
} from '../ring/game-ring.entity';
import { RingEventType } from '../ring/ring-event.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import {
  RaffleCopperAwardAggregate,
  RaffleCopperAwardPersistence,
  RaffleCopperAwardRepository,
} from './raffle-copper-award.repository';
import { RAFFLE_COPPER_FULFILLMENT_VERSION } from './raffle-ring-award.entity';
import { Reward, RewardType } from './reward.entity';

export enum RaffleCopperAwardFailure {
  InvalidState = 'INVALID_STATE',
}

export class RaffleCopperAwardError extends Error {
  constructor(readonly reason: RaffleCopperAwardFailure) {
    super(`Raffle Copper award failed: ${reason}`);
    this.name = 'RaffleCopperAwardError';
  }
}

export type RaffleCopperAwardInput = Readonly<{
  ownerUserId: string;
  operation: RaffleDrawOperation;
  result: RaffleDrawResultV2;
  awardUtcDate: string;
}>;

export type RaffleCopperAwardResponse = Readonly<{
  type: typeof RewardType.CopperRing;
  replay: boolean;
  awardId: string;
  drawResultId: string;
  userRewardId: string;
  ringEventId: string;
  ring: Readonly<{
    id: string;
    entitlementCode: string;
    kind: GameRingKind.Copper;
    level: 1;
    shine: 100;
    comfort: number;
    charm: number;
    quality: number;
    luck: number;
    unspentAttributePoints: 0;
    visualVariantCode: CopperVisualVariant;
    equipped: false;
  }>;
}>;

@Injectable()
export class RaffleCopperAwardService {
  constructor(
    private readonly repository: RaffleCopperAwardRepository,
    private readonly random: CopperRingRandomService,
  ) {}

  async awardInTransaction(
    manager: EntityManager,
    input: RaffleCopperAwardInput,
  ): Promise<RaffleCopperAwardResponse> {
    this.assertIdentity(input);
    const existing = await this.repository.findByDrawResult(manager, input.result.id);
    if (existing) return this.response(existing, true);

    const reward = await this.repository.findReward(manager, input.result.selectedRewardId);
    this.assertReward(reward);

    const attributes = this.random.generateAttributes();
    this.assertAttributes(attributes);
    const visualVariantCode = this.random.selectVisualVariant();
    if (!Object.values(CopperVisualVariant).includes(visualVariantCode)) this.invalidState();

    const now = this.currentTime();
    const entitlementCode = `${RAFFLE_COPPER_ENTITLEMENT_PREFIX}${input.result.id.toLowerCase()}`;
    const ring = await this.repository.saveRing(manager, {
      ownerUserId: input.ownerUserId,
      entitlementCode,
      ringKind: GameRingKind.Copper,
      status: GameRingStatus.Active,
      level: 1,
      shine: 100,
      ...attributes,
      unspentAttributePoints: 0,
      visualVariantCode,
      rulesetVersion: COPPER_RULESET_VERSION,
      generationVersion: COPPER_GENERATION_VERSION,
      visualSetVersion: COPPER_VISUAL_SET_VERSION,
      issuedReason: CopperIssuanceReason.Raffle,
      createdAt: now,
      updatedAt: now,
    });

    const event = await this.repository.saveEvent(manager, {
      ringId: ring.id,
      ownerUserId: input.ownerUserId,
      operationKey: `raffle-award:${input.result.id.toLowerCase()}`,
      eventType: RingEventType.RaffleAwarded,
      rulesetVersion: COPPER_RULESET_VERSION,
      snapshot: {
        drawOperationId: input.operation.id,
        drawResultId: input.result.id,
        configurationId: input.result.configurationId,
        rewardId: reward!.id,
        ownerUserId: input.ownerUserId,
        ringId: ring.id,
        entitlementCode,
        issuedReason: CopperIssuanceReason.Raffle,
        fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
        rulesetVersion: COPPER_RULESET_VERSION,
        generationVersion: COPPER_GENERATION_VERSION,
        visualSetVersion: COPPER_VISUAL_SET_VERSION,
        level: 1,
        shine: 100,
        ...attributes,
        unspentAttributePoints: 0,
        visualVariantCode,
        equipped: false,
        ringCreatedAt: now.toISOString(),
        eventCreatedAt: now.toISOString(),
      },
      createdAt: now,
    });

    const award = await this.repository.saveAward(manager, {
      operationId: input.operation.id,
      drawResultId: input.result.id,
      ownerUserId: input.ownerUserId,
      rewardId: reward!.id,
      ringId: ring.id,
      ringEventId: event.id,
      awardUtcDate: input.awardUtcDate,
      fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
      rulesetVersion: COPPER_RULESET_VERSION,
      createdAt: now,
    });

    const userReward = await this.repository.saveUserReward(manager, {
      userId: input.ownerUserId,
      rewardId: reward!.id,
      raffleDrawId: null,
      raffleDrawResultV2Id: input.result.id,
      title: reward!.title,
      type: RewardType.CopperRing,
      amount: null,
      amountExactValue: null,
      eruBalanceAfterExact: null,
      metadata: {
        awardId: award.id,
        ringId: ring.id,
        ringEventId: event.id,
        fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
      },
      createdAt: now,
    });

    return this.response({ award, ring, event, userReward }, false);
  }

  protected currentTime() {
    return new Date();
  }

  private assertIdentity(input: RaffleCopperAwardInput) {
    if (input.operation.id !== input.result.operationId
      || input.operation.ownerUserId !== input.ownerUserId
      || input.result.ownerUserId !== input.ownerUserId
      || !/^\d{4}-\d{2}-\d{2}$/.test(input.awardUtcDate)
      || new Date(`${input.awardUtcDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.awardUtcDate) {
      this.invalidState();
    }
  }

  private assertReward(reward: Reward | null): asserts reward is Reward {
    if (!reward
      || reward.type !== RewardType.CopperRing
      || reward.amount !== null
      || reward.amountExactValue !== null
      || reward.stockTotal !== null
      || reward.stockRemaining !== null) this.invalidState();
  }

  private assertAttributes(attributes: CopperInitialAttributes) {
    for (const value of Object.values(attributes)) {
      if (!Number.isInteger(value) || value < 2 || value > 20) this.invalidState();
    }
  }

  private response(aggregate: RaffleCopperAwardAggregate, replay: boolean): RaffleCopperAwardResponse {
    const { award, ring, event, userReward } = aggregate;
    const expectedEntitlement = `${RAFFLE_COPPER_ENTITLEMENT_PREFIX}${award.drawResultId.toLowerCase()}`;
    if (award.ringId !== ring.id
      || award.ringEventId !== event.id
      || award.ownerUserId !== ring.ownerUserId
      || event.ringId !== ring.id
      || event.ownerUserId !== ring.ownerUserId
      || userReward.userId !== ring.ownerUserId
      || userReward.rewardId !== award.rewardId
      || userReward.raffleDrawResultV2Id !== award.drawResultId
      || userReward.type !== RewardType.CopperRing
      || userReward.amount !== null
      || userReward.amountExactValue !== null
      || userReward.eruBalanceAfterExact !== null
      || award.fulfillmentVersion !== RAFFLE_COPPER_FULFILLMENT_VERSION
      || award.rulesetVersion !== COPPER_RULESET_VERSION
      || ring.entitlementCode !== expectedEntitlement
      || ring.ringKind !== GameRingKind.Copper
      || ring.status !== GameRingStatus.Active
      || ring.issuedReason !== CopperIssuanceReason.Raffle
      || ring.level !== 1
      || ring.shine !== 100
      || ring.unspentAttributePoints !== 0
      || ring.rulesetVersion !== COPPER_RULESET_VERSION
      || ring.generationVersion !== COPPER_GENERATION_VERSION
      || ring.visualSetVersion !== COPPER_VISUAL_SET_VERSION
      || !Object.values(CopperVisualVariant).includes(ring.visualVariantCode)
      || event.eventType !== RingEventType.RaffleAwarded
      || event.operationKey !== `raffle-award:${award.drawResultId.toLowerCase()}`
      || event.rulesetVersion !== COPPER_RULESET_VERSION) this.invalidState();

    return Object.freeze({
      type: RewardType.CopperRing,
      replay,
      awardId: award.id,
      drawResultId: award.drawResultId,
      userRewardId: userReward.id,
      ringEventId: event.id,
      ring: Object.freeze({
        id: ring.id,
        entitlementCode: ring.entitlementCode,
        kind: GameRingKind.Copper,
        level: 1,
        shine: 100,
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
        unspentAttributePoints: 0,
        visualVariantCode: ring.visualVariantCode,
        equipped: false,
      }),
    });
  }

  private invalidState(): never {
    throw new RaffleCopperAwardError(RaffleCopperAwardFailure.InvalidState);
  }
}
