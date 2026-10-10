import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { BalanceModule } from '../balance/balance.module';
import { DailyUserStats } from './daily-user-stats.entity';
import { WalkConfigService } from './walk-config.service';
import { WalkController } from './walk.controller';
import { WalkSession } from './walk-session.entity';
import { WalkService } from './walk.service';

@Module({
  imports: [TypeOrmModule.forFeature([WalkSession, DailyUserStats]), AuthModule, BalanceModule],
  controllers: [WalkController],
  providers: [WalkConfigService, WalkService],
  exports: [TypeOrmModule, WalkConfigService, WalkService],
})
export class WalkModule {}