import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CopperRingEntitlementService } from './copper-ring-entitlement.service';
import { CopperLevelUpPreviewService } from './copper-level-up-preview.service';
import { CopperLevelUpService } from './copper-level-up.service';
import { CopperLevelUpOperation } from './copper-level-up-operation.entity';
import { CopperAttributeAllocationOperation } from './copper-attribute-allocation-operation.entity';
import { CopperAttributeAllocationService } from './copper-attribute-allocation.service';
import { BalanceModule } from '../balance/balance.module';
import { CopperRingInventoryService } from './copper-ring-inventory.service';
import { CopperRingRandomService } from './copper-ring-random.service';
import { CopperRingRepository } from './copper-ring.repository';
import { EquippedRing } from './equipped-ring.entity';
import { GameRing } from './game-ring.entity';
import { RingEvent } from './ring-event.entity';
import { RingEquipmentOperation } from './ring-equipment-operation.entity';
import { RingEquipmentService } from './ring-equipment.service';
import { RingController } from './ring.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GameRing,
      EquippedRing,
      RingEvent,
      CopperLevelUpOperation,
      CopperAttributeAllocationOperation,
      RingEquipmentOperation,
    ]),
    forwardRef(() => AuthModule),
    BalanceModule,
  ],
  controllers: [RingController],
  providers: [
    CopperRingRepository,
    CopperRingRandomService,
    CopperRingEntitlementService,
    CopperRingInventoryService,
    CopperLevelUpPreviewService,
    CopperLevelUpService,
    CopperAttributeAllocationService,
    RingEquipmentService,
  ],
  exports: [CopperRingEntitlementService, CopperRingRepository, CopperRingRandomService],
})
export class RingModule {}
