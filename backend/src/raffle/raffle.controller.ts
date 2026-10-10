import { Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { RaffleV2LegacyCompatibilityService } from './raffle-v2-legacy-compatibility.service';
import { legacyRafflePlayerDrawRetired } from './raffle-legacy-write.errors';

@Controller('raffle')
export class RaffleController {
  constructor(private readonly compatibility: RaffleV2LegacyCompatibilityService) {}

  @Get('pools')
  listPools() {
    return this.compatibility.listPools();
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  history(@Req() request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }

    return this.compatibility.listHistory(request.user);
  }

  @Post('pools/:poolId/draw')
  @UseGuards(JwtAuthGuard)
  draw(@Req() request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }

    throw legacyRafflePlayerDrawRetired();
  }
}
