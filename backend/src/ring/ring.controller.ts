import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { CopperLevelUpPreviewService } from './copper-level-up-preview.service';
import { CopperLevelUpService } from './copper-level-up.service';
import { CopperAttributeAllocationService } from './copper-attribute-allocation.service';
import { CopperRingInventoryService } from './copper-ring-inventory.service';
import { RingEquipmentService } from './ring-equipment.service';

@Controller('me/rings')
@UseGuards(JwtAuthGuard)
export class RingController {
  constructor(
    private readonly inventory: CopperRingInventoryService,
    private readonly levelUpPreview: CopperLevelUpPreviewService,
    private readonly levelUp: CopperLevelUpService,
    private readonly attributeAllocation: CopperAttributeAllocationService,
    private readonly equipment: RingEquipmentService,
  ) {}

  @Get()
  list(@Req() request: RequestWithUser) {
    return this.inventory.listForOwner(this.requireUser(request));
  }

  @Get('equipped')
  equipped(@Req() request: RequestWithUser) {
    return this.inventory.getEquippedForOwner(this.requireUser(request));
  }

  @Get(':ringId')
  detail(
    @Req() request: RequestWithUser,
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
  ) {
    return this.inventory.getForOwner(this.requireUser(request), ringId);
  }

  @Post(':ringId/level-up/preview')
  previewLevelUp(
    @Req() request: RequestWithUser,
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
    @Body() body: unknown,
  ) {
    return this.levelUpPreview.preview(this.requireUser(request), ringId, body);
  }

  @Post(':ringId/level-up')
  performLevelUp(
    @Req() request: RequestWithUser,
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
    @Body() body: unknown,
  ) {
    return this.levelUp.levelUp(this.requireUser(request), ringId, body);
  }

  @Post(':ringId/attribute-points/allocate')
  allocateAttributePoints(
    @Req() request: RequestWithUser,
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
    @Body() body: unknown,
  ) {
    return this.attributeAllocation.allocate(this.requireUser(request), ringId, body);
  }

  @Post(':ringId/equip')
  equipRing(
    @Req() request: RequestWithUser,
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
    @Body() body: unknown,
  ) {
    return this.equipment.equip(this.requireUser(request), ringId, body);
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) throw new UnauthorizedException('User is missing from request');
    return request.user;
  }
}
