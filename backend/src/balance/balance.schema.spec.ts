import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { Balance } from './balance.entity';
import { LedgerCurrency, LedgerTransaction, LedgerTransactionType } from './ledger-transaction.entity';

function tableFor(target: Function) {
  return getMetadataArgsStorage().tables.find((table) => table.target === target);
}

function columnsFor(target: Function) {
  return getMetadataArgsStorage().columns.filter((column) => column.target === target);
}

describe('balance ledger schema', () => {
  it('maps Balance to balances with distinct exact decimal ERU counters', () => {
    assert.equal(tableFor(Balance)?.name, 'balances');

    const columns = columnsFor(Balance);
    const databaseNames = columns.map((column) => column.options.name ?? column.propertyName);

    assert.deepEqual(databaseNames.sort(), [
      'ert_balance',
      'eru_balance',
      'lifetime_earned_ert',
      'lifetime_earned_eru',
      'lifetime_spent_ert',
      'lifetime_spent_eru',
      'updated_at',
      'user_id',
    ].sort());

    for (const name of ['eru_balance', 'lifetime_earned_eru', 'lifetime_spent_eru']) {
      const column = columns.find((candidate) => (candidate.options.name ?? candidate.propertyName) === name);
      assert.equal(column?.options.precision, 48);
      assert.equal(column?.options.scale, 18);
      assert.equal(column?.options.default, 0);
    }
  });

  it('keeps the shared ledger decimal and applies the ERU decimal check', () => {
    const columns = columnsFor(LedgerTransaction);
    for (const name of ['amount', 'balance_after']) {
      const column = columns.find((candidate) => (candidate.options.name ?? candidate.propertyName) === name);
      assert.equal(column?.options.precision, 48);
      assert.equal(column?.options.scale, 18);
    }
    const checks = getMetadataArgsStorage().checks.filter((check) => check.target === LedgerTransaction);
    assert.ok(checks.some((check) => check.name === 'CHK_ledger_eru_decimal_values'
      && String(check.expression).includes('"amount" <> 0')));
    assert.ok(!checks.some((check) => check.name === 'CHK_ledger_eru_integer_values'));
  });

  it('maps LedgerTransaction to ledger_transactions with required fields', () => {
    assert.equal(tableFor(LedgerTransaction)?.name, 'ledger_transactions');

    const columns = columnsFor(LedgerTransaction);
    const databaseNames = columns.map((column) => column.options.name ?? column.propertyName);

    assert.deepEqual(databaseNames.sort(), [
      'amount',
      'balance_after',
      'created_at',
      'currency',
      'id',
      'metadata',
      'reference_id',
      'reference_type',
      'type',
      'user_id',
    ].sort());
  });

  it('defines separate ERT and ERU ledger currencies with ERT compatibility default', () => {
    assert.deepEqual(Object.values(LedgerCurrency).sort(), ['ERT', 'ERU']);
    const currency = columnsFor(LedgerTransaction)
      .find((column) => (column.options.name ?? column.propertyName) === 'currency');
    assert.equal(currency?.options.default, LedgerCurrency.Ert);
    assert.equal(currency?.options.enumName, 'ledger_currency_enum');

    const indices = getMetadataArgsStorage().indices.filter((index) => index.target === LedgerTransaction);
    for (const name of [
      'UQ_ledger_copper_level_up_reference',
      'UQ_ledger_eru_raffle_reward_reference',
    ]) {
      const index = indices.find((candidate) => candidate.name === name);
      assert.equal(index?.unique, true, name);
      assert.deepEqual(index?.columns, ['currency', 'referenceType', 'referenceId'], name);
    }
  });

  it('defines all MVP ledger transaction types', () => {
    assert.deepEqual(Object.values(LedgerTransactionType).sort(), [
      'ADMIN_ADJUSTMENT',
      'COPPER_LEVEL_UP_SPEND',
      'RAFFLE_REFUND',
      'RAFFLE_REWARD',
      'RAFFLE_SPEND',
      'WALK_REWARD',
    ].sort());
  });
});
