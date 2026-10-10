import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CreateRaffleV2AvailabilityOperationSchema1788134400000 } from './1788134400000-create-raffle-v2-availability-operation-schema';

class Runner {
  statements: string[] = [];
  async query(sql: string) {
    this.statements.push(sql);
    if (sql.includes('SELECT count(*)::text')) return [{ count: '0' }];
    return [];
  }
}

describe('Raffle v2 availability operation migration', () => {
  it('adds guarded singleton availability and immutable audit operations', async () => {
    const runner = new Runner();
    await new CreateRaffleV2AvailabilityOperationSchema1788134400000().up(runner as never);
    const sql = runner.statements.join('\n');
    assert.match(sql, /"is_available" boolean NOT NULL DEFAULT true/);
    assert.match(sql, /raffle_v2_protect_machine_v2/);
    assert.match(sql, /raffle_machine_availability_operations/);
    assert.match(sql, /"action" = 'PAUSE'.*"action" = 'RESUME'/s);
    assert.match(sql, /BEFORE UPDATE OR DELETE/);
  });
});
