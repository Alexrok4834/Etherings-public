import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { canonicalErt, displayErt } from './ert-decimal';
import {
  M2eBalanceConfigService,
  M2E_EARNING_RULES_VERSION,
} from './m2e-balance-config.service';

export type ErtApiValue = {
  exact: string;
  display: string;
};

export type PlayerEconomySnapshot = {
  ertBalance: ErtApiValue;
  lifetimeEarnedErt: ErtApiValue;
  lifetimeSpentErt: ErtApiValue;
  earnedErtToday: ErtApiValue;
  dailyStepCap: number;
  rulesVersion: string;
  balanceConfigVersion: string;
};

export type ActivityEconomySnapshot = {
  date: string;
  earnedErt: ErtApiValue;
  dailyStepCap: number;
  rulesVersion: string;
  balanceConfigVersion: string;
};

type ProfileRow = {
  ertBalance: string;
  lifetimeEarnedErt: string;
  lifetimeSpentErt: string;
  earnedErtToday: string;
  dailyStepCap: number;
  rulesVersion: string;
  balanceConfigVersion: string;
};

type ActivityRow = {
  date: string;
  earnedErt: string;
  dailyStepCap: number;
  rulesVersion: string;
  balanceConfigVersion: string;
};

@Injectable()
export class M2ePlayerEconomyReadService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly balanceConfig: M2eBalanceConfigService,
  ) {}

  async getProfile(userId: string, accountingDate: string): Promise<PlayerEconomySnapshot> {
    const config = this.balanceConfig.getConfig();
    const rows = await this.dataSource.query(`
      SELECT b.ert_balance::text AS "ertBalance",
        b.lifetime_earned_ert::text AS "lifetimeEarnedErt",
        b.lifetime_spent_ert::text AS "lifetimeSpentErt",
        COALESCE(d.earned_ert, 0)::text AS "earnedErtToday",
        COALESCE(s.step_cap, $3)::integer AS "dailyStepCap",
        COALESCE(s.rules_version, $4)::text AS "rulesVersion",
        COALESCE(s.balance_config_version, $5)::text AS "balanceConfigVersion"
      FROM balances b
      LEFT JOIN daily_user_stats d ON d.user_id = b.user_id AND d.date = $2
      LEFT JOIN m2e_daily_economic_snapshots s ON s.user_id = b.user_id AND s.accounting_date = $2
      WHERE b.user_id = $1
    `, [userId, accountingDate, config.baseSteps, M2E_EARNING_RULES_VERSION, config.version]) as ProfileRow[];
    const row = rows[0];
    if (!row) throw new Error('Player economy balance is unavailable after initialization');

    return {
      ertBalance: this.ert(row.ertBalance),
      lifetimeEarnedErt: this.ert(row.lifetimeEarnedErt),
      lifetimeSpentErt: this.ert(row.lifetimeSpentErt),
      earnedErtToday: this.ert(row.earnedErtToday),
      dailyStepCap: Number(row.dailyStepCap),
      rulesVersion: row.rulesVersion,
      balanceConfigVersion: row.balanceConfigVersion,
    };
  }

  async getActivity(
    userId: string,
    from: string,
    to: string,
  ): Promise<Map<string, ActivityEconomySnapshot>> {
    const config = this.balanceConfig.getConfig();
    const rows = await this.dataSource.query(`
      SELECT d.date::text AS date, d.earned_ert::text AS "earnedErt",
        COALESCE(s.step_cap, $4)::integer AS "dailyStepCap",
        COALESCE(s.rules_version, $5)::text AS "rulesVersion",
        COALESCE(s.balance_config_version, $6)::text AS "balanceConfigVersion"
      FROM daily_user_stats d
      LEFT JOIN m2e_daily_economic_snapshots s
        ON s.user_id = d.user_id AND s.accounting_date = d.date
      WHERE d.user_id = $1 AND d.date BETWEEN $2 AND $3
    `, [userId, from, to, config.baseSteps, M2E_EARNING_RULES_VERSION, config.version]) as ActivityRow[];

    return new Map(rows.map((row) => [row.date, {
      date: row.date,
      earnedErt: this.ert(row.earnedErt),
      dailyStepCap: Number(row.dailyStepCap),
      rulesVersion: row.rulesVersion,
      balanceConfigVersion: row.balanceConfigVersion,
    }]));
  }

  private ert(value: string): ErtApiValue {
    const exact = canonicalErt(value);
    return { exact, display: displayErt(exact) };
  }
}
