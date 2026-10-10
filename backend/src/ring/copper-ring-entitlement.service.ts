import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import { CopperInitialAttributes, CopperRingRandomService } from './copper-ring-random.service';
import { CopperRingRepository } from './copper-ring.repository';
import {
  COPPER_ENTITLEMENT_CODE,
  COPPER_GENERATION_VERSION,
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from './game-ring.entity';
import { RingEventType } from './ring-event.entity';
import { copperRingStateConflict } from './copper-ring-errors';

export type CopperEntitlementResult = {
  ring: GameRing;
  created: boolean;
};

@Injectable()
export class CopperRingEntitlementService {
  constructor(
    private readonly repository: CopperRingRepository,
    private readonly random: CopperRingRandomService,
  ) {}

  async ensureStarterCopper(userId: string, reason: CopperIssuanceReason): Promise<CopperEntitlementResult> {
    try {
      return await this.repository.transaction((manager) =>
        this.ensureStarterCopperInTransaction(manager, userId, reason));
    } catch (error) {
      if (!this.isEntitlementRace(error)) throw error;
      return this.repository.transaction((manager) => this.loadCommittedStarter(manager, userId));
    }
  }

  async ensureStarterCopperInTransaction(
    manager: EntityManager,
    userId: string,
    reason: CopperIssuanceReason,
  ): Promise<CopperEntitlementResult> {
    const user = await this.repository.lockOwner(manager, userId);
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.repository.findStarterForUpdate(manager, userId, COPPER_ENTITLEMENT_CODE);
    if (existing) return this.validateExisting(manager, existing);

    const attributes = this.random.generateAttributes();
    this.assertGeneratedAttributes(attributes);
    const visualVariantCode = this.random.selectVisualVariant();
    if (!Object.values(CopperVisualVariant).includes(visualVariantCode)) {
      throw new Error('Copper RNG returned an unknown visual variant');
    }

    const ring = await this.repository.saveStarterRing(manager, {
      ownerUserId: userId,
      entitlementCode: COPPER_ENTITLEMENT_CODE,
      ringKind: GameRingKind.Copper,
      status: GameRingStatus.Active,
      level: 1,
      shine: 100,
      unspentAttributePoints: 0,
      ...attributes,
      visualVariantCode,
      rulesetVersion: COPPER_RULESET_VERSION,
      generationVersion: COPPER_GENERATION_VERSION,
      visualSetVersion: COPPER_VISUAL_SET_VERSION,
      issuedReason: reason,
    });

    const equipment = await this.repository.saveAutomaticEquipment(manager, userId, ring.id);

    await this.repository.saveStarterEvent(manager, {
      ringId: ring.id,
      ownerUserId: userId,
      operationKey: `${COPPER_ENTITLEMENT_CODE}:${userId}`,
      eventType: RingEventType.StarterIssued,
      rulesetVersion: COPPER_RULESET_VERSION,
      snapshot: {
        ringId: ring.id,
        ownerUserId: userId,
        entitlementCode: ring.entitlementCode,
        issuedReason: ring.issuedReason,
        rulesetVersion: ring.rulesetVersion,
        generationVersion: ring.generationVersion,
        visualSetVersion: ring.visualSetVersion,
        level: ring.level,
        shine: ring.shine,
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
        unspentAttributePoints: ring.unspentAttributePoints,
        visualVariantCode: ring.visualVariantCode,
        equipped: equipment.ringId === ring.id,
        createdAt: ring.createdAt.toISOString(),
      },
    });

    return { ring, created: true };
  }

  private async loadCommittedStarter(manager: EntityManager, userId: string) {
    const ring = await this.repository.findStarterForUpdate(manager, userId, COPPER_ENTITLEMENT_CODE);
    if (!ring) throw copperRingStateConflict();
    return this.validateExisting(manager, ring);
  }

  private async validateExisting(manager: EntityManager, ring: GameRing): Promise<CopperEntitlementResult> {
    const [equipment, event] = await Promise.all([
      this.repository.findEquipment(manager, ring.ownerUserId),
      this.repository.findStarterEvent(manager, ring.id),
    ]);
    if (!equipment || !event) {
      throw copperRingStateConflict();
    }
    const equippedRing = await this.repository.findOwnedRing(
      manager,
      ring.ownerUserId,
      equipment.ringId,
    );
    if (!equippedRing || equippedRing.status !== GameRingStatus.Active) throw copperRingStateConflict();
    return { ring, created: false };
  }

  private assertGeneratedAttributes(attributes: CopperInitialAttributes) {
    for (const [name, value] of Object.entries(attributes)) {
      if (!Number.isInteger(value) || value < 2 || value > 20) {
        throw new Error(`Copper RNG returned an invalid ${name} value`);
      }
    }
  }

  private isEntitlementRace(error: unknown) {
    if (!(error instanceof QueryFailedError)) return false;
    const constraint = (error as QueryFailedError & { driverError?: { constraint?: string } }).driverError?.constraint;
    return constraint === 'UQ_game_rings_owner_entitlement'
      || constraint === 'UQ_equipped_rings_ring'
      || constraint === 'UQ_ring_events_operation_key'
      || constraint === 'UQ_ring_events_starter_issued';
  }
}
