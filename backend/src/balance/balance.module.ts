import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './balance.entity';
import { LedgerTransaction } from './ledger-transaction.entity';
import { LedgerService } from './ledger.service';
import { EruLedgerService } from './eru-ledger.service';
import { EruBalanceReadService } from './eru-balance-read.service';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, LedgerTransaction])],
  providers: [LedgerService, EruLedgerService, EruBalanceReadService],
  exports: [TypeOrmModule, LedgerService, EruLedgerService, EruBalanceReadService],
})
export class BalanceModule {}
