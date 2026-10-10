import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MobileCredential } from './mobile-credential.entity';
import { MobileCredentialService } from './mobile-credential.service';
import { MobileSessionService } from './mobile-session.service';
import { PasswordHasherService } from './password-hasher.service';
import { User } from './user.entity';

class FakeCredentialRepository {
  credentials: MobileCredential[] = [];

  async findOne(options: { where: Partial<MobileCredential> }) {
    return this.credentials.find((credential) => Object.entries(options.where).every(
      ([key, value]) => credential[key as keyof MobileCredential] === value,
    )) ?? null;
  }

  create(input: Partial<MobileCredential>) {
    return { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...input } as MobileCredential;
  }

  async save(credential: MobileCredential) {
    const index = this.credentials.findIndex((candidate) => candidate.id === credential.id);
    if (index >= 0) this.credentials[index] = credential;
    else this.credentials.push(credential);
    return credential;
  }
}

class FakeUserRepository {
  users: User[] = [];

  async findOne(options: { where: Partial<User> }) {
    return this.users.find((user) => Object.entries(options.where).every(
      ([key, value]) => user[key as keyof User] === value,
    )) ?? null;
  }

  async save(user: User) {
    return user;
  }
}

class FakeMobileSessionService {
  revoked: Array<{ userId: string; reason: string }> = [];

  async revokeAllForUser(userId: string, reason: string) {
    this.revoked.push({ userId, reason });
  }
}

function fixture() {
  const credentials = new FakeCredentialRepository();
  const users = new FakeUserRepository();
  const sessions = new FakeMobileSessionService();
  const values: Record<string, string> = {
    MOBILE_AUTH_USERNAME: 'test',
    MOBILE_AUTH_PASSWORD: 'test',
    MOBILE_AUTH_TELEGRAM_ID: 'android-test',
    MOBILE_AUTH_DISPLAY_NAME: 'Test Player',
  };
  const service = new MobileCredentialService(
    credentials as unknown as Repository<MobileCredential>,
    users as unknown as Repository<User>,
    { get: (key: string) => values[key] } as ConfigService,
    new PasswordHasherService(),
    sessions as unknown as MobileSessionService,
  );
  const user = {
    id: 'user-id', telegramId: 'android-test', username: 'test', firstName: 'Test Player', lastName: null,
    photoUrl: null, isAdmin: false, lastLoginAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as User;
  users.users.push(user);
  return { credentials, sessions, service, user };
}

describe('MobileCredentialService', () => {
  it('bootstraps a legacy account into a salted hash and authenticates it', async () => {
    const { credentials, service, user } = fixture();
    await service.bootstrap(user, 'test', 'test');

    assert.equal(credentials.credentials.length, 1);
    assert.equal(credentials.credentials[0].passwordHash.includes('test'), false);
    assert.equal(await service.authenticate('test', 'test'), user);
    await assert.rejects(() => service.authenticate('test', 'wrong'), /Invalid mobile credentials/);
  });

  it('updates a validated display name without retaining a stale last name', async () => {
    const { service, user } = fixture();
    user.lastName = 'Old';
    const updated = await service.updateDisplayName(user, '  New Name  ');
    assert.equal(updated.firstName, 'New Name');
    assert.equal(updated.lastName, null);
    await assert.rejects(() => service.updateDisplayName(user, ''), /Display name/);
  });

  it('changes a bootstrapped password, revokes sessions, and rejects the old password', async () => {
    const { sessions, service, user } = fixture();
    await service.bootstrap(user, 'test', 'test');
    const result = await service.changePassword(user, 'test', 'new-secure-password');

    assert.deepEqual(result, { reauthenticationRequired: true });
    assert.deepEqual(sessions.revoked, [{ userId: user.id, reason: 'PASSWORD_CHANGED' }]);
    await assert.rejects(() => service.authenticate('test', 'test'), /Invalid mobile credentials/);
    assert.equal(await service.authenticate('test', 'new-secure-password'), user);
  });

  it('migrates a current legacy password during password change', async () => {
    const { credentials, service, user } = fixture();
    await service.changePassword(user, 'test', 'new-secure-password');
    assert.equal(credentials.credentials.length, 1);
    assert.equal(await service.authenticate('test', 'new-secure-password'), user);
  });

  it('rejects weak, unchanged, and incorrect password changes', async () => {
    const { service, user } = fixture();
    await service.bootstrap(user, 'test', 'test');
    await assert.rejects(
      () => service.changePassword(user, 'wrong', 'new-secure-password'),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 403,
    );
    await assert.rejects(() => service.changePassword(user, 'test', 'short'), /8-128/);
    await assert.rejects(() => service.changePassword(user, 'test', 'test'), /8-128|different/);
  });
});
