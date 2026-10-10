import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { Balance } from '../balance/balance.entity';
import { LedgerTransaction } from '../balance/ledger-transaction.entity';
import { StepSyncBatch } from '../step-sync/step-sync-batch.entity';
import { DailyUserStats } from '../walk/daily-user-stats.entity';
import { WalkSession } from '../walk/walk-session.entity';
import { M2eDailyEconomicSnapshot } from './m2e-daily-economic-snapshot.entity';

describe('M2E daily economic snapshot schema', () => {
  it('maps immutable economic inputs and owner/date identity', () => {
    const metadata = getMetadataArgsStorage();
    const table = metadata.tables.find((entry) => entry.target === M2eDailyEconomicSnapshot);
    const columns = metadata.columns
      .filter((column) => column.target === M2eDailyEconomicSnapshot)
      .map((column) => column.options.name ?? column.propertyName);

    assert.equal(table?.name, 'm2e_daily_economic_snapshots');
    assert.deepEqual(columns.sort(), [
      'accounting_date',
      'balance_config_version',
      'base_ert_per_1000_steps',
      'base_steps',
      'comfort_curve_k',
      'created_at',
      'extra_steps_per_ring',
      'id',
      'ring_count',
      'rules_version',
      'selected_ring_comfort',
      'selected_ring_id',
      'step_cap',
      'user_id',
    ].sort());
    assert.ok(metadata.indices.find((index) => index.target === M2eDailyEconomicSnapshot
      && index.name === 'UQ_m2e_daily_snapshot_owner_date'
      && index.unique));
    assert.ok(metadata.indices.find((index) => index.target === M2eDailyEconomicSnapshot
      && index.name === 'UQ_m2e_daily_snapshot_id_owner'
      && index.unique));
  });

  it('keeps the base ERT rate as numeric(48,18) string data', () => {
    const column = getMetadataArgsStorage().columns.find(
      (entry) => entry.target === M2eDailyEconomicSnapshot
        && (entry.options.name ?? entry.propertyName) === 'base_ert_per_1000_steps',
    );

    assert.equal(column?.options.type, 'numeric');
    assert.equal(column?.options.precision, 48);
    assert.equal(column?.options.scale, 18);
  });

  it('maps every authoritative ERT persistence column to numeric(48,18)', () => {
    const expected = [
      [Balance, 'ert_balance'],
      [Balance, 'lifetime_earned_ert'],
      [Balance, 'lifetime_spent_ert'],
      [LedgerTransaction, 'amount'],
      [LedgerTransaction, 'balance_after'],
      [DailyUserStats, 'earned_ert'],
      [StepSyncBatch, 'earned_ert_delta'],
      [WalkSession, 'earned_ert'],
    ] as const;
    const columns = getMetadataArgsStorage().columns;

    for (const [target, name] of expected) {
      const column = columns.find((entry) => entry.target === target
        && (entry.options.name ?? entry.propertyName) === name);
      assert.equal(column?.options.type, 'numeric', name);
      assert.equal(column?.options.precision, 48, name);
      assert.equal(column?.options.scale, 18, name);
    }
  });
});
