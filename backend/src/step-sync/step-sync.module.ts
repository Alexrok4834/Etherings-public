import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { BalanceModule } from '../balance/balance.module';
import { WalkModule } from '../walk/walk.module';
import { M2eModule } from '../m2e/m2e.module';
import { StepSyncBatch } from './step-sync-batch.entity';
import { StepSyncConfigService } from './step-sync-config.service';
import { StepSyncController } from './step-sync.controller';
import { StepSyncInstallation } from './step-sync-installation.entity';
import { StepSyncService } from './step-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StepSyncInstallation, StepSyncBatch]),
    AuthModule,
    BalanceModule,
    WalkModule,
    M2eModule,
  ],
  controllers: [StepSyncController],
  providers: [StepSyncConfigService, StepSyncService],
  exports: [TypeOrmModule, StepSyncService],
})
export class StepSyncModule {}
