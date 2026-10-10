import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoneException, UnauthorizedException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { LEGACY_RAFFLE_PLAYER_DRAW_RETIRED_CODE } from './raffle-legacy-write.errors';
import { RaffleController } from './raffle.controller';

const ownerId = '10000000-0000-4000-8000-000000000001';

describe('RaffleController legacy compatibility boundary', () => {
  it('preserves legacy pool and history reads', async () => {
    const compatibility = new FakeCompatibility();
    const controller = new RaffleController(compatibility as never);
    assert.deepEqual(await controller.listPools(), [{ id: 'pool' }]);
    assert.deepEqual(await controller.history(request()), [{ id: 'history' }]);
    assert.deepEqual(compatibility.calls, [
      ['pools'], ['history', ownerId],
    ]);
  });

  it('keeps authentication mandatory and retires the legacy player Draw without delegation', () => {
    const compatibility = new FakeCompatibility();
    const controller = new RaffleController(compatibility as never);
    assert.throws(() => controller.history({ headers: {} }), UnauthorizedException);
    assert.throws(() => controller.draw({ headers: {} }), UnauthorizedException);
    assert.throws(
      () => controller.draw(request()),
      (error: unknown) => error instanceof GoneException
        && error.getStatus() === 410
        && (error.getResponse() as { code?: string }).code === LEGACY_RAFFLE_PLAYER_DRAW_RETIRED_CODE,
    );
    assert.deepEqual(compatibility.calls, []);
  });
});

class FakeCompatibility {
  readonly calls: unknown[][] = [];
  async listPools() { this.calls.push(['pools']); return [{ id: 'pool' }]; }
  async listHistory(user: User) { this.calls.push(['history', user.id]); return [{ id: 'history' }]; }
}

function request() { return { headers: {}, user: Object.assign(new User(), { id: ownerId }) }; }
