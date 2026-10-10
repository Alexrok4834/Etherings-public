import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProtectActiveRaffleV2Rewards1787961600000 } from './1787961600000-protect-active-raffle-v2-rewards';

class RecordingQueryRunner {
  readonly statements: string[] = [];
  async query(statement: string) { this.statements.push(statement); }
}

describe('ProtectActiveRaffleV2Rewards migration', () => {
  it('installs a trigger that protects active reward identity while allowing stock consumption', async () => {
    const runner = new RecordingQueryRunner();
    await new ProtectActiveRaffleV2Rewards1787961600000().up(runner as never);
    const sql = runner.statements.join('\n');

    assert.match(sql, /configuration\."status" = 'ACTIVE'/);
    assert.match(sql, /NEW\."amount_exact" IS DISTINCT FROM OLD\."amount_exact"/);
    assert.match(sql, /NEW\."is_active" IS DISTINCT FROM OLD\."is_active"/);
    assert.match(sql, /NEW\."stock_remaining" > OLD\."stock_remaining"/);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "rewards"/);
  });

  it('removes the trigger before its function', async () => {
    const runner = new RecordingQueryRunner();
    await new ProtectActiveRaffleV2Rewards1787961600000().down(runner as never);

    assert.match(runner.statements[0], /DROP TRIGGER/);
    assert.match(runner.statements[1], /DROP FUNCTION/);
  });
});
