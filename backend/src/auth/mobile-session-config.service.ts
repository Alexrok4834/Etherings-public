import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MobileSessionConfigService {
  constructor(private readonly config: ConfigService) {}

  get refreshTokenTtlSeconds() {
    const days = Number(this.config.get<string>('MOBILE_REFRESH_TOKEN_TTL_DAYS') ?? '30');
    return Number.isInteger(days) && days >= 1 && days <= 365 ? days * 86_400 : 30 * 86_400;
  }

  assertSecureRefreshTransport() {
    const rawUrl = this.config.get<string>('PUBLIC_API_URL')?.trim();
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';

    if (!rawUrl) {
      if (nodeEnv === 'production') {
        throw new Error('PUBLIC_API_URL is required to issue mobile refresh tokens in production');
      }
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('PUBLIC_API_URL must be an absolute URL');
    }

    const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2';
    if (url.protocol !== 'https:' && !(nodeEnv !== 'production' && localHost)) {
      throw new Error('Mobile refresh tokens require a public HTTPS API URL');
    }
  }
}
