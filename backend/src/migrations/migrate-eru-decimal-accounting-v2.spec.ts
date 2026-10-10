import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MigrateEruDecimalAccountingV21788307200000 } from './1788307200000-migrate-eru-decimal-accounting-v2';

class Runner {
  statements: string[] = [];
  async query(sql: string) {
    this.statements.push(sql);
    return [];
  }
}

describe('ERU decimal accounting v2 migration', () => {
  it('widens all six columns and replaces only integer-specific checks', async () => {
    const runner = new Runner();
    await new MigrateEruDecimalAccountingV21788307200000().up(runner as never);
    const sql = runner.statements.join('\n');

    for (const column of ['eru_balance', 'lifetime_earned_eru', 'lifetime_spent_eru',
      'amount_exact', 'eru_balance_after']) {
      assert.match(sql, new RegExp(`ALTER COLUMN "${column}" TYPE numeric\\(48,18\\)`));
    }
    assert.match(sql, /DROP CONSTRAINT "CHK_ledger_eru_integer_values"/);
    assert.match(sql, /ADD CONSTRAINT "CHK_ledger_eru_decimal_values"/);
    assert.match(sql, /value exceeds numeric\(48,18\)/);
    assert.doesNotMatch(sql, /UPDATE\s+/i);
  });

  it('fails downgrade for fractional columns, ledger rows, and immutable evidence', async () => {
    const runner = new Runner();
    await new MigrateEruDecimalAccountingV21788307200000().down(runner as never);
    const sql = runner.statements.join('\n');

    assert.match(sql, /cannot downgrade ERU decimal accounting after fractional evidence exists/);
    assert.match(sql, /"currency" = 'ERU'/);
    assert.match(sql, /copper_level_up_operations/);
    assert.match(sql, /raffle_draws/);
    assert.match(sql, /raffle_configuration_rewards/);
    assert.match(sql, /raffle_draw_operations/);
    assert.match(sql, /jsonb_path_exists/);
    assert.match(sql, /ERRCODE = '23514'/);
    assert.match(sql, /TYPE numeric\(48,0\)/);
    assert.match(sql, /TYPE numeric\(30,0\)/);
    assert.doesNotMatch(sql, /DELETE\s+FROM|UPDATE\s+/i);
  });
});
