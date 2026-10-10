import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { User } from '../auth/user.entity';
import { AdminGuard } from './admin.guard';

function contextFor(user?: User) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        user,
      }),
    }),
  } as never;
}

describe('AdminGuard', () => {
  it('allows admin users', () => {
    const guard = new AdminGuard();
    const user = { id: 'admin-id', telegramId: '1', isAdmin: true } as User;

    assert.equal(guard.canActivate(contextFor(user)), true);
  });

  it('rejects non-admin users', () => {
    const guard = new AdminGuard();
    const user = { id: 'user-id', telegramId: '2', isAdmin: false } as User;

    assert.throws(() => guard.canActivate(contextFor(user)), ForbiddenException);
  });

  it('rejects requests without an authenticated user', () => {
    const guard = new AdminGuard();

    assert.throws(() => guard.canActivate(contextFor()), UnauthorizedException);
  });
});