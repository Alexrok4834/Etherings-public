import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { DataSource, EntityManager } from 'typeorm';
import { Balance } from '../balance/balance.entity';
import { CopperRingEntitlementService } from '../ring/copper-ring-entitlement.service';
import { CopperIssuanceReason } from '../ring/game-ring.entity';
import { MobileCredential } from './mobile-credential.entity';
import { MobileRegistrationService } from './mobile-registration.service';
import { PasswordHasherService } from './password-hasher.service';
import { User } from './user.entity';

class FakeManager {
  users: User[] = [];
  credentials: MobileCredential[] = [];
  balances: Balance[] = [];
  failBalanceSave = false;

  create<T extends object>(target: new () => T, input: Partial<T>) {
    return Object.assign(new target(), input, {
      ...(target === Balance ? {} : { id: randomUUID() }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async save<T>(entity: T): Promise<T> {
    if (entity instanceof Balance && this.failBalanceSave) throw new Error('balance write failed');
    if (entity instanceof User) this.users.push(entity);
    if (entity instanceof MobileCredential) this.credentials.push(entity);
    if (entity instanceof Balance) this.balances.push(entity);
    return entity;
  }

  createQueryBuilder() {
    let username = '';
    const builder = {
      where: (_sql: string, parameters: { username: string }) => {
        username = parameters.username;
        return builder;
      },
      getOne: async () => this.credentials.find((item) => item.username.toLowerCase() === username) ?? null,
    };
    return builder;
  }
}

class FakeDataSource {
  readonly manager = new FakeManager();

  async transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
    const snapshot = {
      users: [...this.manager.users],
      credentials: [...this.manager.credentials],
      balances: [...this.manager.balances],
    };
    try {
      return await operation(this.manager as unknown as EntityManager);
    } catch (error) {
      this.manager.users = snapshot.users;
      this.manager.credentials = snapshot.credentials;
      this.manager.balances = snapshot.balances;
      throw error;
    }
  }
}

class FakeCopperEntitlementService {
  calls: Array<{ manager: EntityManager; userId: string; reason: CopperIssuanceReason }> = [];
  fail = false;

  async ensureStarterCopperInTransaction(manager: EntityManager, userId: string, reason: CopperIssuanceReason) {
    this.calls.push({ manager, userId, reason });
    if (this.fail) throw new Error('copper issuance failed');
    return { ring: { id: 'ring-id' }, created: true };
  }
}

function fixture() {
  const dataSource = new FakeDataSource();
  const hasher = new PasswordHasherService();
  const copper = new FakeCopperEntitlementService();
  const service = new MobileRegistrationService(
    dataSource as unknown as DataSource,
    hasher,
    copper as unknown as CopperRingEntitlementService,
  );
  return { dataSource, hasher, copper, service };
}

describe('MobileRegistrationService', () => {
  it('atomically creates a normalized player, hash-only credential, and zero balance', async () => {
    const { dataSource, hasher, copper, service } = fixture();
    const user = await service.register({
      username: '  New_Player  ',
      password: 'secure-password',
      displayName: '  New Player  ',
    });

    assert.equal(user.username, 'new_player');
    assert.equal(user.firstName, 'New Player');
    assert.match(user.telegramId, /^mobile:[0-9a-f-]{36}$/);
    assert.equal(dataSource.manager.credentials.length, 1);
    assert.equal(dataSource.manager.credentials[0].passwordHash.includes('secure-password'), false);
    assert.equal(await hasher.verify('secure-password', dataSource.manager.credentials[0].passwordHash), true);
    assert.deepEqual(dataSource.manager.balances.map((balance) => ({
      userId: balance.userId,
      ertBalance: balance.ertBalance,
      earned: balance.lifetimeEarnedErt,
      spent: balance.lifetimeSpentErt,
    })), [{ userId: user.id, ertBalance: 0, earned: 0, spent: 0 }]);
    assert.deepEqual(copper.calls.map((call) => ({ userId: call.userId, reason: call.reason })), [
      { userId: user.id, reason: CopperIssuanceReason.Registration },
    ]);
    assert.equal(copper.calls[0].manager, dataSource.manager);
  });

  it('rejects duplicate usernames without creating partial records', async () => {
    const { dataSource, service } = fixture();
    await service.register({ username: 'player_one', password: 'secure-password', displayName: 'First' });

    await assert.rejects(
      () => service.register({ username: 'PLAYER_ONE', password: 'another-password', displayName: 'Second' }),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 409,
    );
    assert.equal(dataSource.manager.users.length, 1);
    assert.equal(dataSource.manager.credentials.length, 1);
    assert.equal(dataSource.manager.balances.length, 1);
  });

  it('rolls back user and credential if balance creation fails', async () => {
    const { dataSource, service } = fixture();
    dataSource.manager.failBalanceSave = true;

    await assert.rejects(() => service.register({
      username: 'rollback_user',
      password: 'secure-password',
      displayName: 'Rollback',
    }), /balance write failed/);
    assert.equal(dataSource.manager.users.length, 0);
    assert.equal(dataSource.manager.credentials.length, 0);
    assert.equal(dataSource.manager.balances.length, 0);
  });

  it('rolls back user, credential, and balance if Copper issuance fails', async () => {
    const { dataSource, copper, service } = fixture();
    copper.fail = true;

    await assert.rejects(() => service.register({
      username: 'ring_rollback',
      password: 'secure-password',
      displayName: 'Ring Rollback',
    }), /copper issuance failed/);
    assert.equal(dataSource.manager.users.length, 0);
    assert.equal(dataSource.manager.credentials.length, 0);
    assert.equal(dataSource.manager.balances.length, 0);
    assert.equal(copper.calls.length, 1);
  });

  it('validates username, password, and display name before opening a transaction', async () => {
    const { dataSource, service } = fixture();
    await assert.rejects(() => service.register({ username: 'a!', password: 'secure-password', displayName: 'Player' }));
    await assert.rejects(() => service.register({ username: 'player', password: 'short', displayName: 'Player' }));
    await assert.rejects(() => service.register({ username: 'player', password: 'secure-password', displayName: ' ' }));
    assert.equal(dataSource.manager.users.length, 0);
  });
});
