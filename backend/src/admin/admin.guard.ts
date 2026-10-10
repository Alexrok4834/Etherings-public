import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { RequestWithUser } from '../auth/jwt-auth.guard';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }

    if (!request.user.isAdmin) {
      throw new ForbiddenException('Admin access is required');
    }

    return true;
  }
}