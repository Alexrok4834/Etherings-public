import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { BalanceModule } from '../balance/balance.module';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { RingModule } from '../ring/ring.module';
import { RaffleController } from './raffle.controller';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleConfiguration } from './raffle-configuration.entity';
import { RaffleDraw } from './raffle-draw.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleRingAward } from './raffle-ring-award.entity';
import { RafflePoolReward } from './raffle-pool-reward.entity';
import { RafflePool } from './raffle-pool.entity';
import { RaffleSelectionService } from './raffle-selection.service';
import { RaffleService } from './raffle.service';
import { Reward } from './reward.entity';
import { UserReward } from './user-reward.entity';
import { RaffleCopperAwardRepository } from './raffle-copper-award.repository';
import { RaffleCopperAwardService } from './raffle-copper-award.service';
import { RaffleV2CryptoRandomIntegerService } from './raffle-v2-crypto-random-integer.service';
import { RaffleV2DrawCoreService } from './raffle-v2-draw-core.service';
import { RAFFLE_V2_DRAW_REPOSITORY, RaffleV2DrawRepository } from './raffle-v2-draw.repository';
import { RAFFLE_V2_FULFILLMENT_PORT } from './raffle-v2-fulfillment.port';
import { RaffleV2FulfillmentRepository } from './raffle-v2-fulfillment.repository';
import { RaffleV2FulfillmentService } from './raffle-v2-fulfillment.service';
import { RaffleV2IntegerSelectionService } from './raffle-v2-integer-selection.service';
import { RAFFLE_V2_RANDOM_INTEGER_PORT } from './raffle-v2-random-integer.port';
import { RAFFLE_V2_READ_REPOSITORY, RaffleV2ReadRepository } from './raffle-v2-read.repository';
import { RaffleV2ReadService } from './raffle-v2-read.service';
import { RaffleV2Controller } from './raffle-v2.controller';
import { RaffleV2LegacyCompatibilityService } from './raffle-v2-legacy-compatibility.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Reward,
      RafflePool,
      RafflePoolReward,
      RaffleDraw,
      UserReward,
      RaffleMachine,
      RaffleConfiguration,
      RaffleConfigurationReward,
      RaffleDrawOperation,
      RaffleDrawResultV2,
      RaffleRingAward,
      DailyUserStats,
    ]),
    AuthModule,
    BalanceModule,
    RingModule,
  ],
  controllers: [RaffleController, RaffleV2Controller],
  providers: [
    RaffleService,
    RaffleSelectionService,
    RaffleV2DrawRepository,
    { provide: RAFFLE_V2_DRAW_REPOSITORY, useExisting: RaffleV2DrawRepository },
    RaffleV2CryptoRandomIntegerService,
    { provide: RAFFLE_V2_RANDOM_INTEGER_PORT, useExisting: RaffleV2CryptoRandomIntegerService },
    RaffleV2IntegerSelectionService,
    RaffleCopperAwardRepository,
    RaffleCopperAwardService,
    RaffleV2FulfillmentRepository,
    RaffleV2FulfillmentService,
    { provide: RAFFLE_V2_FULFILLMENT_PORT, useExisting: RaffleV2FulfillmentService },
    RaffleV2DrawCoreService,
    RaffleV2ReadRepository,
    { provide: RAFFLE_V2_READ_REPOSITORY, useExisting: RaffleV2ReadRepository },
    RaffleV2ReadService,
    RaffleV2LegacyCompatibilityService,
  ],
  exports: [TypeOrmModule, RaffleService, RaffleSelectionService],
})
export class RaffleModule {}
