import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { EntityManager } from 'typeorm';
import { User } from '../auth/user.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import {
  raffleV2RequestFingerprint,
  RaffleV2DrawCoreError,
  RaffleV2DrawCoreFailure,
  RaffleV2DrawCoreService,
} from './raffle-v2-draw-core.service';
import {
  RaffleV2DrawTransactionRepository,
  RaffleV2OperationClaim,
  RaffleV2ResultEvidence,
} from './raffle-v2-draw.repository';
import { RaffleDrawOperation, RaffleDrawOperationStatus } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import {
  RaffleV2FulfillmentPort,
  RaffleV2FulfillmentResponse,
  RaffleV2PreparedFulfillment,
} from './raffle-v2-fulfillment.port';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleV2IntegerSelectionService } from './raffle-v2-integer-selection.service';
import { RaffleV2RandomIntegerPort } from './raffle-v2-random-integer.port';

const ownerId = '11111111-1111-4111-8111-111111111111';
const machineId = '22222222-2222-4222-8222-222222222222';
const configurationId = '33333333-3333-4333-8333-333333333333';
const rewardId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555';
const resultId = '66666666-6666-4666-8666-666666666666';

class FakeRandom implements RaffleV2RandomIntegerPort {
  calls = 0;

  nextInt(maxExclusive: number) {
    this.calls += 1;
    assert.equal(maxExclusive, 30);
    return 12;
  }
}

class FakeRepository implements RaffleV2DrawTransactionRepository {
  readonly manager = {} as EntityManager;
  readonly calls: string[] = [];
  operations = new Map<string, RaffleDrawOperation>();
  results: RaffleDrawResultV2[] = [];
  failAt: string | null = null;

  readonly machine = Object.assign(new RaffleMachine(), {
    singletonKey: 1, id: machineId, code: 'daily-draw', isAvailable: true, pausedAt: null,
  });
  readonly configuration = Object.assign(new RaffleConfiguration(), {
    id: configurationId,
    machineId,
    contractVersion: 'raffle-v2',
    status: RaffleConfigurationStatus.Active,
    title: 'Daily Draw',
    description: null,
    costErtExact: '5.000000000000000000',
    dailyUserAttemptLimit: 5,
  });
  readonly rewards = [Object.assign(new RaffleConfigurationReward(), {
    configurationId,
    rewardId,
    segmentIndex: 0,
    weight: 30,
    rewardSnapshot: {
      rewardId,
      code: 'ert-5',
      title: '5 ERT',
      type: 'ERT',
      segmentIndex: 0,
      weight: '30',
      probability: { numerator: '30', denominator: '100' },
      imageUrl: null,
      amountExact: '5',
      amountDisplay: '5.00',
    },
  })];

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    this.calls.push('transaction');
    const operations = new Map(this.operations);
    const results = [...this.results];
    try {
      return await operation(this.manager);
    } catch (error) {
      this.operations = operations;
      this.results = results;
      throw error;
    }
  }

  async lockOwner() {
    this.stage('owner');
    return { id: ownerId } as User;
  }

  async findOperationForUpdate(_manager: EntityManager, userId: string, idempotencyKey: string) {
    this.stage('existing');
    return this.operations.get(`${userId}:${idempotencyKey}`) ?? null;
  }

  async lockSingletonMachine() {
    this.stage('machine');
    return this.machine;
  }

  async lockActiveConfiguration() {
    this.stage('configuration');
    return this.configuration;
  }

  async claimOperation(_manager: EntityManager, input: RaffleV2OperationClaim) {
    this.stage('claim');
    const operation = Object.assign(new RaffleDrawOperation(), {
      id: operationId,
      ...input,
      status: RaffleDrawOperationStatus.Pending,
      responseSnapshot: null,
      createdAt: new Date('2026-08-31T12:00:00.000Z'),
      updatedAt: new Date('2026-08-31T12:00:00.000Z'),
      completedAt: null,
    });
    this.operations.set(`${input.ownerUserId}:${input.idempotencyKey}`, operation);
    return operation;
  }

  async lockConfigurationRewards() {
    this.stage('rewards');
    return this.rewards;
  }

  async saveResult(_manager: EntityManager, input: RaffleV2ResultEvidence) {
    this.stage('result');
    const result = Object.assign(new RaffleDrawResultV2(), {
      id: resultId,
      ...input,
      createdAt: new Date('2026-08-31T12:00:01.000Z'),
    });
    this.results.push(result);
    return result;
  }

  async completeOperation(
    _manager: EntityManager,
    operation: RaffleDrawOperation,
    responseSnapshot: Record<string, unknown>,
  ) {
    this.stage('complete');
    operation.status = RaffleDrawOperationStatus.Completed;
    operation.responseSnapshot = responseSnapshot;
    operation.completedAt = new Date('2026-08-31T12:00:01.000Z');
    return operation;
  }

  private stage(name: string) {
    this.calls.push(name);
    if (this.failAt === name) throw new Error(`injected:${name}`);
  }
}

class FakeFulfillment implements RaffleV2FulfillmentPort {
  constructor(private readonly repository: FakeRepository) {}

  async lockAndValidate(): Promise<RaffleV2PreparedFulfillment> {
    this.stage('prepare');
    return { eligibleRewardIds: [rewardId], state: { balanceLocked: true } };
  }

  async fulfill(): Promise<RaffleV2FulfillmentResponse> {
    this.stage('fulfill');
    return {
      cost: {
        currency: 'ERT',
        amountExact: '5',
        amountDisplay: '5.00',
        ledgerTransactionId: '77777777-7777-4777-8777-777777777777',
      },
      attempts: {
        limit: 5,
        used: 1,
        remaining: 4,
        day: '2026-08-31',
        resetsAt: '2026-09-01T00:00:00.000Z',
      },
      fulfillment: {
        type: 'ERT_CREDIT',
        ledgerTransactionId: '88888888-8888-4888-8888-888888888888',
        balanceAfterExact: '100',
        balanceAfterDisplay: '100.00',
      },
    };
  }

  private stage(name: string) {
    this.repository.calls.push(name);
    if (this.repository.failAt === name) throw new Error(`injected:${name}`);
  }
}

function fixture() {
  const repository = new FakeRepository();
  const random = new FakeRandom();
  const selector = new RaffleV2IntegerSelectionService(random);
  const fulfillment = new FakeFulfillment(repository);
  const service = new RaffleV2DrawCoreService(repository, selector, fulfillment);
  const idempotencyKey = randomUUID();
  const request = { contractVersion: 'raffle-v2', configurationVersion: configurationId, idempotencyKey };
  return { repository, random, service, idempotencyKey, request };
}

describe('RaffleV2DrawCoreService', () => {
  it('rejects a new operation while paused but replays a completed operation before availability', async () => {
    const { repository, service, request } = fixture();
    repository.machine.isAvailable = false;
    await assert.rejects(
      () => service.execute(ownerId, request),
      (error: unknown) => error instanceof RaffleV2DrawCoreError
        && error.reason === RaffleV2DrawCoreFailure.Unavailable,
    );
    repository.machine.isAvailable = true;
    const completed = await service.execute(ownerId, request);
    repository.machine.isAvailable = false;
    const replay = await service.execute(ownerId, request) as any;
    assert.equal((completed.operation as any).replayed, false);
    assert.equal(replay.operation.replayed, true);
  });
  it('uses the frozen canonical fingerprint bytes and rejects non-exact requests before transaction', async () => {
    assert.equal(
      raffleV2RequestFingerprint(ownerId.toUpperCase(), configurationId.toUpperCase()),
      '5ca429d2270566d7f3e13c47ae9d1147a2dc3793cd0386cba4ee6ec2b92ab711',
    );

    const { repository, service, request } = fixture();
    await assert.rejects(
      service.execute(ownerId, { ...request, ticket: 1 }),
      (error: unknown) => coreFailure(error, RaffleV2DrawCoreFailure.InvalidRequest),
    );
    assert.deepEqual(repository.calls, []);
  });

  it('executes a new operation in the frozen order and stores exact immutable selection evidence', async () => {
    const { repository, random, service, request } = fixture();
    const response = await service.execute(ownerId, request);

    assert.deepEqual(repository.calls, [
      'transaction', 'owner', 'existing', 'machine', 'configuration', 'claim',
      'rewards', 'prepare', 'result', 'fulfill', 'complete',
    ]);
    assert.equal(random.calls, 1);
    assert.equal(repository.results.length, 1);
    assert.deepEqual(
      {
        ticket: repository.results[0].ticket,
        totalWeight: repository.results[0].totalWeight,
        selectedRewardId: repository.results[0].selectedRewardId,
        selectedSegmentIndex: repository.results[0].selectedSegmentIndex,
        cost: repository.results[0].costErtExact,
      },
      { ticket: 12, totalWeight: 30, selectedRewardId: rewardId, selectedSegmentIndex: 0, cost: '5.000000000000000000' },
    );
    assert.deepEqual(response.operation, {
      operationId,
      idempotencyKey: request.idempotencyKey,
      status: 'COMPLETED',
      replayed: false,
    });
    assert.deepEqual(response.selection, {
      algorithm: 'CSPRNG_UNBIASED_INT_V1',
      ticket: '12',
      totalWeight: '30',
      selectedSegmentIndex: 0,
      ranges: [{
        segmentIndex: 0,
        rewardId,
        weight: '30',
        startInclusive: '0',
        endExclusive: '30',
      }],
    });
    assert.equal((response.reward as Record<string, unknown>).amountDisplay, '5.00');
    assert.deepEqual((response.reward as Record<string, unknown>).probability, {
      numerator: '30', denominator: '30',
    });
  });

  it('writes canonical fractional ERU and two-decimal display to immutable command evidence', async () => {
    const { repository, service, request } = fixture();
    repository.rewards[0].rewardSnapshot = {
      ...repository.rewards[0].rewardSnapshot,
      code: 'eru-fractional', title: 'Fractional ERU', type: 'ERU',
      amountExact: '1.235000000000000000', amountDisplay: 'stale',
    };
    const response = await service.execute(ownerId, request);
    assert.equal((response.reward as Record<string, unknown>).amountExact, '1.235');
    assert.equal((response.reward as Record<string, unknown>).amountDisplay, '1.24');
  });

  it('repairs a stale configured probability when replaying a completed Cooper result', async () => {
    const { repository, random, service, idempotencyKey, request } = fixture();
    const persisted = {
      contractVersion: 'raffle-v2',
      operation: { operationId, idempotencyKey, status: 'COMPLETED', replayed: false },
      draw: { configurationVersion: configurationId },
      selection: selectionSnapshot('1', '99'),
      reward: {
        type: 'COPPER_RING',
        weight: '1',
        probability: { numerator: '1', denominator: '100' },
      },
    };
    repository.operations.set(`${ownerId}:${idempotencyKey}`, Object.assign(new RaffleDrawOperation(), {
      id: operationId,
      ownerUserId: ownerId,
      idempotencyKey,
      requestFingerprint: raffleV2RequestFingerprint(ownerId, configurationId),
      contractVersion: 'raffle-v2',
      configurationId,
      status: RaffleDrawOperationStatus.Completed,
      responseSnapshot: persisted,
    }));

    const response = await service.execute(ownerId, request);

    assert.equal((response.operation as Record<string, unknown>).replayed, true);
    assert.deepEqual((response.reward as Record<string, unknown>).probability, {
      numerator: '1', denominator: '99',
    });
    assert.deepEqual((persisted.reward as Record<string, unknown>).probability, {
      numerator: '1', denominator: '100',
    });
    assert.deepEqual(repository.calls, ['transaction', 'owner', 'existing']);
    assert.equal(repository.results.length, 0);
    assert.equal(random.calls, 0);
  });

  it('returns a cloned historical replay after owner lock without config, RNG, fulfillment, or writes', async () => {
    const { repository, random, service, idempotencyKey, request } = fixture();
    const persisted = {
      contractVersion: 'raffle-v2',
      operation: { operationId, idempotencyKey, status: 'COMPLETED', replayed: false },
      draw: { configurationVersion: configurationId },
      selection: selectionSnapshot(),
      reward: { type: 'ERT', amountExact: '5', amountDisplay: '5.00' },
    };
    repository.operations.set(`${ownerId}:${idempotencyKey}`, Object.assign(new RaffleDrawOperation(), {
      id: operationId,
      ownerUserId: ownerId,
      idempotencyKey,
      requestFingerprint: raffleV2RequestFingerprint(ownerId, configurationId),
      contractVersion: 'raffle-v2',
      configurationId,
      status: RaffleDrawOperationStatus.Completed,
      responseSnapshot: persisted,
    }));

    const response = await service.execute(ownerId, request);

    assert.deepEqual(repository.calls, ['transaction', 'owner', 'existing']);
    assert.equal(random.calls, 0);
    assert.equal(repository.results.length, 0);
    assert.equal((response.operation as Record<string, unknown>).replayed, true);
    assert.equal(persisted.operation.replayed, false);
  });

  it('rejects same owner/key with another fingerprint before config and leaves history unchanged', async () => {
    const { repository, random, service, idempotencyKey, request } = fixture();
    repository.operations.set(`${ownerId}:${idempotencyKey}`, Object.assign(new RaffleDrawOperation(), {
      id: operationId,
      ownerUserId: ownerId,
      idempotencyKey,
      requestFingerprint: 'a'.repeat(64),
      status: RaffleDrawOperationStatus.Completed,
      responseSnapshot: { operation: { replayed: false } },
    }));

    await assert.rejects(
      service.execute(ownerId, request),
      (error: unknown) => coreFailure(error, RaffleV2DrawCoreFailure.IdempotencyConflict),
    );
    assert.deepEqual(repository.calls, ['transaction', 'owner', 'existing']);
    assert.equal(random.calls, 0);
    assert.equal(repository.results.length, 0);
  });

  for (const stage of ['claim', 'rewards', 'prepare', 'result', 'fulfill', 'complete']) {
    it(`rolls back operation and evidence when ${stage} fails`, async () => {
      const { repository, service, request } = fixture();
      repository.failAt = stage;

      await assert.rejects(service.execute(ownerId, request), new RegExp(`injected:${stage}`));
      assert.equal(repository.operations.size, 0);
      assert.equal(repository.results.length, 0);
    });
  }
});

function coreFailure(error: unknown, expected: RaffleV2DrawCoreFailure) {
  return error instanceof RaffleV2DrawCoreError && error.reason === expected;
}

function selectionSnapshot(weight = '30', totalWeight = '30') {
  return {
    selectedSegmentIndex: 0,
    totalWeight,
    ranges: [{ segmentIndex: 0, weight }],
  };
}
