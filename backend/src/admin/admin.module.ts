import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { User } from '../auth/user.entity';
import { BalanceModule } from '../balance/balance.module';
import { RingModule } from '../ring/ring.module';
import { RaffleDraw } from '../raffle/raffle-draw.entity';
import { RafflePoolReward } from '../raffle/raffle-pool-reward.entity';
import { RafflePool } from '../raffle/raffle-pool.entity';
import { Reward } from '../raffle/reward.entity';
import { AdminAuditService } from './admin-audit.service';
import { AdminRafflePoolsService } from './admin-raffle-pools.service';
import { AdminRewardsService } from './admin-rewards.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminCopperRingsService } from './admin-copper-rings.service';
import { AdminRaffleV2Service } from './admin-raffle-v2.service';

@Module({
  imports: [AuthModule, BalanceModule, RingModule, TypeOrmModule.forFeature([Reward, RafflePool, RafflePoolReward, RaffleDraw, User])],
  controllers: [AdminController],
  providers: [
    AdminGuard,
    AdminRewardsService,
    AdminRafflePoolsService,
    AdminRaffleV2Service,
    AdminAuditService,
    AdminCopperRingsService,
  ],
})
export class AdminModule {}
