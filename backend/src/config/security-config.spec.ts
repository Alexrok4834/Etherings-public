import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readJwtSecret, readTypeOrmSynchronize } from './security-config';

function config(values: Record<string, string | undefined>) {
  return {
    get<T extends string>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  };
}

describe('security config helpers', () => {
  it('keeps local MVP defaults available outside production', () => {
    assert.equal(readJwtSecret(config({})), 'change-me');
    assert.equal(readTypeOrmSynchronize(config({ TYPEORM_SYNCHRONIZE: 'true' })), true);
  });

  it('requires a non-default JWT secret in production', () => {
    assert.throws(
      () => readJwtSecret(config({ NODE_ENV: 'production', JWT_SECRET: 'change-me' })),
      /JWT_SECRET must be set/,
    );

    assert.equal(readJwtSecret(config({ NODE_ENV: 'production', JWT_SECRET: 'prod-secret' })), 'prod-secret');
  });

  it('blocks TypeORM synchronize in production', () => {
    assert.throws(
      () => readTypeOrmSynchronize(config({ NODE_ENV: 'production', TYPEORM_SYNCHRONIZE: 'true' })),
      /TYPEORM_SYNCHRONIZE must be disabled/,
    );

    assert.equal(readTypeOrmSynchronize(config({ NODE_ENV: 'production', TYPEORM_SYNCHRONIZE: 'false' })), false);
  });
});