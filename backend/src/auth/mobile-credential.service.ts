import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readMobileAuthAccounts } from './mobile-auth-config';
import { MobileCredential } from './mobile-credential.entity';
import { MobileSessionService } from './mobile-session.service';
import { PasswordHasherService } from './password-hasher.service';
import { User } from './user.entity';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

@Injectable()
export class MobileCredentialService {
  constructor(
    @InjectRepository(MobileCredential)
    private readonly credentialRepository: Repository<MobileCredential>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly mobileSessionService: MobileSessionService,
  ) {}

  async authenticate(username: string, password: string): Promise<User | null> {
    const credential = await this.credentialRepository.findOne({ where: { username } });
    if (!credential) return null;

    if (!await this.passwordHasher.verify(password, credential.passwordHash)) {
      this.invalidCredentials();
    }

    const user = await this.userRepository.findOne({ where: { id: credential.userId } });
    if (!user || user.isAdmin) this.invalidCredentials();
    user.lastLoginAt = new Date();
    return this.userRepository.save(user);
  }

  async bootstrap(user: User, username: string, password: string) {
    const existing = await this.credentialRepository.findOne({ where: { userId: user.id } });
    if (existing) return existing;

    const credential = this.credentialRepository.create({
      userId: user.id,
      username,
      passwordHash: await this.passwordHasher.hash(password),
      passwordChangedAt: null,
    });
    return this.credentialRepository.save(credential);
  }

  async updateDisplayName(user: User, value: unknown) {
    if (typeof value !== 'string') this.invalidDisplayName();
    const displayName = value.trim();
    if (displayName.length < 1 || displayName.length > 64 || CONTROL_CHARACTER_PATTERN.test(displayName)) {
      this.invalidDisplayName();
    }

    user.firstName = displayName;
    user.lastName = null;
    return this.userRepository.save(user);
  }

  async changePassword(user: User, currentPassword: unknown, newPassword: unknown) {
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      this.invalidPasswordInput();
    }
    if (newPassword.length < 8 || newPassword.length > 128 || CONTROL_CHARACTER_PATTERN.test(newPassword)) {
      this.invalidPasswordInput();
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException({ message: 'New password must be different', code: 'PASSWORD_UNCHANGED' });
    }

    let credential = await this.credentialRepository.findOne({ where: { userId: user.id } });
    if (!credential) {
      const account = this.readLegacyAccount(user);
      if (!account || !this.passwordHasher.verifyLegacy(currentPassword, account.password)) this.invalidCurrentPassword();
      credential = await this.bootstrap(user, account.username, currentPassword);
    } else if (!await this.passwordHasher.verify(currentPassword, credential.passwordHash)) {
      this.invalidCurrentPassword();
    }

    credential.passwordHash = await this.passwordHasher.hash(newPassword);
    credential.passwordChangedAt = new Date();
    await this.credentialRepository.save(credential);
    await this.mobileSessionService.revokeAllForUser(user.id, 'PASSWORD_CHANGED');

    return { reauthenticationRequired: true as const };
  }

  private readLegacyAccount(user: User) {
    try {
      return readMobileAuthAccounts(this.configService).find((account) => account.telegramId === user.telegramId) ?? null;
    } catch {
      return null;
    }
  }

  private invalidCredentials(): never {
    throw new UnauthorizedException('Invalid mobile credentials');
  }

  private invalidCurrentPassword(): never {
    throw new ForbiddenException({ message: 'Current password is invalid', code: 'INVALID_CURRENT_PASSWORD' });
  }

  private invalidDisplayName(): never {
    throw new BadRequestException({ message: 'Display name must contain 1-64 valid characters', code: 'INVALID_DISPLAY_NAME' });
  }

  private invalidPasswordInput(): never {
    throw new BadRequestException({ message: 'New password must contain 8-128 valid characters', code: 'INVALID_NEW_PASSWORD' });
  }
}
