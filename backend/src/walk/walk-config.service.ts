import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type WalkLimits = {
  dailyStepLimitBase: number;
  ertPer1000Steps: number;
  minSessionSeconds: number;
  maxAcceptedSpeedMps: number;
  maxSessionDurationSeconds: number;
};

const defaults: WalkLimits = {
  dailyStepLimitBase: 5000,
  ertPer1000Steps: 10,
  minSessionSeconds: 30,
  maxAcceptedSpeedMps: 3.5,
  maxSessionDurationSeconds: 604800,
};

@Injectable()
export class WalkConfigService {
  constructor(private readonly configService: ConfigService) {}

  getLimits(): WalkLimits {
    return {
      dailyStepLimitBase: this.getNumber('WALK_DAILY_STEP_LIMIT_BASE', defaults.dailyStepLimitBase),
      ertPer1000Steps: this.getNumber('WALK_ERT_PER_1000_STEPS', defaults.ertPer1000Steps),
      minSessionSeconds: this.getNumber('WALK_MIN_SESSION_SECONDS', defaults.minSessionSeconds),
      maxAcceptedSpeedMps: this.getNumber('WALK_MAX_ACCEPTED_SPEED_MPS', defaults.maxAcceptedSpeedMps),
      maxSessionDurationSeconds: this.getNumber('WALK_MAX_SESSION_DURATION_SECONDS', defaults.maxSessionDurationSeconds),
    };
  }

  getMaxFutureSkewSeconds() {
    const value = Number(this.configService.get<string | number>('STEP_SYNC_MAX_FUTURE_SKEW_SECONDS'));
    return Number.isSafeInteger(value) && value > 0 ? value : 10 * 60;
  }

  private getNumber(key: string, fallback: number) {
    const rawValue = this.configService.get<string | number>(key);

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return fallback;
    }

    const value = Number(rawValue);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
