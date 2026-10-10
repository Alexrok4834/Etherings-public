import { ConfigService } from '@nestjs/config';

type ConfigReader = Pick<ConfigService, 'get'>;

export function readJwtSecret(config: ConfigReader) {
  const secret = config.get<string>('JWT_SECRET') ?? 'change-me';

  if (isProduction(config) && secret === 'change-me') {
    throw new Error('JWT_SECRET must be set to a non-default value in production');
  }

  return secret;
}

export function readTypeOrmSynchronize(config: ConfigReader) {
  const synchronize = config.get<string>('TYPEORM_SYNCHRONIZE') === 'true';

  if (isProduction(config) && synchronize) {
    throw new Error('TYPEORM_SYNCHRONIZE must be disabled in production');
  }

  return synchronize;
}

function isProduction(config: ConfigReader) {
  return config.get<string>('NODE_ENV') === 'production';
}