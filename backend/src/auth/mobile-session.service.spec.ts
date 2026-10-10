import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { DataSource, EntityManager } from 'typeorm';
import { StepSyncInstallation, StepSyncInstallationStatus } from '../step-sync/step-sync-installation.entity';
import { AuthService } from './auth.service';
import { MobileRefreshToken, MobileRefreshTokenStatus } from './mobile-refresh-token.entity';
import { MobileSessionConfigService } from './mobile-session-config.service';
import { MobileSessionService } from './mobile-session.service';
import { User } from './user.entity';

class FakeManager {
  users: User[] = [];
  installations: StepSyncInstallation[] = [];
  tokens: MobileRefreshToken[] = [];

  create<T extends object>(target: new () => T, input: Partial<T>) {
    return Object.assign(new target(), input, {
      id: (input as { id?: string }).id ?? randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async save<T>(entity: T): Promise<T> {
    const list = entity instanceof MobileRefreshToken
      ? this.tokens
      : entity instanceof StepSyncInstallation
        ? this.installations
        : this.users;
    const index = list.findIndex((candidate) => candidate.id === (entity as { id: string }).id);
    if (index === -1) list.push(entity as never);
    else list[index] = entity as never;
    return entity;
  }

  async findOne<T>(target: new () => T, options: { where: Record<string, unknown> }): Promise<T | null> {
    const list = target === MobileRefreshToken
      ? this.tokens
      : target === StepSyncInstallation
        ? this.installations
        : this.users;
    return (list.find((candidate) => Object.entries(options.where).every(
      ([key, value]) => (candidate as unknown as Record<string, unknown>)[key] === value,
    )) ?? null) as T | null;
  }

  async find<T>(target: new () => T, options: { where: Record<string, unknown> }): Promise<T[]> {
    const list = target === MobileRefreshToken
      ? this.tokens
      : target === StepSyncInstallation
        ? this.installations
        : this.users;
    return list.filter((candidate) => Object.entries(options.where).every(
      ([key, value]) => (candidate as unknown as Record<string, unknown>)[key] === value,
    )) as T[];
  }

  createQueryBuilder() {
    let values: Partial<MobileRefreshToken> = {};
    return {
      update: () => this.createQueryBuilderUpdate((next) => { values = next; }, () => values),
    };
  }

  private createQueryBuilderUpdate(
    setValues: (value: Partial<MobileRefreshToken>) => void,
    getValues: () => Partial<MobileRefreshToken>,
  ) {
    let familyId: string | null = null;
    let userId: string | null = null;
    let excludedStatus: MobileRefreshTokenStatus | null = null;
    const builder = {
      set: (value: Partial<MobileRefreshToken>) => { setValues(value); return builder; },
      where: (_sql: string, params: { familyId?: string; userId?: string }) => {
        familyId = params.familyId ?? familyId;
        userId = params.userId ?? userId;
        return builder;
      },
      andWhere: (_sql: string, params: { status: MobileRefreshTokenStatus }) => {
        excludedStatus = params.status;
        return builder;
      },
      execute: async () => {
        const matching = this.tokens.filter((candidate) => (
          (familyId === null || candidate.familyId === familyId)
          && (userId === null || candidate.userId === userId)
          && (excludedStatus === null || candidate.status !== excludedStatus)
        ));
        for (const token of matching) {
          Object.assign(token, getValues());
        }
        return { affected: matching.length };
      },
    };
    return builder;
  }
}

class FakeDataSource {
  constructor(readonly manager: FakeManager) {}
  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    return operation(this.manager as unknown as EntityManager);
  }
}

class FakeAuthService {
  async signUserToken(user: User) {
    return `access:${user.id}`;
  }
}

class FakeConfig {
  refreshTokenTtlSeconds = 30 * 86_400;
  assertSecureRefreshTransport() {}
}

function fixture() {
  const manager = new FakeManager();
  const user = Object.assign(new User(), {
    id: randomUUID(),
    telegramId: 'android-test',
    username: 'test',
    firstName: 'Test',
    lastName: null,
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  manager.users.push(user);
  const service = new MobileSessionService(
    new FakeDataSource(manager) as unknown as DataSource,
    new FakeAuthService() as unknown as AuthService,
    new FakeConfig() as unknown as MobileSessionConfigService,
  );
  return { manager, service, user, installationId: randomUUID() };
}

function errorCode(error: unknown) {
  const response = (error as { getResponse: () => unknown }).getResponse() as { code?: string };
  return response.code;
}

describe('MobileSessionService', () => {
  it('stores only a hash and binds a new token family to user and installation', async () => {
    const { manager, service, user, installationId } = fixture();
    const result = await service.issue(user, installationId);

    assert.equal(result.accessToken, `access:${user.id}`);
    assert.equal(manager.installations.length, 1);
    assert.equal(manager.installations[0].installationId, installationId);
    assert.equal(manager.installations[0].status, StepSyncInstallationStatus.Active);
    assert.equal(manager.tokens.length, 1);
    assert.notEqual(manager.tokens[0].tokenHash, result.refreshToken);
    assert.equal(manager.tokens[0].tokenHash, createHash('sha256').update(result.refreshToken).digest('hex'));
    assert.equal(manager.tokens[0].status, MobileRefreshTokenStatus.Active);
  });

  it('rotates a token and preserves one family and installation binding', async () => {
    const { manager, service, user, installationId } = fixture();
    const issued = await service.issue(user, installationId);
    const rotated = await service.refresh(issued.refreshToken, installationId);

    assert.notEqual(rotated.refreshToken, issued.refreshToken);
    assert.equal(manager.tokens.length, 2);
    assert.equal(manager.tokens[0].status, MobileRefreshTokenStatus.Rotated);
    assert.equal(manager.tokens[0].replacedByTokenId, manager.tokens[1].id);
    assert.equal(manager.tokens[1].parentTokenId, manager.tokens[0].id);
    assert.equal(manager.tokens[1].familyId, manager.tokens[0].familyId);
    assert.equal(manager.tokens[1].status, MobileRefreshTokenStatus.Active);
  });

  it('revokes the previous family when the same installation signs in again', async () => {
    const { manager, service, user, installationId } = fixture();
    await service.issue(user, installationId);
    const replacementLogin = await service.issue(user, installationId);

    assert.equal(manager.installations.length, 1);
    assert.equal(manager.tokens.length, 2);
    assert.equal(manager.tokens[0].status, MobileRefreshTokenStatus.Revoked);
    assert.equal(manager.tokens[0].revocationReason, 'REAUTHENTICATED');
    assert.equal(manager.tokens[1].status, MobileRefreshTokenStatus.Active);
    assert.equal(manager.tokens[1].tokenHash, createHash('sha256').update(replacementLogin.refreshToken).digest('hex'));
  });

  it('detects replay and revokes the entire rotated family', async () => {
    const { manager, service, user, installationId } = fixture();
    const issued = await service.issue(user, installationId);
    await service.refresh(issued.refreshToken, installationId);

    await assert.rejects(
      () => service.refresh(issued.refreshToken, installationId),
      (error) => errorCode(error) === 'REFRESH_TOKEN_REPLAYED',
    );
    assert.equal(manager.tokens.every((token) => token.status === MobileRefreshTokenStatus.Revoked), true);
    assert.equal(manager.tokens.every((token) => token.revocationReason === 'REPLAY_DETECTED'), true);
  });

  it('revokes the family on installation mismatch or expiry', async () => {
    const first = fixture();
    const issued = await first.service.issue(first.user, first.installationId);
    await assert.rejects(
      () => first.service.refresh(issued.refreshToken, randomUUID()),
      (error) => errorCode(error) === 'REFRESH_TOKEN_INSTALLATION_MISMATCH',
    );
    assert.equal(first.manager.tokens[0].status, MobileRefreshTokenStatus.Revoked);

    const second = fixture();
    const expired = await second.service.issue(second.user, second.installationId);
    second.manager.tokens[0].expiresAt = new Date(Date.now() - 1);
    await assert.rejects(
      () => second.service.refresh(expired.refreshToken, second.installationId),
      (error) => errorCode(error) === 'REFRESH_TOKEN_EXPIRED',
    );
    assert.equal(second.manager.tokens[0].revocationReason, 'EXPIRED');
  });

  it('revokes the full family on logout and keeps logout idempotent', async () => {
    const { manager, service, user, installationId } = fixture();
    const issued = await service.issue(user, installationId);
    const rotated = await service.refresh(issued.refreshToken, installationId);

    await service.logout(rotated.refreshToken);
    await service.logout(rotated.refreshToken);
    await service.logout('unknown-but-well-formed-refresh-token-value-000000');

    assert.equal(manager.tokens.every((token) => token.status === MobileRefreshTokenStatus.Revoked), true);
    assert.equal(manager.tokens.every((token) => token.revocationReason === 'LOGOUT'), true);
  });

  it('revokes every renewable session after a password change', async () => {
    const { manager, service, user, installationId } = fixture();
    await service.issue(user, installationId);
    await service.issue(user, randomUUID());

    await service.revokeAllForUser(user.id, 'PASSWORD_CHANGED');

    assert.equal(manager.tokens.every((token) => token.status === MobileRefreshTokenStatus.Revoked), true);
    assert.equal(manager.tokens.every((token) => token.revocationReason === 'PASSWORD_CHANGED'), true);
  });
});
