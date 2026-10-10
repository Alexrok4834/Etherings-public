import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager, TypeORMError } from 'typeorm';
import { User } from '../auth/user.entity';
import { CopperLevelUpErrorCode } from './copper-level-up-errors';
import { CopperLevelUpBlocker, CopperLevelUpPreviewService } from './copper-level-up-preview.service';
import { CopperRingRepository } from './copper-ring.repository';
import {
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from './game-ring.entity';
import { CopperRingErrorCode } from './copper-ring-errors';

class FakePreviewRepository {
  transactionCalls = 0;
  readonly reads: string[] = [];
  transactionError: Error | null = null;

  constructor(
    public ring: GameRing | null = ringFixture(),
    public balance: ReturnType<typeof balanceFixture> | null = balanceFixture('100'),
  ) {}

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    this.transactionCalls += 1;
    if (this.transactionError) throw this.transactionError;
    return operation({} as EntityManager);
  }

  async findOwnedRing(_manager: EntityManager, _userId: string, _ringId: string) {
    this.reads.push('ring');
    return this.ring;
  }

  async findErtBalance(_manager: EntityManager, _userId: string) {
    this.reads.push('balance');
    return this.balance;
  }
}

function fixture(level = 1, ertBalance: string | number = '100', eruBalance = '100') {
  const repository = new FakePreviewRepository(
    ringFixture(level),
    balanceFixture(ertBalance, eruBalance),
  );
  return {
    repository,
    user: Object.assign(new User(), { id: randomUUID() }),
    service: new CopperLevelUpPreviewService(repository as unknown as CopperRingRepository),
  };
}

function ringFixture(level = 1) {
  return Object.assign(new GameRing(), {
    id: randomUUID(),
    ownerUserId: randomUUID(),
    entitlementCode: 'starter-copper-v1',
    ringKind: GameRingKind.Copper,
    status: GameRingStatus.Active,
    level,
    shine: 100,
    unspentAttributePoints: 0,
    comfort: 2,
    charm: 20,
    quality: 7,
    luck: 11,
    visualVariantCode: CopperVisualVariant.Celtic,
    rulesetVersion: 'copper-rules-v1',
    generationVersion: 'copper-generation-v1',
    visualSetVersion: 'copper-visual-v1',
    issuedReason: CopperIssuanceReason.Registration,
    createdAt: new Date('2026-08-19T12:00:00.000Z'),
    updatedAt: new Date('2026-08-19T12:00:00.000Z'),
  });
}

function balanceFixture(ertBalance: string | number, eruBalance = '100') {
  return {
    userId: randomUUID(),
    ertBalance: String(ertBalance),
    lifetimeEarnedErt: String(ertBalance),
    lifetimeSpentErt: '0',
    eruBalance,
    lifetimeEarnedEru: eruBalance,
    lifetimeSpentEru: '0',
  };
}

function request(expectedCurrentLevel: number, targetLevel: number) {
  return {
    expectedCurrentLevel,
    targetLevel,
  };
}

describe('CopperLevelUpPreviewService read-only authority', () => {
  it('returns authoritative cost, unchanged attributes, four deferred points, and no milestone', async () => {
    const { repository, service, user } = fixture(1, 100);

    const result = await service.preview(user, repository.ring!.id, request(1, 2));

    assert.deepEqual(result, {
      rulesVersion: 'copper-level-up-v2',
      ringId: repository.ring!.id,
      current: {
        level: 1,
        attributes: { comfort: 2, charm: 20, quality: 7, luck: 11 },
        unspentAttributePoints: 0,
      },
      target: {
        level: 2,
        attributes: { comfort: 2, charm: 20, quality: 7, luck: 11 },
        unspentAttributePoints: 4,
      },
      grantedAttributePoints: 4,
      cost: {
        ert: 12, ertExact: '12', ertDisplay: '12.00',
        eru: 0, eruExact: '0', eruDisplay: '0.00',
      },
      balances: {
        ert: 100, ertExact: '100', ertDisplay: '100.00',
        eru: 100, eruExact: '100', eruDisplay: '100.00',
      },
      affordability: { ert: true, eru: true },
      dependencies: {
        ertLedger: { required: true, available: true },
        eruLedger: { required: false, available: null },
      },
      available: true,
      blockers: [],
      milestone: null,
    });
    assert.equal(repository.transactionCalls, 1);
    assert.deepEqual(repository.reads, ['ring', 'balance']);
  });

  it('reports insufficient ERT without changing or fabricating any balance', async () => {
    const { repository, service, user } = fixture(1, 11);

    const result = await service.preview(user, repository.ring!.id, request(1, 2));

    assert.equal(result.available, false);
    assert.deepEqual(result.blockers, [CopperLevelUpBlocker.InsufficientErt]);
    assert.deepEqual(result.balances, {
      ert: 11, ertExact: '11', ertDisplay: '11.00',
      eru: 100, eruExact: '100', eruDisplay: '100.00',
    });
    assert.equal(repository.balance!.ertBalance, '11');
    assert.equal(repository.ring!.level, 1);
  });

  it('returns exact level-5 ERU cost and an insufficient-ERU blocker', async () => {
    const { repository, service, user } = fixture(4, 100, '29');

    const result = await service.preview(user, repository.ring!.id, request(4, 5));

    assert.deepEqual(result.cost, {
      ert: 24, ertExact: '24', ertDisplay: '24.00',
      eru: 30, eruExact: '30', eruDisplay: '30.00',
    });
    assert.deepEqual(result.dependencies.eruLedger, { required: true, available: true });
    assert.equal(result.affordability.eru, false);
    assert.equal(result.available, false);
    assert.deepEqual(result.blockers, [CopperLevelUpBlocker.InsufficientEru]);
    assert.deepEqual(result.milestone, {
      level: 5,
      utilities: [
        { code: 'BREEDING', available: false },
        { code: 'GEM_SLOT', available: false },
      ],
    });
  });

  it('uses all 18 decimal places for affordability while retaining the numeric compatibility field', async () => {
    const enough = fixture(1, '12.000000000000000001');
    const enoughResult = await enough.service.preview(
      enough.user, enough.repository.ring!.id, request(1, 2),
    );
    assert.equal(enoughResult.affordability.ert, true);
    assert.deepEqual(enoughResult.balances, {
      ert: 12,
      ertExact: '12.000000000000000001',
      ertDisplay: '12.00',
      eru: 100,
      eruExact: '100',
      eruDisplay: '100.00',
    });

    const insufficient = fixture(1, '11.999999999999999999');
    const insufficientResult = await insufficient.service.preview(
      insufficient.user, insufficient.repository.ring!.id, request(1, 2),
    );
    assert.equal(insufficientResult.affordability.ert, false);
    assert.deepEqual(insufficientResult.blockers, [CopperLevelUpBlocker.InsufficientErt]);
  });

  it('reports deferred milestone utilities at levels 10 and 20', async () => {
    const level10 = fixture(9, 100);
    const preview10 = await level10.service.preview(
      level10.user,
      level10.repository.ring!.id,
      request(9, 10),
    );
    assert.deepEqual(preview10.milestone, {
      level: 10,
      utilities: [{ code: 'RING_SHOW_STAKING', available: false }],
    });

    const level20 = fixture(19, 100);
    const preview20 = await level20.service.preview(
      level20.user,
      level20.repository.ring!.id,
      request(19, 20),
    );
    assert.deepEqual(preview20.milestone, {
      level: 20,
      utilities: [{ code: 'TRANSFORMATION', available: false }],
    });
    assert.deepEqual(preview20.blockers, []);
    assert.equal(preview20.available, true);
  });

  it('retains exact ERU beyond the JavaScript safe-integer range', async () => {
    const unsafe = fixture(4, 100, '9007199254740993');
    const result = await unsafe.service.preview(
      unsafe.user, unsafe.repository.ring!.id, request(4, 5),
    );
    assert.equal(result.balances.eru, null);
    assert.equal(result.balances.eruExact, '9007199254740993');
    assert.equal(result.affordability.eru, true);
  });

  it('masks a missing or other-owner ring and fails closed for a missing balance', async () => {
    const missingRing = fixture();
    missingRing.repository.ring = null;
    await assertPreviewError(
      missingRing.service.preview(missingRing.user, randomUUID(), request(1, 2)),
      404,
      CopperRingErrorCode.NotFound,
    );
    assert.deepEqual(missingRing.repository.reads, ['ring']);

    const missingBalance = fixture();
    missingBalance.repository.balance = null;
    await assertPreviewError(
      missingBalance.service.preview(
        missingBalance.user,
        missingBalance.repository.ring!.id,
        request(1, 2),
      ),
      409,
      CopperRingErrorCode.StateConflict,
    );
  });

  it('maps a database read failure to the stable unavailable response', async () => {
    const unavailable = fixture();
    unavailable.repository.transactionError = new TypeORMError('private database detail');

    await assertPreviewError(
      unavailable.service.preview(
        unavailable.user,
        unavailable.repository.ring!.id,
        request(1, 2),
      ),
      503,
      CopperRingErrorCode.ReadUnavailable,
    );
  });

  it('rejects stale, skipped, downgrade, and above-maximum transitions', async () => {
    const stale = fixture(2);
    await assertPreviewError(
      stale.service.preview(stale.user, stale.repository.ring!.id, request(1, 2)),
      409,
      CopperLevelUpErrorCode.StaleLevel,
    );

    for (const [current, target] of [[1, 3], [2, 1], [20, 21]]) {
      const invalid = fixture(current);
      await assertPreviewError(
        invalid.service.preview(
          invalid.user,
          invalid.repository.ring!.id,
          request(current, target),
        ),
        409,
        CopperLevelUpErrorCode.TransitionInvalid,
      );
    }
  });

  it('rejects malformed and obsolete v1 bodies before opening a transaction', async () => {
    const invalidBodies = [
      null,
      {},
      { ...request(1, 2), extra: true },
      { ...request(1, 2), targetLevel: 2.5 },
    ];
    for (const body of invalidBodies) {
      const invalid = fixture();
      await assertPreviewError(
        invalid.service.preview(invalid.user, invalid.repository.ring!.id, body),
        400,
        CopperLevelUpErrorCode.PreviewRequestInvalid,
      );
      assert.equal(invalid.repository.transactionCalls, 0);
    }

    const obsoleteV1 = fixture();
    await assertPreviewError(
      obsoleteV1.service.preview(obsoleteV1.user, obsoleteV1.repository.ring!.id, {
        ...request(1, 2),
        allocation: { comfort: 4, charm: 0, quality: 0, luck: 0 },
      }),
      400,
      CopperLevelUpErrorCode.PreviewRequestInvalid,
    );
    assert.equal(obsoleteV1.repository.transactionCalls, 0);
  });
});

async function assertPreviewError(
  promise: Promise<unknown>,
  status: number,
  code: CopperLevelUpErrorCode | CopperRingErrorCode,
) {
  await assert.rejects(promise, (error) => {
    const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
    assert.equal(exception.getStatus?.(), status);
    assert.equal((exception.getResponse?.() as { code?: string }).code, code);
    return true;
  });
}
