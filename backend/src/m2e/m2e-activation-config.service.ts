import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class M2eActivationConfigService {
  private readonly earningEnabled: boolean;
  private readonly activationScope: 'DISABLED' | 'CANARY' | 'GLOBAL';
  private readonly canaryUserIds: ReadonlySet<string>;
  private readonly globalStartDate: string | null;

  constructor(config: ConfigService) {
    const raw = config.get<string>('M2E_EARNING_ENABLED');
    if (raw === undefined || raw === 'false') {
      this.earningEnabled = false;
      this.activationScope = 'DISABLED';
      this.canaryUserIds = new Set();
      this.globalStartDate = null;
      return;
    }
    if (raw === 'true') {
      this.earningEnabled = true;
      this.activationScope = this.parseActivationScope(config.get<string>('M2E_EARNING_SCOPE'));
      const rawCanaryUserIds = config.get<string>('M2E_CANARY_USER_IDS');
      if (this.activationScope === 'GLOBAL') {
        if (rawCanaryUserIds !== undefined && rawCanaryUserIds !== '') {
          throw new Error('M2E_CANARY_USER_IDS must be empty when M2E_EARNING_SCOPE is GLOBAL');
        }
        this.canaryUserIds = new Set();
        this.globalStartDate = this.parseGlobalStartDate(config.get<string>('M2E_GLOBAL_START_DATE'));
      } else {
        const rawGlobalStartDate = config.get<string>('M2E_GLOBAL_START_DATE');
        if (rawGlobalStartDate !== undefined && rawGlobalStartDate !== '') {
          throw new Error('M2E_GLOBAL_START_DATE must be empty when M2E_EARNING_SCOPE is CANARY');
        }
        this.canaryUserIds = this.parseCanaryUserIds(rawCanaryUserIds);
        this.globalStartDate = null;
      }
      return;
    }
    throw new Error('M2E_EARNING_ENABLED must be exactly true or false');
  }

  isEarningEnabledForUser(userId: string, accountingDate: string) {
    return this.earningEnabled
      && (
        (this.activationScope === 'GLOBAL' && accountingDate >= (this.globalStartDate as string))
        || (this.activationScope === 'CANARY' && this.canaryUserIds.has(userId))
      );
  }

  private parseActivationScope(raw: string | undefined): 'CANARY' | 'GLOBAL' {
    if (raw === 'CANARY' || raw === 'GLOBAL') return raw;
    throw new Error('M2E_EARNING_SCOPE must be exactly CANARY or GLOBAL when M2E earning is enabled');
  }

  private parseGlobalStartDate(raw: string | undefined): string {
    if (!raw || !CANONICAL_DATE_PATTERN.test(raw)) {
      throw new Error('M2E_GLOBAL_START_DATE must be a canonical YYYY-MM-DD date in GLOBAL scope');
    }
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      throw new Error('M2E_GLOBAL_START_DATE must be a valid calendar date in GLOBAL scope');
    }
    return raw;
  }

  private parseCanaryUserIds(raw: string | undefined): ReadonlySet<string> {
    if (raw === undefined || raw === '') {
      throw new Error('M2E_CANARY_USER_IDS must contain at least one canonical UUID when M2E earning is enabled');
    }

    const values = raw.split(',');
    if (values.some((value) => !CANONICAL_UUID_PATTERN.test(value))) {
      throw new Error('M2E_CANARY_USER_IDS must be a comma-separated list of canonical lowercase UUIDs without whitespace');
    }

    const uniqueValues = new Set(values);
    if (uniqueValues.size !== values.length) {
      throw new Error('M2E_CANARY_USER_IDS must not contain duplicate UUIDs');
    }
    return uniqueValues;
  }
}
