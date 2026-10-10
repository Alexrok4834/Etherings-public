import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { LedgerService } from '../balance/ledger.service';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { TelegramInitDataService, TelegramInitDataUser, VerifiedTelegramInitData } from './telegram-init-data.service';
import { User } from './user.entity';
import { M2ePlayerEconomyReadService } from '../m2e/m2e-player-economy-read.service';
import { EruBalanceReadService } from '../balance/eru-balance-read.service';

export type AuthTokenPayload = {
  sub: string;
  telegramId: string;
  username: string | null;
  isAdmin: boolean;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(DailyUserStats)
    private readonly dailyUserStatsRepository: Repository<DailyUserStats>,
    private readonly telegramInitDataService: TelegramInitDataService,
    private readonly jwtService: JwtService,
    private readonly ledgerService: LedgerService,
    private readonly playerEconomy: M2ePlayerEconomyReadService,
    private readonly eruBalanceRead: EruBalanceReadService,
  ) {}

  async loginWithTelegram(initData: string, botToken: string) {
    const verified = this.telegramInitDataService.verify(initData, botToken);
    const user = await this.upsertTelegramUser(verified);

    return {
      accessToken: await this.signUserToken(user),
      user,
    };
  }

  async loginWithAdminPassword(input: {
    username: string;
    password: string;
    expectedUsername: string;
    expectedPassword: string;
    adminTelegramId: string;
  }) {
    if (!this.safeEqual(input.username, input.expectedUsername) || !this.safeEqual(input.password, input.expectedPassword)) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    const user = await this.userRepository.findOne({ where: { telegramId: input.adminTelegramId } });

    if (!user?.isAdmin) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return {
      accessToken: await this.signUserToken(user),
      user,
    };
  }

  async loginWithMobilePassword(input: {
    username: string;
    password: string;
    expectedUsername: string;
    expectedPassword: string;
    mobileTelegramId: string;
    displayName: string | null;
  }) {
    if (!this.safeEqual(input.username, input.expectedUsername) || !this.safeEqual(input.password, input.expectedPassword)) {
      throw new UnauthorizedException('Invalid mobile credentials');
    }

    const user = await this.upsertMobileUser({
      telegramId: input.mobileTelegramId,
      username: input.expectedUsername,
      displayName: input.displayName,
    });

    if (user.isAdmin) {
      throw new UnauthorizedException('Invalid mobile credentials');
    }

    return {
      accessToken: await this.signUserToken(user),
      user,
    };
  }

  async upsertTelegramUser(verified: VerifiedTelegramInitData) {
    const telegramUser = verified.user;
    const telegramId = String(telegramUser.id);
    const existingUser = await this.userRepository.findOne({ where: { telegramId } });
    const now = new Date();

    if (!existingUser) {
      const user = this.userRepository.create({
        telegramId,
        ...this.mapTelegramUser(telegramUser),
        isAdmin: false,
        lastLoginAt: now,
      });
      const savedUser = await this.userRepository.save(user);
      await this.ledgerService.ensureBalance(savedUser.id);

      return savedUser;
    }

    Object.assign(existingUser, {
      ...this.mapTelegramUser(telegramUser),
      lastLoginAt: now,
    });

    return this.userRepository.save(existingUser);
  }

  async findUserById(id: string) {
    return this.userRepository.findOne({ where: { id } });
  }

  async getUserProfile(user: User) {
    const balance = await this.ledgerService.ensureBalance(user.id);
    const eru = this.eruBalanceRead.toValues(balance);
    const accountingDate = new Date().toISOString().slice(0, 10);
    const [todayStats, economy] = await Promise.all([
      this.dailyUserStatsRepository.findOne({
        where: { userId: user.id, date: accountingDate },
      }),
      this.playerEconomy.getProfile(user.id, accountingDate),
    ]);

    return {
      user,
      balance: {
        ertBalance: balance.ertBalance,
        ertBalanceExact: economy.ertBalance.exact,
        ertBalanceDisplay: economy.ertBalance.display,
        lifetimeEarnedErt: balance.lifetimeEarnedErt,
        lifetimeEarnedErtExact: economy.lifetimeEarnedErt.exact,
        lifetimeEarnedErtDisplay: economy.lifetimeEarnedErt.display,
        lifetimeSpentErt: balance.lifetimeSpentErt,
        lifetimeSpentErtExact: economy.lifetimeSpentErt.exact,
        lifetimeSpentErtDisplay: economy.lifetimeSpentErt.display,
        ...eru,
        updatedAt: balance.updatedAt,
      },
      todayStats: {
        acceptedSteps: todayStats?.acceptedSteps ?? 0,
        earnedErt: todayStats?.earnedErt ?? 0,
        earnedErtExact: economy.earnedErtToday.exact,
        earnedErtDisplay: economy.earnedErtToday.display,
        raffleAttempts: todayStats?.raffleAttempts ?? 0,
        stepCap: economy.dailyStepCap,
        rulesVersion: economy.rulesVersion,
        balanceConfigVersion: economy.balanceConfigVersion,
      },
    };
  }

  async getActivityHistory(user: User, fromValue: unknown, toValue: unknown) {
    const from = this.activityDate(fromValue, 'from');
    const to = this.activityDate(toValue, 'to');
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    if (days < 1 || days > 31) {
      throw new BadRequestException({ message: 'Activity range must contain 1-31 days', code: 'INVALID_ACTIVITY_RANGE' });
    }

    const [rows, economyByDate] = await Promise.all([
      this.dailyUserStatsRepository.find({
        where: { userId: user.id, date: Between(from, to) },
        order: { date: 'DESC' },
      }),
      this.playerEconomy.getActivity(user.id, from, to),
    ]);
    return {
      from,
      to,
      days: rows.map((row) => {
        const economy = economyByDate.get(row.date);
        if (!economy) throw new Error(`Exact activity economy is unavailable for ${row.date}`);
        return {
          date: row.date,
          acceptedSteps: row.acceptedSteps,
          earnedErt: row.earnedErt,
          earnedErtExact: economy.earnedErt.exact,
          earnedErtDisplay: economy.earnedErt.display,
          raffleAttempts: row.raffleAttempts,
          stepCap: economy.dailyStepCap,
          rulesVersion: economy.rulesVersion,
          balanceConfigVersion: economy.balanceConfigVersion,
        };
      }),
    };
  }

  async verifyAccessToken(token: string) {
    try {
      const payload = await this.jwtService.verifyAsync<AuthTokenPayload>(token);
      const user = await this.findUserById(payload.sub);

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid access token');
    }
  }

  private safeEqual(actual: string, expected: string) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);

    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private activityDate(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException({ message: `${field} must be YYYY-MM-DD`, code: 'INVALID_ACTIVITY_DATE' });
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException({ message: `${field} must be a valid date`, code: 'INVALID_ACTIVITY_DATE' });
    }
    return value;
  }

  signUserToken(user: User) {
    const payload: AuthTokenPayload = {
      sub: user.id,
      telegramId: user.telegramId,
      username: user.username,
      isAdmin: user.isAdmin,
    };

    return this.jwtService.signAsync(payload);
  }

  private async upsertMobileUser(input: {
    telegramId: string;
    username: string;
    displayName: string | null;
  }) {
    const existingUser = await this.userRepository.findOne({ where: { telegramId: input.telegramId } });
    const now = new Date();

    if (!existingUser) {
      const user = this.userRepository.create({
        telegramId: input.telegramId,
        username: input.username,
        firstName: input.displayName,
        lastName: null,
        photoUrl: null,
        isAdmin: false,
        lastLoginAt: now,
      });
      const savedUser = await this.userRepository.save(user);
      await this.ledgerService.ensureBalance(savedUser.id);

      return savedUser;
    }

    if (existingUser.isAdmin) {
      return existingUser;
    }

    Object.assign(existingUser, {
      username: input.username,
      firstName: input.displayName,
      lastName: null,
      photoUrl: null,
      lastLoginAt: now,
    });

    const savedUser = await this.userRepository.save(existingUser);
    await this.ledgerService.ensureBalance(savedUser.id);

    return savedUser;
  }

  private mapTelegramUser(telegramUser: TelegramInitDataUser) {
    return {
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      photoUrl: telegramUser.photo_url ?? null,
    };
  }
}
