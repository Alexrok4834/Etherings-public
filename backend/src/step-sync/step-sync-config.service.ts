import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type StepSyncPolicy = {
  retentionSeconds: number;
  maxFutureSkewSeconds: number;
};

@Injectable()
export class StepSyncConfigService {
  constructor(private readonly configService: ConfigService) {}

  getPolicy(): StepSyncPolicy {
    return {
      retentionSeconds: this.positiveInteger('STEP_SYNC_RETENTION_SECONDS', 7 * 24 * 60 * 60),
      maxFutureSkewSeconds: this.positiveInteger('STEP_SYNC_MAX_FUTURE_SKEW_SECONDS', 10 * 60),
    };
  }

  now() {
    return new Date();
  }

  private positiveInteger(key: string, fallback: number) {
    const value = Number(this.configService.get<string | number>(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
}
