import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { MobileSessionConfigService } from './mobile-session-config.service';

function service(values: Record<string, string | undefined>) {
  return new MobileSessionConfigService({
    get: (key: string) => values[key],
  } as ConfigService);
}

describe('MobileSessionConfigService', () => {
  it('accepts HTTPS production transport and a bounded TTL', () => {
    const config = service({
      NODE_ENV: 'production',
      PUBLIC_API_URL: 'https://api.etherings.xyz',
      MOBILE_REFRESH_TOKEN_TTL_DAYS: '45',
    });
    assert.doesNotThrow(() => config.assertSecureRefreshTransport());
    assert.equal(config.refreshTokenTtlSeconds, 45 * 86_400);
  });

  it('fails closed for missing, invalid, or cleartext production URLs', () => {
    assert.throws(() => service({ NODE_ENV: 'production' }).assertSecureRefreshTransport(), /PUBLIC_API_URL/);
    assert.throws(
      () => service({ NODE_ENV: 'production', PUBLIC_API_URL: 'not-a-url' }).assertSecureRefreshTransport(),
      /absolute URL/,
    );
    assert.throws(
      () => service({ NODE_ENV: 'production', PUBLIC_API_URL: 'http:\/\/192.0.2.20' }).assertSecureRefreshTransport(),
      /HTTPS/,
    );
  });

  it('allows cleartext only for local development integration', () => {
    assert.doesNotThrow(() => service({ NODE_ENV: 'development', PUBLIC_API_URL: 'http:\/\/localhost:4000' }).assertSecureRefreshTransport());
    assert.throws(
      () => service({ NODE_ENV: 'development', PUBLIC_API_URL: 'http:\/\/192.0.2.10:4000' }).assertSecureRefreshTransport(),
      /HTTPS/,
    );
    assert.equal(service({ MOBILE_REFRESH_TOKEN_TTL_DAYS: '0' }).refreshTokenTtlSeconds, 30 * 86_400);
  });
});
