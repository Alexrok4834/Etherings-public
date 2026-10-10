import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RingModule } from '../ring/ring.module';
import { BalanceModule } from '../balance/balance.module';
import { M2eBalanceConfigService } from './m2e-balance-config.service';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';
import { M2eDailySnapshotService } from './m2e-daily-snapshot.service';
import { M2eEarningCalculator } from './m2e-earning-calculator';
import { M2eSettlementService } from './m2e-settlement.service';
import { M2eActivationConfigService } from './m2e-activation-config.service';
import { M2ePlayerEconomyReadService } from './m2e-player-economy-read.service';

@Module({
  imports: [TypeOrmModule.forFeature([M2eDailyEconomicSnapshot]), RingModule, BalanceModule],
  providers: [
    M2eBalanceConfigService,
    M2eEarningCalculator,
    M2eDailySnapshotService,
    M2eSettlementService,
    M2eActivationConfigService,
    M2ePlayerEconomyReadService,
  ],
  exports: [
    M2eBalanceConfigService,
    M2eEarningCalculator,
    M2eDailySnapshotService,
    M2eSettlementService,
    M2eActivationConfigService,
    M2ePlayerEconomyReadService,
  ],
})
export class M2eModule {}
