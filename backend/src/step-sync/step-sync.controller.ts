import { Body, Controller, HttpCode, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from '../auth/jwt-auth.guard';
import { ReceiveStepSyncBatchInput, StepSyncService } from './step-sync.service';

@Controller('step-sync/batches')
@UseGuards(JwtAuthGuard)
export class StepSyncController {
  constructor(private readonly stepSyncService: StepSyncService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  receive(@Req() request: RequestWithUser, @Body() body: ReceiveStepSyncBatchInput) {
    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }
    return this.stepSyncService.receiveBatch(request.user, body);
  }
}
