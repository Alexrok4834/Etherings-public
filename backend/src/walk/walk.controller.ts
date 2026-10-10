import { Body, Controller, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { FinishWalkSessionInput, StartWalkSessionInput, WalkService } from './walk.service';

@Controller('walk/sessions')
@UseGuards(JwtAuthGuard)
export class WalkController {
  constructor(private readonly walkService: WalkService) {}

  @Post('start')
  start(@Req() request: RequestWithUser, @Body() body: StartWalkSessionInput) {
    const user = this.getRequestUser(request);
    return this.walkService.startSession(user, body);
  }

  @Post(':id/finish')
  finish(
    @Req() request: RequestWithUser,
    @Param('id') sessionId: string,
    @Body() body: FinishWalkSessionInput,
  ) {
    const user = this.getRequestUser(request);
    return this.walkService.finishSession(user, sessionId, body);
  }

  @Get()
  list(@Req() request: RequestWithUser) {
    const user = this.getRequestUser(request);
    return this.walkService.listSessions(user);
  }

  private getRequestUser(request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }

    return request.user;
  }
}
