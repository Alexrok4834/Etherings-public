import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Repository } from 'typeorm';
import { AuthService } from './auth.service';
import { TelegramInitDataService, VerifiedTelegramInitData } from './telegram-init-data.service';
import { LedgerService } from '../balance/ledger.service';
import { User } from './user.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { M2ePlayerEconomyReadService } from '../m2e/m2e-player-economy-read.service';
import { EruBalanceReadService } from '../balance/eru-balance-read.service';

class FakeUserRepository {
  users = new Map<string, User>();
  saveCalls = 0;

  async findOne(options: { where: { id?: string; telegramId?: string } }) {
    if (options.where.telegramId) {
      return this.users.get(options.where.telegramId) ?? null;
    }

    return [...this.users.values()].find((user) => user.id === options.where.id) ?? null;
  }

  create(input: Partial<User>) {
    return {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    } as User;
  }

  async save(user: User) {
    this.saveCalls += 1;
    user.updatedAt = new Date();
    this.users.set(user.telegramId, user);
    return user;
  }
}

class FakeTelegramInitDataService {
  verifyCalls: Array<{ initData: string; botToken: string }> = [];

  verify(initData: string, botToken: string) {
    this.verifyCalls.push({ initData, botToken });
    return verifiedTelegramUser();
  }
}

class FakeDailyUserStatsRepository {
  stats = new Map<string, DailyUserStats>();
  history: DailyUserStats[] = [];
  findOptions: unknown;

  async findOne(options: { where: { userId: string; date: string } }) {
    return this.stats.get(`${options.where.userId}:${options.where.date}`) ?? null;
  }

  async find(options: unknown) {
    this.findOptions = options;
    return this.history;
  }
}

class FakeLedgerService {
  ensuredUserIds: string[] = [];

  async ensureBalance(userId: string) {
    this.ensuredUserIds.push(userId);
    return {
      userId,
      ertBalance: 0,
      lifetimeEarnedErt: 0,
      lifetimeSpentErt: 0,
      eruBalance: '12',
      lifetimeEarnedEru: '20',
      lifetimeSpentEru: '8',
      updatedAt: new Date(),
    };
  }
}

class FakePlayerEconomyReadService {
  constructor(private readonly dailyStats: FakeDailyUserStatsRepository) {}

  async getProfile(userId: string, date: string) {
    const earned = String(this.dailyStats.stats.get(`${userId}:${date}`)?.earnedErt ?? 0);
    return {
      ertBalance: { exact: '0', display: '0.00' },
      lifetimeEarnedErt: { exact: '0', display: '0.00' },
      lifetimeSpentErt: { exact: '0', display: '0.00' },
      earnedErtToday: { exact: earned, display: `${earned}.00` },
      dailyStepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    };
  }

  async getActivity() {
    return new Map(this.dailyStats.history.map((row) => [row.date, {
      date: row.date,
      earnedErt: { exact: String(row.earnedErt), display: `${row.earnedErt}.00` },
      dailyStepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    }]));
  }
}

class FakeEruBalanceReadService {
  toValues(balance: { eruBalance: string; lifetimeEarnedEru: string; lifetimeSpentEru: string }) {
    return {
      eruBalance: Number(balance.eruBalance),
      eruBalanceExact: balance.eruBalance,
      lifetimeEarnedEru: Number(balance.lifetimeEarnedEru),
      lifetimeEarnedEruExact: balance.lifetimeEarnedEru,
      lifetimeSpentEru: Number(balance.lifetimeSpentEru),
      lifetimeSpentEruExact: balance.lifetimeSpentEru,
    };
  }
}

class FakeJwtService {
  payloads: unknown[] = [];

  async signAsync(payload: unknown) {
    this.payloads.push(payload);
    return 'signed-token';
  }

  async verifyAsync() {
    return {
      sub: 'user-id',
      telegramId: '424242',
      username: 'alice_runner',
      isAdmin: false,
    };
  }
}

function createService() {
  const repository = new FakeUserRepository();
  const verifier = new FakeTelegramInitDataService();
  const jwt = new FakeJwtService();
  const ledger = new FakeLedgerService();
  const dailyStats = new FakeDailyUserStatsRepository();
  const service = new AuthService(
    repository as unknown as Repository<User>,
    dailyStats as unknown as Repository<DailyUserStats>,
    verifier as unknown as TelegramInitDataService,
    jwt as never,
    ledger as unknown as LedgerService,
    new FakePlayerEconomyReadService(dailyStats) as unknown as M2ePlayerEconomyReadService,
    new FakeEruBalanceReadService() as unknown as EruBalanceReadService,
  );

  return { repository, verifier, jwt, ledger, dailyStats, service };
}

function verifiedTelegramUser(overrides: Partial<VerifiedTelegramInitData['user']> = {}) {
  return {
    fields: {},
    user: {
      id: 424242,
      first_name: 'Alice',
      last_name: 'Runner',
      username: 'alice_runner',
      photo_url: 'https://example.test/avatar.jpg',
      ...overrides,
    },
  } satisfies VerifiedTelegramInitData;
}

function mobileLoginInput(overrides: Partial<Parameters<AuthService['loginWithMobilePassword']>[0]> = {}) {
  return {
    username: 'player',
    password: 'secret-password',
    expectedUsername: 'player',
    expectedPassword: 'secret-password',
    mobileTelegramId: 'android-mvp-player',
    displayName: 'Android MVP Player',
    ...overrides,
  };
}

describe('AuthService', () => {
  it('creates a user from verified Telegram initData', async () => {
    const { repository, ledger, service } = createService();

    const user = await service.upsertTelegramUser(verifiedTelegramUser());

    assert.equal(user.telegramId, '424242');
    assert.equal(user.username, 'alice_runner');
    assert.equal(user.firstName, 'Alice');
    assert.equal(user.lastName, 'Runner');
    assert.equal(user.photoUrl, 'https://example.test/avatar.jpg');
    assert.equal(user.isAdmin, false);
    assert.ok(user.lastLoginAt instanceof Date);
    assert.equal(repository.saveCalls, 1);
    assert.deepEqual(ledger.ensuredUserIds, [user.id]);
  });

  it('updates an existing user from verified Telegram initData', async () => {
    const { repository, ledger, service } = createService();

    const created = await service.upsertTelegramUser(verifiedTelegramUser());
    const updated = await service.upsertTelegramUser(
      verifiedTelegramUser({
        first_name: 'Alicia',
        last_name: undefined,
        username: 'new_username',
        photo_url: undefined,
      }),
    );

    assert.equal(updated.id, created.id);
    assert.equal(updated.telegramId, '424242');
    assert.equal(updated.username, 'new_username');
    assert.equal(updated.firstName, 'Alicia');
    assert.equal(updated.lastName, null);
    assert.equal(updated.photoUrl, null);
    assert.equal(repository.users.size, 1);
    assert.equal(repository.saveCalls, 2);
    assert.deepEqual(ledger.ensuredUserIds, [created.id]);
  });

  it('verifies Telegram initData and returns a JWT during login', async () => {
    const { verifier, jwt, service } = createService();

    const result = await service.loginWithTelegram('signed-init-data', 'bot-token');

    assert.equal(result.accessToken, 'signed-token');
    assert.equal(result.user.telegramId, '424242');
    assert.deepEqual(verifier.verifyCalls, [{ initData: 'signed-init-data', botToken: 'bot-token' }]);
    assert.deepEqual(jwt.payloads, [
      {
        sub: result.user.id,
        telegramId: '424242',
        username: 'alice_runner',
        isAdmin: false,
      },
    ]);
  });

  it('returns a JWT for configured admin password login', async () => {
    const { jwt, service } = createService();
    const user = await service.upsertTelegramUser(verifiedTelegramUser({ id: 324462035, username: 'admin_user' }));
    user.isAdmin = true;

    const result = await service.loginWithAdminPassword({
      username: 'admin',
      password: 'secret-password',
      expectedUsername: 'admin',
      expectedPassword: 'secret-password',
      adminTelegramId: '324462035',
    });

    assert.equal(result.accessToken, 'signed-token');
    assert.equal(result.user.telegramId, '324462035');
    assert.deepEqual(jwt.payloads.at(-1), {
      sub: user.id,
      telegramId: '324462035',
      username: 'admin_user',
      isAdmin: true,
    });
  });

  it('rejects invalid admin password login attempts', async () => {
    const { service } = createService();
    await service.upsertTelegramUser(verifiedTelegramUser({ id: 324462035 }));

    await assert.rejects(
      () => service.loginWithAdminPassword({
        username: 'admin',
        password: 'wrong',
        expectedUsername: 'admin',
        expectedPassword: 'secret-password',
        adminTelegramId: '324462035',
      }),
      /Invalid admin credentials/,
    );

    await assert.rejects(
      () => service.loginWithAdminPassword({
        username: 'admin',
        password: 'secret-password',
        expectedUsername: 'admin',
        expectedPassword: 'secret-password',
        adminTelegramId: '324462035',
      }),
      /Invalid admin credentials/,
    );
  });

  it('creates a non-admin mobile player and returns the existing JWT format', async () => {
    const { jwt, ledger, repository, service } = createService();

    const result = await service.loginWithMobilePassword(mobileLoginInput());

    assert.equal(result.accessToken, 'signed-token');
    assert.equal(result.user.telegramId, 'android-mvp-player');
    assert.equal(result.user.username, 'player');
    assert.equal(result.user.firstName, 'Android MVP Player');
    assert.equal(result.user.isAdmin, false);
    assert.equal(repository.saveCalls, 1);
    assert.deepEqual(ledger.ensuredUserIds, [result.user.id]);
    assert.deepEqual(jwt.payloads.at(-1), {
      sub: result.user.id,
      telegramId: 'android-mvp-player',
      username: 'player',
      isAdmin: false,
    });
  });

  it('updates an existing non-admin mobile player without creating an admin token', async () => {
    const { jwt, ledger, repository, service } = createService();
    const created = await service.loginWithMobilePassword(mobileLoginInput());

    const result = await service.loginWithMobilePassword(mobileLoginInput({ displayName: 'Updated Player' }));

    assert.equal(result.user.id, created.user.id);
    assert.equal(result.user.firstName, 'Updated Player');
    assert.equal(result.user.isAdmin, false);
    assert.equal(repository.users.size, 1);
    assert.equal(repository.saveCalls, 2);
    assert.deepEqual(ledger.ensuredUserIds, [created.user.id, created.user.id]);
    assert.deepEqual(jwt.payloads.at(-1), {
      sub: created.user.id,
      telegramId: 'android-mvp-player',
      username: 'player',
      isAdmin: false,
    });
  });

  it('rejects invalid mobile password login attempts', async () => {
    const { service } = createService();

    await assert.rejects(
      () => service.loginWithMobilePassword(mobileLoginInput({ password: 'wrong' })),
      /Invalid mobile credentials/,
    );

    await assert.rejects(
      () => service.loginWithMobilePassword(mobileLoginInput({ username: 'other' })),
      /Invalid mobile credentials/,
    );
  });

  it('rejects mobile login if the configured mobile identity belongs to an admin', async () => {
    const { jwt, repository, service } = createService();
    const admin = await service.upsertTelegramUser(verifiedTelegramUser({ id: 777, username: 'admin_user' }));
    admin.isAdmin = true;

    await assert.rejects(
      () => service.loginWithMobilePassword(mobileLoginInput({ mobileTelegramId: '777' })),
      /Invalid mobile credentials/,
    );

    assert.equal(repository.saveCalls, 1);
    assert.deepEqual(jwt.payloads, []);
  });

  it('returns user profile with balance and real today stats', async () => {
    const { dailyStats, service } = createService();
    const user = await service.upsertTelegramUser(verifiedTelegramUser());
    const date = new Date().toISOString().slice(0, 10);
    dailyStats.stats.set(`${user.id}:${date}`, {
      userId: user.id,
      date,
      acceptedSteps: 304,
      earnedErt: 2,
      raffleAttempts: 1,
    } as DailyUserStats);

    const profile = await service.getUserProfile(user);

    assert.equal(profile.user.id, user.id);
    assert.equal(profile.balance.ertBalance, 0);
    assert.equal(profile.balance.lifetimeEarnedErt, 0);
    assert.equal(profile.balance.lifetimeSpentErt, 0);
    assert.equal(profile.balance.eruBalance, 12);
    assert.equal(profile.balance.eruBalanceExact, '12');
    assert.equal(profile.balance.lifetimeEarnedEruExact, '20');
    assert.equal(profile.balance.lifetimeSpentEruExact, '8');
    assert.deepEqual(profile.todayStats, {
      acceptedSteps: 304,
      earnedErt: 2,
      earnedErtExact: '2',
      earnedErtDisplay: '2.00',
      raffleAttempts: 1,
      stepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    });
    assert.equal(profile.balance.ertBalanceExact, '0');
    assert.equal(profile.balance.ertBalanceDisplay, '0.00');
  });

  it('returns zero today stats when no daily row exists', async () => {
    const { service } = createService();
    const user = await service.upsertTelegramUser(verifiedTelegramUser());

    const profile = await service.getUserProfile(user);

    assert.deepEqual(profile.todayStats, {
      acceptedSteps: 0,
      earnedErt: 0,
      earnedErtExact: '0',
      earnedErtDisplay: '0.00',
      raffleAttempts: 0,
      stepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    });
  });

  it('returns bounded owner activity rows in the repository order', async () => {
    const { dailyStats, service } = createService();
    const user = await service.upsertTelegramUser(verifiedTelegramUser());
    dailyStats.history = [
      { userId: user.id, date: '2026-08-14', acceptedSteps: 311, earnedErt: 2, raffleAttempts: 0 } as DailyUserStats,
      { userId: user.id, date: '2026-08-13', acceptedSteps: 407, earnedErt: 3, raffleAttempts: 1 } as DailyUserStats,
    ];

    const history = await service.getActivityHistory(user, '2026-08-01', '2026-08-14');

    assert.deepEqual(history, {
      from: '2026-08-01',
      to: '2026-08-14',
      days: [
        {
          date: '2026-08-14', acceptedSteps: 311, earnedErt: 2,
          earnedErtExact: '2', earnedErtDisplay: '2.00', raffleAttempts: 0,
          stepCap: 5000, rulesVersion: 'move-to-earn-earning-v1',
          balanceConfigVersion: 'move-to-earn-balance-v1',
        },
        {
          date: '2026-08-13', acceptedSteps: 407, earnedErt: 3,
          earnedErtExact: '3', earnedErtDisplay: '3.00', raffleAttempts: 1,
          stepCap: 5000, rulesVersion: 'move-to-earn-earning-v1',
          balanceConfigVersion: 'move-to-earn-balance-v1',
        },
      ],
    });
    assert.equal((dailyStats.findOptions as { where: { userId: string } }).where.userId, user.id);
  });

  it('rejects malformed, reversed, and oversized activity ranges', async () => {
    const { service } = createService();
    const user = { id: 'user-id' } as User;

    await assert.rejects(() => service.getActivityHistory(user, '2026-02-30', '2026-03-01'), /valid date/);
    await assert.rejects(() => service.getActivityHistory(user, '2026-08-14', '2026-08-13'), /1-31 days/);
    await assert.rejects(() => service.getActivityHistory(user, '2026-07-01', '2026-08-14'), /1-31 days/);
    await assert.rejects(() => service.getActivityHistory(user, undefined, '2026-08-14'), /YYYY-MM-DD/);
  });
});
