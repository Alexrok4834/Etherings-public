import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { StepSyncInstallation, StepSyncInstallationStatus } from '../step-sync/step-sync-installation.entity';
import { User } from './user.entity';
import { AuthService } from './auth.service';
import { MobileRefreshToken, MobileRefreshTokenStatus } from './mobile-refresh-token.entity';
import { MobileSessionConfigService } from './mobile-session-config.service';

type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

@Injectable()
export class MobileSessionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly config: MobileSessionConfigService,
  ) {}

  async issue(user: User, installationId: string): Promise<SessionTokens> {
    this.config.assertSecureRefreshTransport();
    const rawToken = this.generateToken();
    const expiresAt = this.expiresAt();

    await this.dataSource.transaction(async (manager) => {
      const lockedUser = await manager.findOne(User, {
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedUser) this.invalidToken();
      const installation = await this.findOrCreateInstallation(manager, user.id, installationId);
      const previousTokens = await manager.find(MobileRefreshToken, {
        where: {
          userId: user.id,
          installationRecordId: installation.id,
          status: MobileRefreshTokenStatus.Active,
        },
      });
      for (const familyId of new Set(previousTokens.map((token) => token.familyId))) {
        await this.revokeFamily(manager, familyId, 'REAUTHENTICATED');
      }
      const token = manager.create(MobileRefreshToken, {
        familyId: randomUUID(),
        userId: user.id,
        installationRecordId: installation.id,
        tokenHash: this.hashToken(rawToken),
        parentTokenId: null,
        replacedByTokenId: null,
        status: MobileRefreshTokenStatus.Active,
        expiresAt,
        consumedAt: null,
        revokedAt: null,
        revocationReason: null,
      });
      await manager.save(token);
    });

    return this.response(user, rawToken, expiresAt);
  }

  async refresh(refreshToken: string, installationId: string): Promise<SessionTokens> {
    this.config.assertSecureRefreshTransport();
    const replacementRawToken = this.generateToken();

    const result = await this.dataSource.transaction(async (manager): Promise<
      { user: User; expiresAt: Date; errorCode?: never } | { errorCode: string; user?: never; expiresAt?: never }
    > => {
      const candidate = await manager.findOne(MobileRefreshToken, {
        where: { tokenHash: this.hashToken(refreshToken) },
      });
      if (!candidate) this.invalidToken();
      const user = await manager.findOne(User, {
        where: { id: candidate.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) this.invalidToken();
      const token = await manager.findOne(MobileRefreshToken, {
        where: { tokenHash: this.hashToken(refreshToken) },
        lock: { mode: 'pessimistic_write' },
      });

      if (!token) this.invalidToken();

      if (token.status !== MobileRefreshTokenStatus.Active) {
        await this.revokeFamily(manager, token.familyId, 'REPLAY_DETECTED');
        return { errorCode: 'REFRESH_TOKEN_REPLAYED' };
      }

      const installation = await manager.findOne(StepSyncInstallation, {
        where: { id: token.installationRecordId, userId: token.userId },
        lock: { mode: 'pessimistic_read' },
      });

      if (!installation || installation.installationId !== installationId || installation.status !== StepSyncInstallationStatus.Active) {
        await this.revokeFamily(manager, token.familyId, 'INSTALLATION_MISMATCH');
        return { errorCode: 'REFRESH_TOKEN_INSTALLATION_MISMATCH' };
      }

      const now = new Date();
      if (token.expiresAt.getTime() <= now.getTime()) {
        await this.revokeFamily(manager, token.familyId, 'EXPIRED');
        return { errorCode: 'REFRESH_TOKEN_EXPIRED' };
      }

      const expiresAt = this.expiresAt(now);
      const replacement = manager.create(MobileRefreshToken, {
        id: randomUUID(),
        familyId: token.familyId,
        userId: token.userId,
        installationRecordId: token.installationRecordId,
        tokenHash: this.hashToken(replacementRawToken),
        parentTokenId: token.id,
        replacedByTokenId: null,
        status: MobileRefreshTokenStatus.Active,
        expiresAt,
        consumedAt: null,
        revokedAt: null,
        revocationReason: null,
      });

      token.status = MobileRefreshTokenStatus.Rotated;
      token.consumedAt = now;
      token.replacedByTokenId = replacement.id;
      await manager.save(token);
      await manager.save(replacement);

      return { user, expiresAt };
    });

    if ('errorCode' in result) this.invalidToken(result.errorCode);
    return this.response(result.user, replacementRawToken, result.expiresAt);
  }

  async logout(refreshToken: string) {
    this.config.assertSecureRefreshTransport();
    await this.dataSource.transaction(async (manager) => {
      const token = await manager.findOne(MobileRefreshToken, {
        where: { tokenHash: this.hashToken(refreshToken) },
        lock: { mode: 'pessimistic_write' },
      });
      if (token) await this.revokeFamily(manager, token.familyId, 'LOGOUT');
    });
  }

  async revokeAllForUser(userId: string, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new Error('User is unavailable for session revocation');
      const now = new Date();
      await manager.createQueryBuilder()
        .update(MobileRefreshToken)
        .set({ status: MobileRefreshTokenStatus.Revoked, revokedAt: now, revocationReason: reason })
        .where('user_id = :userId', { userId })
        .andWhere('status != :status', { status: MobileRefreshTokenStatus.Revoked })
        .execute();
    });
  }

  private async findOrCreateInstallation(manager: EntityManager, userId: string, installationId: string) {
    const existing = await manager.findOne(StepSyncInstallation, { where: { userId, installationId } });
    if (existing) {
      if (existing.status !== StepSyncInstallationStatus.Active) {
        throw new ConflictException({ message: 'Installation is revoked', code: 'INSTALLATION_REVOKED' });
      }
      existing.lastSeenAt = new Date();
      return manager.save(existing);
    }

    return manager.save(manager.create(StepSyncInstallation, {
      userId,
      installationId,
      status: StepSyncInstallationStatus.Active,
      lastSeenAt: new Date(),
      revokedAt: null,
    }));
  }

  private async revokeFamily(manager: EntityManager, familyId: string, reason: string) {
    const now = new Date();
    await manager.createQueryBuilder()
      .update(MobileRefreshToken)
      .set({ status: MobileRefreshTokenStatus.Revoked, revokedAt: now, revocationReason: reason })
      .where('family_id = :familyId', { familyId })
      .execute();
  }

  private async response(user: User, refreshToken: string, expiresAt: Date): Promise<SessionTokens> {
    return {
      accessToken: await this.authService.signUserToken(user),
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
  }

  private generateToken() {
    return randomBytes(32).toString('base64url');
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private expiresAt(now = new Date()) {
    return new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000);
  }

  private invalidToken(code = 'INVALID_REFRESH_TOKEN'): never {
    throw new UnauthorizedException({ message: 'Invalid refresh token', code });
  }
}
