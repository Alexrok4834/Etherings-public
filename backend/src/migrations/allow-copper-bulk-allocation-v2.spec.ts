import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AllowCopperBulkAllocationV21788220800000 } from './1788220800000-allow-copper-bulk-allocation-v2';

class Runner {
  statements: string[] = [];
  async query(sql: string) {
    this.statements.push(sql);
    return [];
  }
}

describe('Copper bulk allocation v2 migration', () => {
  it('allows immutable v1 and v2 operation evidence on upgrade', async () => {
    const runner = new Runner();
    await new AllowCopperBulkAllocationV21788220800000().up(runner as never);
    const sql = runner.statements.join('\n');
    assert.match(sql, /DROP CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"/);
    assert.match(sql, /rules_version" IN \(/);
    assert.match(sql, /copper-attribute-allocation-v1/);
    assert.match(sql, /copper-attribute-allocation-v2/);
    assert.doesNotMatch(sql, /UPDATE\s+"copper_attribute_allocation_operations"/i);
  });

  it('guards downgrade before restoring the v1-only constraint', async () => {
    const runner = new Runner();
    await new AllowCopperBulkAllocationV21788220800000().down(runner as never);
    const sql = runner.statements.join('\n');
    assert.match(sql, /IF EXISTS[\s\S]*rules_version" = 'copper-attribute-allocation-v2'/);
    assert.match(sql, /ERRCODE = '23514'/);
    assert.match(sql, /rules_version" = 'copper-attribute-allocation-v1'/);
    assert.doesNotMatch(sql, /DELETE\s+FROM/i);
  });
});
