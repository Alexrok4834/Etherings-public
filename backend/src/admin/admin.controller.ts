import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { AdminAuditService, AdminBalanceAdjustmentInput } from './admin-audit.service';
import { AdminGuard } from './admin.guard';
import { AdminCopperRingsService } from './admin-copper-rings.service';
import { AdminRafflePoolsService } from './admin-raffle-pools.service';
import { AdminRewardsService } from './admin-rewards.service';
import { EruBalanceReadService } from '../balance/eru-balance-read.service';
import { AdminRaffleV2Service } from './admin-raffle-v2.service';
import { legacyRaffleAdminWriteRetired } from './admin-legacy-write.errors';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminRewardsService: AdminRewardsService,
    private readonly adminRafflePoolsService: AdminRafflePoolsService,
    private readonly adminAuditService: AdminAuditService,
    private readonly adminCopperRingsService: AdminCopperRingsService,
    private readonly eruBalanceReadService: EruBalanceReadService,
    private readonly adminRaffleV2Service: AdminRaffleV2Service,
  ) {}

  @Get('status')
  status() {
    return { status: 'ok' };
  }

  @Get('rewards')
  listRewards() {
    return this.adminRewardsService.listRewards();
  }

  @Post('rewards')
  createReward() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Patch('rewards/:id')
  updateReward() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Delete('rewards/:id')
  softDisableReward() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Get('raffle-draws')
  listRaffleDraws() {
    return this.adminAuditService.listRaffleDraws();
  }

  @Get('raffle-v2')
  getRaffleV2Overview() {
    return this.adminRaffleV2Service.overview();
  }

  @Get('raffle-v2/draws')
  listRaffleV2Draws(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.adminRaffleV2Service.draws({ limit, offset });
  }

  @Post('raffle-v2/rewards')
  createRaffleV2Reward(@Body() body: unknown) {
    return this.adminRaffleV2Service.createReward(body);
  }

  @Post('raffle-v2/configurations')
  createRaffleV2Draft(@Req() request: RequestWithUser, @Body() body: unknown) {
    return this.adminRaffleV2Service.createDraft(this.adminId(request), body);
  }

  @Patch('raffle-v2/configurations/:configurationId')
  updateRaffleV2Draft(
    @Param('configurationId', new ParseUUIDPipe({ version: '4' })) configurationId: string,
    @Body() body: unknown,
  ) {
    return this.adminRaffleV2Service.updateDraft(configurationId, body);
  }

  @Put('raffle-v2/configurations/:configurationId/rewards')
  replaceRaffleV2DraftRewards(
    @Param('configurationId', new ParseUUIDPipe({ version: '4' })) configurationId: string,
    @Body() body: unknown,
  ) {
    return this.adminRaffleV2Service.replaceDraftRewards(configurationId, body);
  }

  @Get('raffle-v2/configurations/:configurationId/preview')
  previewRaffleV2Draft(
    @Param('configurationId', new ParseUUIDPipe({ version: '4' })) configurationId: string,
  ) {
    return this.adminRaffleV2Service.previewDraft(configurationId);
  }

  @Post('raffle-v2/configurations/:configurationId/activate')
  activateRaffleV2Draft(
    @Req() request: RequestWithUser,
    @Param('configurationId', new ParseUUIDPipe({ version: '4' })) configurationId: string,
    @Body() body: unknown,
  ) {
    return this.adminRaffleV2Service.activateDraft(this.adminId(request), configurationId, body);
  }

  @Post('raffle-v2/pause')
  pauseRaffleV2(@Req() request: RequestWithUser, @Body() body: unknown) {
    return this.adminRaffleV2Service.setAvailability(this.adminId(request), 'PAUSE', body);
  }

  @Post('raffle-v2/resume')
  resumeRaffleV2(@Req() request: RequestWithUser, @Body() body: unknown) {
    return this.adminRaffleV2Service.setAvailability(this.adminId(request), 'RESUME', body);
  }

  @Get('rings')
  listRings(
    @Query('q') query: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.adminCopperRingsService.list({ query, limit, offset });
  }

  @Get('rings/:ringId/events')
  listRingEvents(
    @Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.adminCopperRingsService.events(ringId, { limit, offset });
  }

  @Get('rings/:ringId')
  getRing(@Param('ringId', new ParseUUIDPipe({ version: '4' })) ringId: string) {
    return this.adminCopperRingsService.detail(ringId);
  }

  @Post('balances/adjust')
  adjustBalance(@Body() body: AdminBalanceAdjustmentInput) {
    return this.adminAuditService.adjustBalance(body);
  }
  @Get('raffle-pools')
  listRafflePools() {
    return this.adminRafflePoolsService.listPools();
  }

  @Get('balances/:userId/eru')
  getEruBalance(@Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string) {
    return this.eruBalanceReadService.getRequired(userId);
  }

  @Post('raffle-pools')
  createRafflePool() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Patch('raffle-pools/:id')
  updateRafflePool() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Post('raffle-pools/:poolId/rewards')
  attachReward() {
    throw legacyRaffleAdminWriteRetired();
  }

  @Get('raffle-pools/:poolId/probabilities')
  getRafflePoolProbabilities(@Param('poolId') poolId: string) {
    return this.adminRafflePoolsService.getPoolProbabilities(poolId);
  }

  @Patch('raffle-pools/:poolId/rewards/:poolRewardId')
  updatePoolReward() {
    throw legacyRaffleAdminWriteRetired();
  }

  private adminId(request: RequestWithUser) {
    if (!request.user) throw new UnauthorizedException('User is missing from request');
    return request.user.id;
  }
}
