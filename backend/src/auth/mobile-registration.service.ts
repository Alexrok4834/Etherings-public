import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { Balance } from '../balance/balance.entity';
import { CopperRingEntitlementService } from '../ring/copper-ring-entitlement.service';
import { CopperIssuanceReason } from '../ring/game-ring.entity';
import { MobileCredential } from './mobile-credential.entity';
import { PasswordHasherService } from './password-hasher.service';
import { User } from './user.entity';

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

@Injectable()
export class MobileRegistrationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly passwordHasher: PasswordHasherService,
    private readonly copperEntitlementService: CopperRingEntitlementService,
  ) {}

  async register(input: { username: unknown; password: unknown; displayName: unknown }) {
    const username = this.validateUsername(input.username);
    const password = this.validatePassword(input.password);
    const displayName = this.validateDisplayName(input.displayName);
    const passwordHash = await this.passwordHasher.hash(password);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const existing = await manager.createQueryBuilder(MobileCredential, 'credential')
          .where('LOWER(credential.username) = :username', { username })
          .getOne();
        if (existing) this.usernameTaken();

        const user = await manager.save(manager.create(User, {
          telegramId: `mobile:${randomUUID()}`,
          username,
          firstName: displayName,
          lastName: null,
          photoUrl: null,
          isAdmin: false,
          lastLoginAt: new Date(),
        }));
        await manager.save(manager.create(MobileCredential, {
          userId: user.id,
          username,
          passwordHash,
          passwordChangedAt: null,
        }));
        await manager.save(manager.create(Balance, {
          userId: user.id,
          ertBalance: 0,
          lifetimeEarnedErt: 0,
          lifetimeSpentErt: 0,
        }));
        await this.copperEntitlementService.ensureStarterCopperInTransaction(
          manager,
          user.id,
          CopperIssuanceReason.Registration,
        );
        return user;
      });
    } catch (error) {
      if (error instanceof ConflictException || this.isUniqueViolation(error)) this.usernameTaken();
      throw error;
    }
  }

  private validateUsername(value: unknown) {
    const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new BadRequestException({
        message: 'Username must contain 3-32 lowercase letters, digits, or underscores',
        code: 'INVALID_REGISTRATION_USERNAME',
      });
    }
    return username;
  }

  private validatePassword(value: unknown) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || CONTROL_CHARACTER_PATTERN.test(value)) {
      throw new BadRequestException({
        message: 'Password must contain 8-128 valid characters',
        code: 'INVALID_REGISTRATION_PASSWORD',
      });
    }
    return value;
  }

  private validateDisplayName(value: unknown) {
    const displayName = typeof value === 'string' ? value.trim() : '';
    if (!displayName || displayName.length > 64 || CONTROL_CHARACTER_PATTERN.test(displayName)) {
      throw new BadRequestException({
        message: 'Display name must contain 1-64 valid characters',
        code: 'INVALID_REGISTRATION_DISPLAY_NAME',
      });
    }
    return displayName;
  }

  private isUniqueViolation(error: unknown) {
    return error instanceof QueryFailedError
      && (error as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505';
  }

  private usernameTaken(): never {
    throw new ConflictException({ message: 'Username is already registered', code: 'USERNAME_TAKEN' });
  }
}
