import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Balance } from './balance.entity';
import { canonicalEru, displayEru, eruCompatibilityNumber } from './eru-decimal';

export type EruBalanceValues = {
  eruBalance: number | null;
  eruBalanceExact: string;
  eruBalanceDisplay: string;
  lifetimeEarnedEru: number | null;
  lifetimeEarnedEruExact: string;
  lifetimeEarnedEruDisplay: string;
  lifetimeSpentEru: number | null;
  lifetimeSpentEruExact: string;
  lifetimeSpentEruDisplay: string;
};

@Injectable()
export class EruBalanceReadService {
  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async getRequired(userId: string) {
    const [balance] = await this.dataSource.query(`
      SELECT user_id AS "userId", eru_balance::text AS "eruBalance",
        lifetime_earned_eru::text AS "lifetimeEarnedEru",
        lifetime_spent_eru::text AS "lifetimeSpentEru", updated_at AS "updatedAt"
      FROM balances WHERE user_id = $1
    `, [userId]) as Balance[];
    if (!balance) throw new NotFoundException('Balance not found');
    return {
      userId: balance.userId,
      ...this.toValues(balance),
      updatedAt: balance.updatedAt,
    };
  }

  toValues(balance: Pick<Balance, 'eruBalance' | 'lifetimeEarnedEru' | 'lifetimeSpentEru'>): EruBalanceValues {
    const eruBalanceExact = canonicalEru(balance.eruBalance, 'eruBalance');
    const lifetimeEarnedEruExact = canonicalEru(balance.lifetimeEarnedEru, 'lifetimeEarnedEru');
    const lifetimeSpentEruExact = canonicalEru(balance.lifetimeSpentEru, 'lifetimeSpentEru');
    return {
      eruBalance: eruCompatibilityNumber(eruBalanceExact),
      eruBalanceExact,
      eruBalanceDisplay: displayEru(eruBalanceExact),
      lifetimeEarnedEru: eruCompatibilityNumber(lifetimeEarnedEruExact),
      lifetimeEarnedEruExact,
      lifetimeEarnedEruDisplay: displayEru(lifetimeEarnedEruExact),
      lifetimeSpentEru: eruCompatibilityNumber(lifetimeSpentEruExact),
      lifetimeSpentEruExact,
      lifetimeSpentEruDisplay: displayEru(lifetimeSpentEruExact),
    };
  }
}
