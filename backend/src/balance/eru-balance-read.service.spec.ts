import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Balance } from './balance.entity';
import { EruBalanceReadService } from './eru-balance-read.service';

describe('EruBalanceReadService', () => {
  it('returns authoritative strings and compatibility numbers only inside the safe range', () => {
    const service = new EruBalanceReadService({} as DataSource);
    assert.deepEqual(service.toValues({
      eruBalance: '100',
      lifetimeEarnedEru: '9007199254740991',
      lifetimeSpentEru: '9007199254740992',
    }), {
      eruBalance: 100,
      eruBalanceExact: '100',
      eruBalanceDisplay: '100.00',
      lifetimeEarnedEru: Number.MAX_SAFE_INTEGER,
      lifetimeEarnedEruExact: '9007199254740991',
      lifetimeEarnedEruDisplay: '9007199254740991.00',
      lifetimeSpentEru: null,
      lifetimeSpentEruExact: '9007199254740992',
      lifetimeSpentEruDisplay: '9007199254740992.00',
    });
  });

  it('normalizes PostgreSQL scale and does not expose fractional legacy numbers', () => {
    const service = new EruBalanceReadService({} as DataSource);
    assert.deepEqual(service.toValues({
      eruBalance: '34.125000000000000000',
      lifetimeEarnedEru: '100.005000000000000000',
      lifetimeSpentEru: '65.880000000000000000',
    }), {
      eruBalance: null,
      eruBalanceExact: '34.125',
      eruBalanceDisplay: '34.13',
      lifetimeEarnedEru: null,
      lifetimeEarnedEruExact: '100.005',
      lifetimeEarnedEruDisplay: '100.01',
      lifetimeSpentEru: null,
      lifetimeSpentEruExact: '65.88',
      lifetimeSpentEruDisplay: '65.88',
    });
  });

  it('fails closed for malformed exact database values', () => {
    const service = new EruBalanceReadService({} as DataSource);
    for (const value of ['01', '-1', '1e3', '9'.repeat(31), '1.1234567890123456789']) {
      assert.throws(() => service.toValues({
        eruBalance: value,
        lifetimeEarnedEru: '0',
        lifetimeSpentEru: '0',
      }), /canonical ERU decimal/);
    }
  });

  it('returns an owner balance without exposing a mutation method and rejects missing rows', async () => {
    const balance = {
      userId: '10000000-0000-4000-8000-000000000001',
      eruBalance: '12',
      lifetimeEarnedEru: '20',
      lifetimeSpentEru: '8',
      updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    } as Balance;
    const dataSource = {
      query: async (_sql: string, [userId]: [string]) =>
        userId === balance.userId ? [balance] : [],
    } as unknown as DataSource;
    const service = new EruBalanceReadService(dataSource);

    assert.deepEqual(await service.getRequired(balance.userId), {
      userId: balance.userId,
      eruBalance: 12,
      eruBalanceExact: '12',
      eruBalanceDisplay: '12.00',
      lifetimeEarnedEru: 20,
      lifetimeEarnedEruExact: '20',
      lifetimeEarnedEruDisplay: '20.00',
      lifetimeSpentEru: 8,
      lifetimeSpentEruExact: '8',
      lifetimeSpentEruDisplay: '8.00',
      updatedAt: balance.updatedAt,
    });
    await assert.rejects(() => service.getRequired('missing'), NotFoundException);
    for (const method of ['credit', 'debit', 'grant', 'adjust', 'replace']) {
      assert.equal(method in service, false);
    }
  });
});
