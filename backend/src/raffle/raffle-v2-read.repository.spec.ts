import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { User } from '../auth/user.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { RaffleConfiguration } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleRingAward } from './raffle-ring-award.entity';
import { RaffleV2ReadRepository } from './raffle-v2-read.repository';

const ownerId = '10000000-0000-4000-8000-000000000001';
const resultId = '10000000-0000-4000-8000-000000000002';
const operationId = '10000000-0000-4000-8000-000000000003';

describe('RaffleV2ReadRepository history', () => {
  it('reads current configuration and owner eligibility in one repeatable-read snapshot', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const repositories = new Map<unknown, any>([
      [User, { existsBy: async (where: unknown) => { calls.push(['owner', where]); return true; } }],
      [RaffleMachine, { findOneBy: async () => ({ id: resultId, singletonKey: 1, isAvailable: true, pausedAt: null }) }],
      [RaffleConfiguration, { findOneBy: async () => ({ id: operationId }) }],
      [RaffleConfigurationReward, { find: async (options: unknown) => { calls.push(['rewards', options]); return []; } }],
      [DailyUserStats, { findOneBy: async (where: unknown) => { calls.push(['stats', where]); return null; } }],
      [RaffleRingAward, { existsBy: async (where: unknown) => { calls.push(['award', where]); return false; } }],
    ]);
    const manager = { getRepository: (entity: unknown) => repositories.get(entity) };
    const dataSource: any = {
      transaction: async (isolation: string, operation: (value: unknown) => unknown) => {
        calls.push(['transaction', isolation]);
        return operation(manager);
      },
    };
    const snapshot = await new RaffleV2ReadRepository(dataSource).readCurrent(ownerId, '2026-08-31');

    assert.ok(calls.some((call) => call[0] === 'transaction' && call[1] === 'REPEATABLE READ'));
    assert.ok(calls.some((call) => JSON.stringify(call).includes(ownerId)));
    assert.ok(calls.some((call) => JSON.stringify(call).includes('2026-08-31')));
    assert.equal(snapshot.ownerExists, true);
    assert.equal(snapshot.attemptsUsed, 0);
    assert.equal(snapshot.copperAwarded, false);
  });

  it('enforces owner scope, stable descending cursor order, and one-row lookahead', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const result = Object.assign(new RaffleDrawResultV2(), {
      id: resultId,
      operationId,
      createdAt: new Date('2026-08-31T12:00:00.000Z'),
      operation: { responseSnapshot: { contractVersion: 'raffle-v2' } },
    });
    const query: any = {
      innerJoinAndSelect: (...args: unknown[]) => { calls.push(['join', ...args]); return query; },
      where: (...args: unknown[]) => { calls.push(['where', ...args]); return query; },
      andWhere: (...args: unknown[]) => { calls.push(['andWhere', ...args]); return query; },
      orderBy: (...args: unknown[]) => { calls.push(['orderBy', ...args]); return query; },
      addOrderBy: (...args: unknown[]) => { calls.push(['addOrderBy', ...args]); return query; },
      take: (...args: unknown[]) => { calls.push(['take', ...args]); return query; },
      getMany: async () => [result],
    };
    const dataSource: any = {
      getRepository: () => ({ createQueryBuilder: () => query }),
    };
    const repository = new RaffleV2ReadRepository(dataSource);
    const rows = await repository.readHistory(ownerId, 20, {
      createdAt: '2026-08-31T12:01:00.000Z', drawResultId: resultId,
    });

    const rendered = JSON.stringify(calls);
    assert.match(rendered, /result\.ownerUserId = :ownerUserId/);
    assert.match(rendered, /operation\.ownerUserId = :ownerUserId/);
    assert.match(rendered, /result\.createdAt < :cursorCreatedAt/);
    assert.ok(calls.some((call) => call[0] === 'orderBy' && call[1] === 'result.createdAt' && call[2] === 'DESC'));
    assert.ok(calls.some((call) => call[0] === 'addOrderBy' && call[1] === 'result.id' && call[2] === 'DESC'));
    assert.ok(calls.some((call) => call[0] === 'take' && call[1] === 21));
    assert.deepEqual(rows, [{
      drawResultId: resultId,
      operationId,
      createdAt: result.createdAt,
      responseSnapshot: { contractVersion: 'raffle-v2' },
    }]);
  });
});
