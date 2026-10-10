import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BalanceModule } from './balance/balance.module';
import { HealthController } from './health.controller';
import { RaffleModule } from './raffle/raffle.module';
import { RingModule } from './ring/ring.module';
import { WalkModule } from './walk/walk.module';
import { readTypeOrmSynchronize } from './config/security-config';
import { StepSyncModule } from './step-sync/step-sync.module';
import { M2eModule } from './m2e/m2e.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: readTypeOrmSynchronize(config),
      }),
    }),
    AuthModule,
    AdminModule,
    BalanceModule,
    WalkModule,
    RaffleModule,
    RingModule,
    StepSyncModule,
    M2eModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
