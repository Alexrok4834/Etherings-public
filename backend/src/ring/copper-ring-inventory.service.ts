import { Injectable } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { CopperRingEntitlementService } from './copper-ring-entitlement.service';
import { CopperRingRepository } from './copper-ring.repository';
import { CopperIssuanceReason, GameRing } from './game-ring.entity';
import { RaffleRingAward } from '../raffle/raffle-ring-award.entity';
import {
  copperRingNotFound,
  copperRingStateConflict,
  withCopperRingReadContract,
} from './copper-ring-errors';

export type PlayerRingView = {
  id: string;
  ringKind: GameRing['ringKind'];
  status: GameRing['status'];
  level: number;
  shine: number;
  unspentAttributePoints: number;
  attributes: {
    comfort: number;
    charm: number;
    quality: number;
    luck: number;
  };
  visualVariantCode: GameRing['visualVariantCode'];
  visualSetVersion: string;
  rulesetVersion: string;
  equipped: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EquippedPlayerRingView = {
  ring: PlayerRingView;
  equippedAt: string;
};

export type PlayerRingDetailView = PlayerRingView & {
  provenance: {
    entitlementCode: string;
    issuedReason: GameRing['issuedReason'];
    raffleAward: null | {
      awardId: string;
      drawResultId: string;
      rewardId: string;
      ringEventId: string;
      awardUtcDate: string;
      fulfillmentVersion: string;
      rulesetVersion: string;
      createdAt: string;
    };
  };
};

@Injectable()
export class CopperRingInventoryService {
  constructor(
    private readonly repository: CopperRingRepository,
    private readonly entitlement: CopperRingEntitlementService,
  ) {}

  async listForOwner(user: User): Promise<{ rings: PlayerRingView[] }> {
    return withCopperRingReadContract(async () => {
      await this.entitlement.ensureStarterCopper(user.id, CopperIssuanceReason.LazyEnsure);
      return this.repository.transaction(async (manager) => {
        const [rings, equipment] = await Promise.all([
          this.repository.listOwnedRings(manager, user.id),
          this.repository.findEquipment(manager, user.id),
        ]);
        if (!equipment || !rings.some((ring) => ring.id === equipment.ringId)) {
          throw copperRingStateConflict();
        }
        return { rings: rings.map((ring) => this.toPlayerView(ring, equipment.ringId === ring.id)) };
      });
    });
  }

  async getForOwner(user: User, ringId: string): Promise<PlayerRingDetailView> {
    return withCopperRingReadContract(async () => {
      await this.entitlement.ensureStarterCopper(user.id, CopperIssuanceReason.LazyEnsure);
      return this.repository.transaction(async (manager) => {
        const ring = await this.repository.findOwnedRing(manager, user.id, ringId);
        if (!ring) throw copperRingNotFound();
        const [equipment, award] = await Promise.all([
          this.repository.findEquipment(manager, user.id),
          this.repository.findRaffleAwardForRing(manager, user.id, ring.id),
        ]);
        if (!equipment) throw copperRingStateConflict();
        return {
          ...this.toPlayerView(ring, equipment.ringId === ring.id),
          provenance: this.toProvenance(ring, award),
        };
      });
    });
  }

  async getEquippedForOwner(user: User): Promise<EquippedPlayerRingView> {
    return withCopperRingReadContract(async () => {
      await this.entitlement.ensureStarterCopper(user.id, CopperIssuanceReason.LazyEnsure);
      return this.repository.transaction(async (manager) => {
        const equipment = await this.repository.findEquipment(manager, user.id);
        if (!equipment) throw copperRingStateConflict();
        const ring = await this.repository.findOwnedRing(manager, user.id, equipment.ringId);
        if (!ring) throw copperRingStateConflict();
        return {
          ring: this.toPlayerView(ring, true),
          equippedAt: equipment.equippedAt.toISOString(),
        };
      });
    });
  }

  private toPlayerView(ring: GameRing, equipped: boolean): PlayerRingView {
    return {
      id: ring.id,
      ringKind: ring.ringKind,
      status: ring.status,
      level: ring.level,
      shine: ring.shine,
      unspentAttributePoints: ring.unspentAttributePoints,
      attributes: {
        comfort: ring.comfort,
        charm: ring.charm,
        quality: ring.quality,
        luck: ring.luck,
      },
      visualVariantCode: ring.visualVariantCode,
      visualSetVersion: ring.visualSetVersion,
      rulesetVersion: ring.rulesetVersion,
      equipped,
      createdAt: ring.createdAt.toISOString(),
      updatedAt: ring.updatedAt.toISOString(),
    };
  }

  private toProvenance(ring: GameRing, award: RaffleRingAward | null): PlayerRingDetailView['provenance'] {
    return {
      entitlementCode: ring.entitlementCode,
      issuedReason: ring.issuedReason,
      raffleAward: award ? {
        awardId: award.id,
        drawResultId: award.drawResultId,
        rewardId: award.rewardId,
        ringEventId: award.ringEventId,
        awardUtcDate: award.awardUtcDate,
        fulfillmentVersion: award.fulfillmentVersion,
        rulesetVersion: award.rulesetVersion,
        createdAt: award.createdAt.toISOString(),
      } : null,
    };
  }
}
