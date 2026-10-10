import { Body, Controller, Get, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { toRaffleV2HttpException } from './raffle-v2-api-errors';
import { RaffleV2DrawCoreService } from './raffle-v2-draw-core.service';
import { RaffleV2ReadService } from './raffle-v2-read.service';

@Controller('raffle/v2')
@UseGuards(JwtAuthGuard)
export class RaffleV2Controller {
  constructor(
    private readonly reads: RaffleV2ReadService,
    private readonly draws: RaffleV2DrawCoreService,
  ) {}

  @Get('draw')
  async getDraw(@Req() request: RequestWithUser) {
    const ownerUserId = requireOwner(request);
    try {
      return await this.reads.getCurrent(ownerUserId);
    } catch (error) {
      throw toRaffleV2HttpException(error);
    }
  }

  @Get('history')
  async getHistory(@Req() request: RequestWithUser, @Query() query: unknown) {
    const ownerUserId = requireOwner(request);
    try {
      return await this.reads.getHistory(ownerUserId, query);
    } catch (error) {
      throw toRaffleV2HttpException(error);
    }
  }

  @Post('draw')
  async draw(@Req() request: RequestWithUser, @Body() body: unknown) {
    const ownerUserId = requireOwner(request);
    try {
      return await this.draws.execute(ownerUserId, body);
    } catch (error) {
      throw toRaffleV2HttpException(error);
    }
  }
}

function requireOwner(request: RequestWithUser) {
  if (!request.user) throw new UnauthorizedException('User is missing from request');
  return request.user.id;
}
