import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager } from 'typeorm';
import { CopperInitialAttributes, CopperRingRandomService } from '../ring/copper-ring-random.service';
import {
  COPPER_GENERATION_VERSION,
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from '../ring/game-ring.entity';
import { RingEvent, RingEventType } from '../ring/ring-event.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import {
  RaffleCopperAwardAggregate,
  RaffleCopperAwardPersistence,
  RaffleCopperAwardRepository,
} from './raffle-copper-award.repository';
import {
  RaffleCopperAwardFailure,
  RaffleCopperAwardService,
} from './raffle-copper-award.service';
import { RaffleRingAward, RAFFLE_COPPER_FULFILLMENT_VERSION } from './raffle-ring-award.entity';
import { Reward, RewardType } from './reward.entity';
import { UserReward } from './user-reward.entity';

const now = new Date('2026-08-31T09:10:11.000Z');

class FakeRandom extends CopperRingRandomService {
  attributeCalls = 0;
  visualCalls = 0;

  constructor(
    readonly attributes: CopperInitialAttributes = { comfort: 2, charm: 20, quality: 7, luck: 11 },
    readonly visual = CopperVisualVariant.Signet,
  ) {
    super();
  }

  override generateAttributes() {
    this.attributeCalls += 1;
    return this.attributes;
  }

  override selectVisualVariant() {
    this.visualCalls += 1;
    return this.visual;
  }
}

class FakeRepository implements RaffleCopperAwardPersistence {
  aggregate: RaffleCopperAwardAggregate | null = null;
  reward: Reward | null;
  writes: string[] = [];
  failAt: string | null = null;

  constructor(readonly ownerUserId: string, readonly rewardId: string) {
    this.reward = Object.assign(new Reward(), {
      id: rewardId,
      title: 'Cooper Ring',
      type: RewardType.CopperRing,
      amount: null,
      amountExactValue: null,
      stockTotal: null,
      stockRemaining: null,
    });
  }

  async findByDrawResult(_manager: EntityManager, _drawResultId: string) {
    return this.aggregate;
  }

  async findReward(_manager: EntityManager, _rewardId: string) {
    return this.reward;
  }

  async saveRing(_manager: EntityManager, input: Partial<GameRing>) {
    this.write('ring');
    return Object.assign(new GameRing(), input, { id: randomUUID() });
  }

  async saveEvent(_manager: EntityManager, input: Partial<RingEvent>) {
    this.write('event');
    return Object.assign(new RingEvent(), input, { id: randomUUID() });
  }

  async saveAward(_manager: EntityManager, input: Partial<RaffleRingAward>) {
    this.write('award');
    return Object.assign(new RaffleRingAward(), input, { id: randomUUID() });
  }

  async saveUserReward(_manager: EntityManager, input: Partial<UserReward>) {
    this.write('userReward');
    return Object.assign(new UserReward(), input, { id: randomUUID() });
  }

  private write(name: string) {
    if (this.failAt === name) throw new Error(`injected ${name} failure`);
    this.writes.push(name);
  }
}

class FixedTimeAwardService extends RaffleCopperAwardService {
  protected override currentTime() {
    return now;
  }
}

function fixture(random = new FakeRandom()) {
  const ownerUserId = randomUUID();
  const rewardId = randomUUID();
  const operation = Object.assign(new RaffleDrawOperation(), {
    id: randomUUID(),
    ownerUserId,
  });
  const result = Object.assign(new RaffleDrawResultV2(), {
    id: randomUUID(),
    operationId: operation.id,
    ownerUserId,
    configurationId: randomUUID(),
    selectedRewardId: rewardId,
  });
  const repository = new FakeRepository(ownerUserId, rewardId);
  const service = new FixedTimeAwardService(
    repository as unknown as RaffleCopperAwardRepository,
    random,
  );
  return { manager: {} as EntityManager, ownerUserId, rewardId, operation, result, repository, random, service };
}

describe('RaffleCopperAwardService transaction-bound aggregate', () => {
  it('persists one inventory-only Cooper aggregate in frozen order', async () => {
    const { manager, ownerUserId, operation, result, repository, random, service } = fixture();
    const response = await service.awardInTransaction(manager, { ownerUserId, operation, result, awardUtcDate: '2026-08-31' });

    assert.deepEqual(repository.writes, ['ring', 'event', 'award', 'userReward']);
    assert.equal(random.attributeCalls, 1);
    assert.equal(random.visualCalls, 1);
    assert.equal(response.type, RewardType.CopperRing);
    assert.equal(response.replay, false);
    assert.equal(response.ring.entitlementCode, `raffle-copper-v1:${result.id}`);
    assert.deepEqual(
      {
        kind: response.ring.kind,
        level: response.ring.level,
        shine: response.ring.shine,
        comfort: response.ring.comfort,
        charm: response.ring.charm,
        quality: response.ring.quality,
        luck: response.ring.luck,
        points: response.ring.unspentAttributePoints,
        visual: response.ring.visualVariantCode,
        equipped: response.ring.equipped,
      },
      {
        kind: GameRingKind.Copper,
        level: 1,
        shine: 100,
        comfort: 2,
        charm: 20,
        quality: 7,
        luck: 11,
        points: 0,
        visual: CopperVisualVariant.Signet,
        equipped: false,
      },
    );
  });

  it('returns a stored replay without reward lookup, RNG, or writes', async () => {
    const { manager, ownerUserId, operation, result, repository, random, service } = fixture();
    const first = await service.awardInTransaction(manager, { ownerUserId, operation, result, awardUtcDate: '2026-08-31' });
    repository.aggregate = aggregateFrom(first, ownerUserId, repository.reward!);
    repository.writes = [];
    repository.reward = null;

    const replay = await service.awardInTransaction(manager, { ownerUserId, operation, result, awardUtcDate: '2026-08-31' });
    assert.equal(replay.replay, true);
    assert.equal(replay.ring.id, first.ring.id);
    assert.deepEqual(repository.writes, []);
    assert.equal(random.attributeCalls, 1);
    assert.equal(random.visualCalls, 1);
  });

  it('rejects a malformed or finite-stock Copper reward before RNG', async () => {
    const { manager, ownerUserId, operation, result, repository, random, service } = fixture();
    repository.reward!.stockRemaining = 1;

    await assert.rejects(
      () => service.awardInTransaction(manager, { ownerUserId, operation, result, awardUtcDate: '2026-08-31' }),
      (error) => (error as { reason?: string }).reason === RaffleCopperAwardFailure.InvalidState,
    );
    assert.equal(random.attributeCalls, 0);
    assert.deepEqual(repository.writes, []);
  });

  it('rejects cross-owner/result identity before reads or RNG', async () => {
    const { manager, operation, result, repository, random, service } = fixture();
    await assert.rejects(
      () => service.awardInTransaction(manager, { ownerUserId: randomUUID(), operation, result, awardUtcDate: '2026-08-31' }),
      (error) => (error as { reason?: string }).reason === RaffleCopperAwardFailure.InvalidState,
    );
    assert.equal(random.attributeCalls, 0);
    assert.deepEqual(repository.writes, []);
  });

  it('stops at every persistence failure so the outer transaction can roll back', async () => {
    for (const [failure, expectedWrites] of [
      ['ring', []],
      ['event', ['ring']],
      ['award', ['ring', 'event']],
      ['userReward', ['ring', 'event', 'award']],
    ] as const) {
      const { manager, ownerUserId, operation, result, repository, service } = fixture();
      repository.failAt = failure;
      await assert.rejects(
        () => service.awardInTransaction(manager, { ownerUserId, operation, result, awardUtcDate: '2026-08-31' }),
        new RegExp(`injected ${failure} failure`),
      );
      assert.deepEqual(repository.writes, expectedWrites);
    }
  });
});

function aggregateFrom(
  response: Awaited<ReturnType<RaffleCopperAwardService['awardInTransaction']>>,
  ownerUserId: string,
  reward: Reward,
): RaffleCopperAwardAggregate {
  const ring = Object.assign(new GameRing(), {
    id: response.ring.id,
    ownerUserId,
    entitlementCode: response.ring.entitlementCode,
    ringKind: GameRingKind.Copper,
    status: GameRingStatus.Active,
    issuedReason: CopperIssuanceReason.Raffle,
    level: 1,
    shine: 100,
    comfort: response.ring.comfort,
    charm: response.ring.charm,
    quality: response.ring.quality,
    luck: response.ring.luck,
    unspentAttributePoints: 0,
    visualVariantCode: response.ring.visualVariantCode,
    rulesetVersion: COPPER_RULESET_VERSION,
    generationVersion: COPPER_GENERATION_VERSION,
    visualSetVersion: COPPER_VISUAL_SET_VERSION,
  });
  const event = Object.assign(new RingEvent(), {
    id: response.ringEventId,
    ringId: ring.id,
    ownerUserId,
    operationKey: `raffle-award:${response.drawResultId}`,
    eventType: RingEventType.RaffleAwarded,
    rulesetVersion: COPPER_RULESET_VERSION,
  });
  const award = Object.assign(new RaffleRingAward(), {
    id: response.awardId,
    drawResultId: response.drawResultId,
    ownerUserId,
    rewardId: reward.id,
    ringId: ring.id,
    ringEventId: event.id,
    fulfillmentVersion: RAFFLE_COPPER_FULFILLMENT_VERSION,
    rulesetVersion: COPPER_RULESET_VERSION,
  });
  const userReward = Object.assign(new UserReward(), {
    id: response.userRewardId,
    userId: ownerUserId,
    rewardId: reward.id,
    raffleDrawResultV2Id: response.drawResultId,
    type: RewardType.CopperRing,
    amount: null,
    amountExactValue: null,
    eruBalanceAfterExact: null,
  });
  return { award, ring, event, userReward };
}
