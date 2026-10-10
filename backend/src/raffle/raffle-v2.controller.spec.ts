import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpException, RequestMethod, UnauthorizedException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RaffleV2DrawCoreError, RaffleV2DrawCoreFailure } from './raffle-v2-draw-core.service';
import { RaffleV2FulfillmentError, RaffleV2FulfillmentFailure } from './raffle-v2-fulfillment.service';
import { RaffleV2Controller } from './raffle-v2.controller';

const ownerId = '10000000-0000-4000-8000-000000000001';

describe('RaffleV2Controller authenticated reads', () => {
  it('registers the frozen v2 paths behind JWT auth', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, RaffleV2Controller), 'raffle/v2');
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RaffleV2Controller), [JwtAuthGuard]);
    assertRoute('getDraw', 'draw', RequestMethod.GET);
    assertRoute('getHistory', 'history', RequestMethod.GET);
    assertRoute('draw', 'draw', RequestMethod.POST);
  });

  it('uses only the authenticated owner for current Draw and history reads', async () => {
    const reads = new FakeReads();
    const controller = new RaffleV2Controller(reads as never, new FakeDraws() as never);
    assert.deepEqual(await controller.getDraw(request()), { kind: 'current' });
    assert.deepEqual(await controller.getHistory(request(), { limit: '7', cursor: 'opaque' }), { kind: 'history' });
    assert.deepEqual(reads.calls, [
      ['current', ownerId],
      ['history', ownerId, { limit: '7', cursor: 'opaque' }],
    ]);
  });

  it('preserves auth failures and maps stable v2 read failures', async () => {
    const controller = new RaffleV2Controller(new FakeReads() as never, new FakeDraws() as never);
    await assert.rejects(() => controller.getDraw({ headers: {} }), UnauthorizedException);

    const unavailable = new FakeReads();
    unavailable.currentError = new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.Unavailable);
    await assert.rejects(
      () => new RaffleV2Controller(unavailable as never, new FakeDraws() as never).getDraw(request()),
      (error: unknown) => httpError(error, 404, 'RAFFLE_UNAVAILABLE'),
    );
  });

  it('passes the exact authenticated owner and request body to the transactional core', async () => {
    const draws = new FakeDraws();
    const body = {
      contractVersion: 'raffle-v2',
      configurationVersion: '10000000-0000-4000-8000-000000000002',
      idempotencyKey: '10000000-0000-4000-8000-000000000003',
    };
    const result = await new RaffleV2Controller(new FakeReads() as never, draws as never).draw(request(), body);
    assert.deepEqual(result, { kind: 'draw' });
    assert.deepEqual(draws.calls, [[ownerId, body]]);
  });

  it('maps frozen transactional failures without exposing internal details', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest), 400, 'RAFFLE_REQUEST_INVALID'],
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.ConfigurationStale), 409, 'RAFFLE_CONFIGURATION_STALE'],
      [new RaffleV2FulfillmentError(RaffleV2FulfillmentFailure.InsufficientBalance), 409, 'RAFFLE_INSUFFICIENT_ERT'],
      [new Error('database secret'), 503, 'RAFFLE_WRITE_UNAVAILABLE'],
    ];
    for (const [failure, status, code] of cases) {
      const draws = new FakeDraws();
      draws.error = failure;
      await assert.rejects(
        () => new RaffleV2Controller(new FakeReads() as never, draws as never).draw(request(), {}),
        (error: unknown) => httpError(error, status, code),
      );
    }
  });
});

class FakeReads {
  readonly calls: unknown[][] = [];
  currentError?: unknown;

  async getCurrent(owner: string) {
    this.calls.push(['current', owner]);
    if (this.currentError) throw this.currentError;
    return { kind: 'current' };
  }

  async getHistory(owner: string, query: unknown) {
    this.calls.push(['history', owner, query]);
    return { kind: 'history' };
  }
}

class FakeDraws {
  readonly calls: unknown[][] = [];
  error?: unknown;

  async execute(owner: string, body: unknown) {
    this.calls.push([owner, body]);
    if (this.error) throw this.error;
    return { kind: 'draw' };
  }
}

function assertRoute(name: 'getDraw' | 'getHistory' | 'draw', path: string, method: RequestMethod) {
  const handler = RaffleV2Controller.prototype[name];
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), method);
}

function request() {
  return { headers: {}, user: Object.assign(new User(), { id: ownerId }) };
}

function httpError(error: unknown, status: number, code: string) {
  return error instanceof HttpException
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
