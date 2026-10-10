import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CreateRaffleV2ActivationOperationSchema1788048000000 } from './1788048000000-create-raffle-v2-activation-operation-schema';

class RecordingQueryRunner {
  readonly statements: string[] = [];
  count = '0';
  async query(statement: string) {
    this.statements.push(statement);
    if (statement.includes('SELECT count(*)::text')) return [{ count: this.count }];
    return [];
  }
}

describe('Raffle v2 activation operation migration', () => {
  it('creates immutable admin/idempotency audit evidence with configuration references', async () => {
    const runner = new RecordingQueryRunner();
    await new CreateRaffleV2ActivationOperationSchema1788048000000().up(runner as never);
    const sql = runner.statements.join('\n');

    assert.match(sql, /raffle_configuration_activation_operations/);
    assert.match(sql, /UNIQUE \("admin_user_id", "idempotency_key"\)/);
    assert.match(sql, /"expected_active_configuration_id" uuid/);
    assert.match(sql, /OLD\."status" = 'COMPLETED'/);
    assert.match(sql, /PENDING.*COMPLETED/s);
  });

  it('refuses to remove persisted activation history', async () => {
    const runner = new RecordingQueryRunner();
    runner.count = '1';
    await assert.rejects(
      () => new CreateRaffleV2ActivationOperationSchema1788048000000().down(runner as never),
      /Cannot remove Raffle v2 activation audit history/,
    );
    assert.equal(runner.statements.length, 1);
  });
});
