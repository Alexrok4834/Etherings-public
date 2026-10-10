import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';
import { User } from './user.entity';

class FakeAuthService {
  token?: string;
  user = { id: 'user-id', telegramId: '424242' } as User;

  async verifyAccessToken(token: string) {
    this.token = token;
    return this.user;
  }
}

function contextFor(request: RequestWithUser) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}

describe('JwtAuthGuard', () => {
  it('attaches user for a valid Bearer token', async () => {
    const authService = new FakeAuthService();
    const guard = new JwtAuthGuard(authService as never);
    const request: RequestWithUser = { headers: { authorization: 'Bearer abc.def' } };

    const result = await guard.canActivate(contextFor(request));

    assert.equal(result, true);
    assert.equal(authService.token, 'abc.def');
    assert.equal(request.user, authService.user);
  });

  it('rejects missing Authorization header', async () => {
    const guard = new JwtAuthGuard(new FakeAuthService() as never);
    const request: RequestWithUser = { headers: {} };

    await assert.rejects(() => guard.canActivate(contextFor(request)), UnauthorizedException);
  });

  it('rejects non-Bearer Authorization header', async () => {
    const guard = new JwtAuthGuard(new FakeAuthService() as never);
    const request: RequestWithUser = { headers: { authorization: 'Basic abc' } };

    await assert.rejects(() => guard.canActivate(contextFor(request)), UnauthorizedException);
  });
});
