import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { LedgerTransaction, LedgerTransactionType } from '../src/balance/ledger-transaction.entity';
import { LedgerService } from '../src/balance/ledger.service';
import { EruLedgerService } from '../src/balance/eru-ledger.service';
import { canonicalErt } from '../src/m2e/ert-decimal';
import { CopperLevelUpErrorCode } from '../src/ring/copper-level-up-errors';
import { CopperLevelUpOperation } from '../src/ring/copper-level-up-operation.entity';
import { CopperLevelUpService } from '../src/ring/copper-level-up.service';
import { CopperLevelUpPreviewService } from '../src/ring/copper-level-up-preview.service';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { GameRing } from '../src/ring/game-ring.entity';
import { RingEvent } from '../src/ring/ring-event.entity';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, Balance, LedgerTransaction, GameRing, RingEvent, CopperLevelUpOperation],
});
const repository = new CopperRingRepository(dataSource);
const service = new CopperLevelUpService(
  repository,
  new LedgerService(dataSource),
  new EruLedgerService(dataSource),
);
const previewService = new CopperLevelUpPreviewService(repository);

type Fixture = { user: User; ringId: string };

async function main() {
  await dataSource.initialize();
  try {
    await assertSchemaReady();
    const primary = await seedFixture(1000, 1);

    const key1 = randomUUID();
    const firstRequest = levelRequest(1, 2, key1);
    const first = await service.levelUp(primary.user, primary.ringId, firstRequest);
    const repeated = await service.levelUp(primary.user, primary.ringId, firstRequest);
    assert.deepEqual(repeated, first);
    await assertPrimaryState(primary, { level: 2, unspent: 4, ert: 988, spent: 12, ledger: 1, events: 1, operations: 1 });

    await assert.rejects(
      service.levelUp(primary.user, primary.ringId,
        levelRequest(2, 3, key1)),
      (error) => codeOf(error) === CopperLevelUpErrorCode.IdempotencyConflict,
    );

    const differentKeyRace = await Promise.allSettled([
      service.levelUp(primary.user, primary.ringId,
        levelRequest(2, 3, randomUUID())),
      service.levelUp(primary.user, primary.ringId,
        levelRequest(2, 3, randomUUID())),
    ]);
    assert.equal(differentKeyRace.filter((result) => result.status === 'fulfilled').length, 1);
    const rejectedRace = differentKeyRace.find((result) => result.status === 'rejected');
    assert.ok(rejectedRace && rejectedRace.status === 'rejected');
    assert.equal(codeOf(rejectedRace.reason), CopperLevelUpErrorCode.StaleLevel);
    await assertPrimaryState(primary, { level: 3, unspent: 8, ert: 972, spent: 28, ledger: 2, events: 2, operations: 2 });

    const sharedKey = randomUUID();
    const sharedRequest = levelRequest(3, 4, sharedKey);
    const sameKeyRace = await Promise.all([
      service.levelUp(primary.user, primary.ringId, sharedRequest),
      service.levelUp(primary.user, primary.ringId, sharedRequest),
    ]);
    assert.deepEqual(sameKeyRace[1], sameKeyRace[0]);
    await assertPrimaryState(primary, { level: 4, unspent: 12, ert: 952, spent: 48, ledger: 3, events: 3, operations: 3 });
    await assertPrimaryReconciliation(primary);

    await verifyInsufficientErt();
    await verifyFractionalErtContract();
    await verifyDualCurrencyLevelUp();
    await verifyDualCurrencyRollback();
    await verifyAuditFailureRollback();

    console.log(JSON.stringify({
      database: databaseName,
      sameKeySequentialOneDebit: true,
      sameKeyConcurrentOneDebit: true,
      differentKeyConcurrentOneWinner: true,
      idempotencyConflict: true,
      insufficientErtRollback: true,
      fractionalErtPreviewDebitAndReplayExact: true,
      insufficientEruBeforeEitherDebit: true,
      dualCurrencyConcurrentReplayOnePair: true,
      injectedEruFailureFullRollback: true,
      injectedAuditFailureFullRollback: true,
      attributesUnchangedAndPointsAccumulated: true,
      ledgerBalanceRingAuditReconciled: true,
    }, null, 2));
  } finally {
    await dropFaultTrigger();
    await dropEruFaultTrigger();
    await dataSource.destroy();
  }
}

async function assertSchemaReady() {
  const rows = await dataSource.query(`
    SELECT to_regclass('public.copper_level_up_operations') AS operations,
      to_regclass('public.game_rings') AS rings
  `);
  assert.ok(rows[0].operations && rows[0].rings, 'Copper level-up migrations are not applied');
}

async function seedFixture(
  ert: number | string,
  level: number,
  eru: string = '100',
): Promise<Fixture> {
  const userId = randomUUID();
  const ringId = randomUUID();
  await dataSource.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
    VALUES ($1, $2, $3, 'Level QA', false, now(), now())
  `, [userId, `level-qa-${randomUUID()}`, `level_qa_${randomUUID().replaceAll('-', '')}`]);
  await dataSource.query(`
    INSERT INTO balances (
      user_id, ert_balance, lifetime_earned_ert, lifetime_spent_ert,
      eru_balance, lifetime_earned_eru, lifetime_spent_eru, updated_at
    ) VALUES ($1, $2, $2, 0, $3, $3, 0, now())
  `, [userId, ert, eru]);
  await dataSource.query(`
    INSERT INTO game_rings (
      id, owner_user_id, entitlement_code, ring_kind, status, level, shine,
      comfort, charm, quality, luck, unspent_attribute_points, visual_variant_code, ruleset_version,
      generation_version, visual_set_version, issued_reason, created_at, updated_at
    ) VALUES (
      $1, $2, 'starter-copper-v1', 'COPPER', 'ACTIVE', $3, 100,
      20, 7, 11, 2, 0, 'copper_plain_polished', 'copper-rules-v1',
      'copper-generation-v1', 'copper-visual-v1', 'REGISTRATION', now(), now()
    )
  `, [ringId, userId, level]);
  return { user: Object.assign(new User(), { id: userId }), ringId };
}

function levelRequest(current: number, target: number, key: string) {
  return { expectedCurrentLevel: current, targetLevel: target, idempotencyKey: key };
}

async function assertPrimaryState(
  fixture: Fixture,
  expected: { level: number; unspent: number; ert: number; spent: number; ledger: number; events: number; operations: number },
) {
  const [ring] = await dataSource.query(
    'SELECT level, unspent_attribute_points::int AS unspent FROM game_rings WHERE id = $1',
    [fixture.ringId],
  );
  const [balance] = await dataSource.query(
    'SELECT ert_balance::int AS ert, lifetime_spent_ert::int AS spent FROM balances WHERE user_id = $1',
    [fixture.user.id],
  );
  const [counts] = await dataSource.query(`
    SELECT
      (SELECT COUNT(*)::int FROM ledger_transactions WHERE user_id = $1 AND type = 'COPPER_LEVEL_UP_SPEND') AS ledger,
      (SELECT COUNT(*)::int FROM ring_events WHERE owner_user_id = $1 AND event_type = 'LEVEL_UP') AS events,
      (SELECT COUNT(*)::int FROM copper_level_up_operations WHERE owner_user_id = $1 AND status = 'COMPLETED') AS operations
  `, [fixture.user.id]);
  assert.deepEqual(ring, { level: expected.level, unspent: expected.unspent });
  assert.deepEqual(balance, { ert: expected.ert, spent: expected.spent });
  assert.deepEqual(counts, { ledger: expected.ledger, events: expected.events, operations: expected.operations });
}

async function assertPrimaryReconciliation(fixture: Fixture) {
  const [ring] = await dataSource.query(
    `SELECT level, comfort, charm, quality, luck,
      unspent_attribute_points::int AS unspent
    FROM game_rings WHERE id = $1`, [fixture.ringId],
  );
  assert.deepEqual(ring, { level: 4, comfort: 20, charm: 7, quality: 11, luck: 2, unspent: 12 });
  const ledger = await dataSource.query(`
    SELECT amount::int AS amount, balance_after::int AS "balanceAfter", reference_id AS "referenceId"
    FROM ledger_transactions WHERE user_id = $1 AND type = 'COPPER_LEVEL_UP_SPEND'
    ORDER BY created_at, id
  `, [fixture.user.id]);
  assert.deepEqual(ledger.map((row: { amount: number; balanceAfter: number }) =>
    ({ amount: row.amount, balanceAfter: row.balanceAfter })), [
    { amount: -12, balanceAfter: 988 },
    { amount: -16, balanceAfter: 972 },
    { amount: -20, balanceAfter: 952 },
  ]);
  assert.equal(new Set(ledger.map((row: { referenceId: string }) => row.referenceId)).size, 3);
  const operations = await dataSource.query(`
    SELECT rules_version AS "rulesVersion", response_snapshot AS response
    FROM copper_level_up_operations
    WHERE owner_user_id = $1 ORDER BY created_at, id
  `, [fixture.user.id]);
  assert.equal(operations.every((row: { rulesVersion: string }) => row.rulesVersion === 'copper-level-up-v2'), true);
  assert.deepEqual(
    operations.map((row: { response: { unspentAttributePoints: { current: number } } }) =>
      row.response.unspentAttributePoints.current),
    [4, 8, 12],
  );
  const [audit] = await dataSource.query(`
    SELECT COUNT(*)::int AS count FROM ring_events event
    JOIN copper_level_up_operations operation
      ON event.operation_key = 'level-up:' || operation.id::text
    JOIN ledger_transactions ledger ON ledger.reference_id = operation.id::text
    WHERE operation.owner_user_id = $1 AND event.snapshot = operation.response_snapshot
  `, [fixture.user.id]);
  assert.equal(audit.count, 3);
}

async function verifyInsufficientErt() {
  const fixture = await seedFixture(11, 1);
  await assert.rejects(
    service.levelUp(fixture.user, fixture.ringId,
      levelRequest(1, 2, randomUUID())),
    (error) => codeOf(error) === CopperLevelUpErrorCode.InsufficientErt,
  );
  await assertPrimaryState(fixture, { level: 1, unspent: 0, ert: 11, spent: 0, ledger: 0, events: 0, operations: 0 });
}

async function verifyFractionalErtContract() {
  const enough = await seedFixture('12.000000000000000001', 1);
  const preview = await previewService.preview(enough.user, enough.ringId, {
    expectedCurrentLevel: 1,
    targetLevel: 2,
  });
  assert.equal(preview.balances.ertExact, '12.000000000000000001');
  assert.equal(preview.balances.ertDisplay, '12.00');
  assert.equal(preview.affordability.ert, true);

  const request = levelRequest(1, 2, randomUUID());
  const first = await service.levelUp(enough.user, enough.ringId, request);
  const replay = await service.levelUp(enough.user, enough.ringId, request);
  assert.deepEqual(replay, first);
  assert.equal(first.cost.ertExact, '12');
  assert.equal(first.cost.ertDisplay, '12.00');
  assert.equal(first.balances.ertBeforeExact, '12.000000000000000001');
  assert.equal(first.balances.ertAfterExact, '0.000000000000000001');
  assert.equal(first.balances.ertAfterDisplay, '0.00');

  const [persisted] = await dataSource.query(`
    SELECT b.ert_balance::text AS "ertBalance",
      b.lifetime_spent_ert::text AS "lifetimeSpentErt",
      l.amount::text AS amount, l.balance_after::text AS "balanceAfter"
    FROM balances b
    JOIN ledger_transactions l ON l.user_id = b.user_id
      AND l.type = 'COPPER_LEVEL_UP_SPEND'
    WHERE b.user_id = $1
  `, [enough.user.id]);
  assert.deepEqual(persisted, {
    ertBalance: '0.000000000000000001',
    lifetimeSpentErt: '12.000000000000000000',
    amount: '-12.000000000000000000',
    balanceAfter: '0.000000000000000001',
  });

  const insufficient = await seedFixture('11.999999999999999999', 1);
  await assert.rejects(
    service.levelUp(insufficient.user, insufficient.ringId,
      levelRequest(1, 2, randomUUID())),
    (error) => codeOf(error) === CopperLevelUpErrorCode.InsufficientErt,
  );
  const [unchanged] = await dataSource.query(`
    SELECT ert_balance::text AS "ertBalance", lifetime_spent_ert::text AS "lifetimeSpentErt"
    FROM balances WHERE user_id = $1
  `, [insufficient.user.id]);
  assert.deepEqual(unchanged, {
    ertBalance: '11.999999999999999999',
    lifetimeSpentErt: '0.000000000000000000',
  });
}

async function verifyDualCurrencyLevelUp() {
  const insufficient = await seedFixture(100, 4, '29');
  await assert.rejects(
    service.levelUp(insufficient.user, insufficient.ringId,
      levelRequest(4, 5, randomUUID())),
    (error) => codeOf(error) === CopperLevelUpErrorCode.InsufficientEru,
  );
  await assertDualCurrencyState(insufficient, {
    level: 4, unspent: 0, ert: '100', spentErt: '0', eru: '29', spentEru: '0',
    ertLedger: 0, eruLedger: 0, events: 0, operations: 0,
  });

  const enough = await seedFixture(100, 4, '30');
  const preview = await previewService.preview(enough.user, enough.ringId, {
    expectedCurrentLevel: 4,
    targetLevel: 5,
  });
  assert.equal(preview.cost.eruExact, '30');
  assert.equal(preview.balances.eruExact, '30');
  assert.equal(preview.affordability.eru, true);
  assert.equal(preview.available, true);

  const request = levelRequest(4, 5, randomUUID());
  const results = await Promise.all(Array.from(
    { length: 12 },
    () => service.levelUp(enough.user, enough.ringId, request),
  ));
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  assert.equal(results[0].cost.eruExact, '30');
  assert.equal(results[0].balances.eruBeforeExact, '30');
  assert.equal(results[0].balances.eruAfterExact, '0');
  assert.ok(results[0].ledgerTransactionIds.ert);
  assert.ok(results[0].ledgerTransactionIds.eru);
  await assertDualCurrencyState(enough, {
    level: 5, unspent: 4, ert: '76', spentErt: '24', eru: '0', spentEru: '30',
    ertLedger: 1, eruLedger: 1, events: 1, operations: 1,
  });
}

async function verifyDualCurrencyRollback() {
  const fixture = await seedFixture(100, 4, '30');
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION qa_reject_copper_eru_debit() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'qa injected ERU debit failure' USING ERRCODE = '23514'; END;
    $$ LANGUAGE plpgsql
  `);
  await dataSource.query(`
    CREATE TRIGGER qa_reject_copper_eru_debit
    BEFORE INSERT ON ledger_transactions FOR EACH ROW
    WHEN (NEW.currency = 'ERU' AND NEW.type = 'COPPER_LEVEL_UP_SPEND')
    EXECUTE FUNCTION qa_reject_copper_eru_debit()
  `);
  try {
    await assert.rejects(
      service.levelUp(fixture.user, fixture.ringId, levelRequest(4, 5, randomUUID())),
      (error) => codeOf(error) === CopperLevelUpErrorCode.WriteUnavailable,
    );
  } finally {
    await dropEruFaultTrigger();
  }
  await assertDualCurrencyState(fixture, {
    level: 4, unspent: 0, ert: '100', spentErt: '0', eru: '30', spentEru: '0',
    ertLedger: 0, eruLedger: 0, events: 0, operations: 0,
  });
}

async function assertDualCurrencyState(fixture: Fixture, expected: {
  level: number;
  unspent: number;
  ert: string;
  spentErt: string;
  eru: string;
  spentEru: string;
  ertLedger: number;
  eruLedger: number;
  events: number;
  operations: number;
}) {
  const [ring] = await dataSource.query(
    'SELECT level, unspent_attribute_points::int AS unspent FROM game_rings WHERE id = $1',
    [fixture.ringId],
  );
  const [balance] = await dataSource.query(`
    SELECT ert_balance::numeric::text AS ert,
      lifetime_spent_ert::numeric::text AS "spentErt",
      eru_balance::numeric(48,0)::text AS eru,
      lifetime_spent_eru::numeric(48,0)::text AS "spentEru"
    FROM balances WHERE user_id = $1
  `, [fixture.user.id]);
  const [counts] = await dataSource.query(`
    SELECT
      COUNT(*) FILTER (WHERE currency = 'ERT')::int AS "ertLedger",
      COUNT(*) FILTER (WHERE currency = 'ERU')::int AS "eruLedger",
      (SELECT COUNT(*)::int FROM ring_events WHERE owner_user_id = $1 AND event_type = 'LEVEL_UP') AS events,
      (SELECT COUNT(*)::int FROM copper_level_up_operations WHERE owner_user_id = $1 AND status = 'COMPLETED') AS operations
    FROM ledger_transactions WHERE user_id = $1 AND type = 'COPPER_LEVEL_UP_SPEND'
  `, [fixture.user.id]);
  assert.deepEqual(ring, { level: expected.level, unspent: expected.unspent });
  assert.deepEqual({
    ...balance,
    ert: canonicalErt(balance.ert),
    spentErt: canonicalErt(balance.spentErt),
  }, {
    ert: expected.ert,
    spentErt: expected.spentErt,
    eru: expected.eru,
    spentEru: expected.spentEru,
  });
  assert.deepEqual(counts, {
    ertLedger: expected.ertLedger,
    eruLedger: expected.eruLedger,
    events: expected.events,
    operations: expected.operations,
  });
}

async function verifyAuditFailureRollback() {
  const fixture = await seedFixture(100, 1);
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION qa_reject_copper_level_up_event() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'qa injected audit failure' USING ERRCODE = '23514'; END;
    $$ LANGUAGE plpgsql
  `);
  await dataSource.query(`
    CREATE TRIGGER qa_reject_copper_level_up_event
    BEFORE INSERT ON ring_events FOR EACH ROW
    WHEN (NEW.event_type = 'LEVEL_UP') EXECUTE FUNCTION qa_reject_copper_level_up_event()
  `);
  try {
    await assert.rejects(
      service.levelUp(fixture.user, fixture.ringId,
        levelRequest(1, 2, randomUUID())),
      (error) => codeOf(error) === CopperLevelUpErrorCode.WriteUnavailable,
    );
  } finally {
    await dropFaultTrigger();
  }
  await assertPrimaryState(fixture, { level: 1, unspent: 0, ert: 100, spent: 0, ledger: 0, events: 0, operations: 0 });
}

async function dropFaultTrigger() {
  if (!dataSource.isInitialized) return;
  await dataSource.query('DROP TRIGGER IF EXISTS qa_reject_copper_level_up_event ON ring_events');
  await dataSource.query('DROP FUNCTION IF EXISTS qa_reject_copper_level_up_event()');
}

async function dropEruFaultTrigger() {
  if (!dataSource.isInitialized) return;
  await dataSource.query('DROP TRIGGER IF EXISTS qa_reject_copper_eru_debit ON ledger_transactions');
  await dataSource.query('DROP FUNCTION IF EXISTS qa_reject_copper_eru_debit()');
}

function codeOf(error: unknown) {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    ? (response as { code: string }).code
    : null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
