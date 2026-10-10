import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User } from './user.entity';

export type RequestWithUser = {
  headers: Record<string, string | string[] | undefined>;
  user?: User;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request.headers.authorization);
    request.user = await this.authService.verifyAccessToken(token);

    return true;
  }

  private extractBearerToken(authorization: string | string[] | undefined) {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;

    if (!value) {
      throw new UnauthorizedException('Authorization header is missing');
    }

    const [scheme, token] = value.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Bearer token is missing');
    }

    return token;
  }
}
