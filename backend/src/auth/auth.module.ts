import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceModule } from '../balance/balance.module';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TelegramInitDataService } from './telegram-init-data.service';
import { User } from './user.entity';
import { readJwtSecret } from '../config/security-config';
import { StepSyncInstallation } from '../step-sync/step-sync-installation.entity';
import { MobileRefreshToken } from './mobile-refresh-token.entity';
import { MobileSessionConfigService } from './mobile-session-config.service';
import { MobileSessionService } from './mobile-session.service';
import { MobileCredential } from './mobile-credential.entity';
import { MobileCredentialService } from './mobile-credential.service';
import { PasswordHasherService } from './password-hasher.service';
import { MobileRegistrationService } from './mobile-registration.service';
import { RingModule } from '../ring/ring.module';
import { M2eModule } from '../m2e/m2e.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([User, DailyUserStats, StepSyncInstallation, MobileRefreshToken, MobileCredential]),
    BalanceModule,
    forwardRef(() => RingModule),
    forwardRef(() => M2eModule),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: readJwtSecret(config),
        signOptions: { expiresIn: '24h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TelegramInitDataService,
    JwtAuthGuard,
    MobileSessionConfigService,
    MobileSessionService,
    MobileCredentialService,
    PasswordHasherService,
    MobileRegistrationService,
  ],
  exports: [AuthService, TelegramInitDataService, JwtAuthGuard],
})
export class AuthModule {}
