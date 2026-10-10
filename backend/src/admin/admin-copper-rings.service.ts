import { BadRequestException, Injectable } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { CopperRingRepository } from '../ring/copper-ring.repository';
import { EquippedRing } from '../ring/equipped-ring.entity';
import { GameRing } from '../ring/game-ring.entity';
import { RingEvent } from '../ring/ring-event.entity';
import { copperRingNotFound, withCopperRingReadContract } from '../ring/copper-ring-errors';

export type AdminRingListInput = {
  query?: string;
  limit?: number;
  offset?: number;
};

export type AdminRingEventListInput = {
  limit?: number;
  offset?: number;
};

@Injectable()
export class AdminCopperRingsService {
  constructor(private readonly repository: CopperRingRepository) {}

  async list(input: AdminRingListInput) {
    const page = this.normalizePage(input);
    const query = this.normalizeQuery(input.query);
    return withCopperRingReadContract(() => this.repository.transaction(async (manager) => {
      const [rings, total] = await this.repository.searchRingsForAdmin(manager, { query, ...page });
      const equipment = await this.repository.listEquipmentForRings(manager, rings.map((ring) => ring.id));
      const equipmentByRingId = new Map(equipment.map((item) => [item.ringId, item]));
      return {
        items: rings.map((ring) => this.toRingView(ring, equipmentByRingId.get(ring.id) ?? null)),
        total,
        ...page,
      };
    }));
  }

  async detail(ringId: string) {
    return withCopperRingReadContract(() => this.repository.transaction(async (manager) => {
      const ring = await this.repository.findRingForAdmin(manager, ringId);
      if (!ring) throw copperRingNotFound();
      const [equipment, award] = await Promise.all([
        this.repository.findEquipmentForRing(manager, ring.id),
        this.repository.findRaffleAwardForRing(manager, ring.ownerUserId, ring.id),
      ]);
      return { ring: { ...this.toRingView(ring, equipment), raffleAward: award ? {
        id: award.id,
        drawResultId: award.drawResultId,
        rewardId: award.rewardId,
        ringEventId: award.ringEventId,
        awardUtcDate: award.awardUtcDate,
        fulfillmentVersion: award.fulfillmentVersion,
        rulesetVersion: award.rulesetVersion,
        createdAt: award.createdAt.toISOString(),
      } : null } };
    }));
  }

  async events(ringId: string, input: AdminRingEventListInput) {
    const page = this.normalizePage(input);
    return withCopperRingReadContract(() => this.repository.transaction(async (manager) => {
      const ring = await this.repository.findRingForAdmin(manager, ringId);
      if (!ring) throw copperRingNotFound();
      const [events, total] = await this.repository.listEventsForAdmin(manager, ring.id, page.limit, page.offset);
      return {
        items: events.map((event) => this.toEventView(event)),
        total,
        ...page,
      };
    }));
  }

  private normalizePage(input: AdminRingEventListInput) {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('offset must be a non-negative integer');
    }
    return { limit, offset };
  }

  private normalizeQuery(query: string | undefined) {
    const normalized = query?.trim() ?? '';
    if (normalized.length > 128) throw new BadRequestException('query must not exceed 128 characters');
    return normalized || null;
  }

  private toRingView(ring: GameRing, equipment: EquippedRing | null) {
    return {
      id: ring.id,
      owner: this.toOwnerView(ring.owner),
      entitlementCode: ring.entitlementCode,
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
      rulesetVersion: ring.rulesetVersion,
      generationVersion: ring.generationVersion,
      visualSetVersion: ring.visualSetVersion,
      issuedReason: ring.issuedReason,
      equipment: equipment ? {
        userId: equipment.userId,
        equippedAt: equipment.equippedAt.toISOString(),
        updatedAt: equipment.updatedAt.toISOString(),
      } : null,
      createdAt: ring.createdAt.toISOString(),
      updatedAt: ring.updatedAt.toISOString(),
    };
  }

  private toOwnerView(owner: User) {
    return {
      id: owner.id,
      telegramId: owner.telegramId,
      username: owner.username,
      firstName: owner.firstName,
      lastName: owner.lastName,
    };
  }

  private toEventView(event: RingEvent) {
    return {
      id: event.id,
      ringId: event.ringId,
      ownerUserId: event.ownerUserId,
      operationKey: event.operationKey,
      eventType: event.eventType,
      rulesetVersion: event.rulesetVersion,
      snapshot: event.snapshot,
      createdAt: event.createdAt.toISOString(),
    };
  }
}
