import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { createWriteRateLimitMiddleware } from './common/write-rate-limit.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = Number(config.get<string>('BACKEND_PORT') ?? 4000);

  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(createWriteRateLimitMiddleware({
    enabled: config.get<string>('RATE_LIMIT_ENABLED') !== 'false',
    windowMs: positiveInteger(config.get<string>('RATE_LIMIT_WRITE_WINDOW_MS'), 60_000),
    max: positiveInteger(config.get<string>('RATE_LIMIT_WRITE_MAX'), 120),
    registrationMax: positiveInteger(config.get<string>('RATE_LIMIT_REGISTRATION_MAX'), 5),
  }));

  await app.listen(port);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

void bootstrap();
