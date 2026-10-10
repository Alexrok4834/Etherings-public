import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, MigrationInterface, QueryRunner } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { RaffleConfiguration, RaffleConfigurationStatus } from '../src/raffle/raffle-configuration.entity';
import { RaffleConfigurationReward } from '../src/raffle/raffle-configuration-reward.entity';
import { RaffleDrawOperation } from '../src/raffle/raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from '../src/raffle/raffle-draw-result-v2.entity';
import { RaffleV2DrawCoreService } from '../src/raffle/raffle-v2-draw-core.service';
import { RaffleV2DrawRepository } from '../src/raffle/raffle-v2-draw.repository';
import {
  RaffleV2FulfillmentPort,
  RaffleV2FulfillmentResponse,
  RaffleV2PreparedFulfillment,
} from '../src/raffle/raffle-v2-fulfillment.port';
import { RaffleV2IntegerSelectionService } from '../src/raffle/raffle-v2-integer-selection.service';
import { RaffleMachine } from '../src/raffle/raffle-machine.entity';
import { RaffleV2RandomIntegerPort } from '../src/raffle/raffle-v2-random-integer.port';
import { Reward } from '../src/raffle/reward.entity';
import { CreateRaffleV2SingletonSchema1787616000000 } from '../src/migrations/1787616000000-create-raffle-v2-singleton-schema';
import { CreateRaffleV2DrawEvidenceSchema1787702400000 } from '../src/migrations/1787702400000-create-raffle-v2-draw-evidence-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [
    User,
    Reward,
    RaffleMachine,
    RaffleConfiguration,
    RaffleConfigurationReward,
    RaffleDrawOperation,
    RaffleDrawResultV2,
  ],
});
const singletonMigration = new CreateRaffleV2SingletonSchema1787616000000();
const evidenceMigration = new CreateRaffleV2DrawEvidenceSchema1787702400000();
const configurationId = randomUUID();
const machineId = randomUUID();
const rewardId = randomUUID();

class CountingRandom implements RaffleV2RandomIntegerPort {
  calls = 0;

  nextInt(maxExclusive: number) {
    assert.equal(maxExclusive, 100);
    this.calls += 1;
    return 42;
  }
}

class QaFulfillment implements RaffleV2FulfillmentPort {
  calls = 0;

  constructor(private readonly failAfterEffect = false) {}

  async lockAndValidate(manager: EntityManager, input: { ownerUserId: string }): Promise<RaffleV2PreparedFulfillment> {
    const [account] = await manager.query(`
      SELECT balance, attempts FROM qa_raffle_accounts WHERE owner_id = $1 FOR UPDATE
    `, [input.ownerUserId]);
    assert.ok(account, 'QA account must exist');
    assert.ok(account.balance >= 5 && account.attempts < 5, 'QA account must be eligible');
    return { eligibleRewardIds: [rewardId], state: { before: account } };
  }

  async fulfill(
    manager: EntityManager,
    input: { ownerUserId: string; operation: RaffleDrawOperation },
  ): Promise<RaffleV2FulfillmentResponse> {
    this.calls += 1;
    const [account] = await manager.query(`
      UPDATE qa_raffle_accounts
      SET balance = balance - 5, attempts = attempts + 1
      WHERE owner_id = $1
      RETURNING balance, attempts
    `, [input.ownerUserId]);
    await manager.query(`
      INSERT INTO qa_raffle_effects (operation_id, owner_id) VALUES ($1, $2)
    `, [input.operation.id, input.ownerUserId]);
    if (this.failAfterEffect) throw new Error('qa injected failure after economic effect');

    return {
      cost: {
        currency: 'ERT',
        amountExact: '5',
        amountDisplay: '5.00',
        ledgerTransactionId: randomUUID(),
      },
      attempts: {
        limit: 5,
        used: account.attempts,
        remaining: 5 - account.attempts,
        day: '2026-08-31',
        resetsAt: '2026-09-01T00:00:00.000Z',
      },
      fulfillment: {
        type: 'ERT_CREDIT',
        ledgerTransactionId: randomUUID(),
        balanceAfterExact: String(account.balance),
        balanceAfterDisplay: `${account.balance}.00`,
      },
    };
  }
}

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await resetMinimalSchema(runner);
    await runMigration(runner, singletonMigration, 'up');
    await runMigration(runner, evidenceMigration, 'up');
    const firstFingerprint = await evidenceFingerprint(runner);
    await runMigration(runner, evidenceMigration, 'down');
    await runMigration(runner, evidenceMigration, 'up');
    assert.deepEqual(await evidenceFingerprint(runner), firstFingerprint);
    await seedDraw(runner);

    await verifySequentialAndConcurrentReplay();
    await verifyDifferentKeysSerialize();
    await verifyRollbackAfterEffect();
    await verifyConflict();
    await verifyLifecycleGuards(runner);
    await assert.rejects(() => evidenceMigration.down(runner), /while rows exist/);

    console.log(JSON.stringify({
      database: databaseName,
      migrationUpDownUpStable: true,
      sameKeySequentialReplay: true,
      sameKeyConcurrentOneMutation: true,
      differentKeyOwnerLockSerialization: true,
      idempotencyConflictNoMutation: true,
      failureAfterEffectFullRollback: true,
      immutableEvidenceLifecycle: true,
      populatedDownBlocked: true,
    }, null, 2));
  } finally {
    await runner.query('DROP SCHEMA public CASCADE');
    await runner.query('CREATE SCHEMA public');
    await runner.release();
    await dataSource.destroy();
  }
}

async function verifySequentialAndConcurrentReplay() {
  const ownerId = await seedOwner(100);
  const random = new CountingRandom();
  const fulfillment = new QaFulfillment();
  const service = drawService(random, fulfillment);
  const key = randomUUID();
  const request = drawRequest(key);

  const first = await service.execute(ownerId, request);
  const replay = await service.execute(ownerId, request);
  assertReplayOf(replay, first);

  const concurrentKey = randomUUID();
  const concurrent = await Promise.all([
    service.execute(ownerId, drawRequest(concurrentKey)),
    service.execute(ownerId, drawRequest(concurrentKey)),
  ]);
  const fresh = concurrent.find((response) => !operationOf(response).replayed);
  const repeated = concurrent.find((response) => operationOf(response).replayed);
  assert.ok(fresh && repeated);
  assertReplayOf(repeated, fresh);
  assert.equal(random.calls, 2);
  assert.equal(fulfillment.calls, 2);
  await assertOwnerState(ownerId, { balance: 90, attempts: 2, operations: 2, results: 2, effects: 2 });
}

async function verifyDifferentKeysSerialize() {
  const ownerId = await seedOwner(20);
  const random = new CountingRandom();
  const fulfillment = new QaFulfillment();
  const service = drawService(random, fulfillment);

  const responses = await Promise.all([
    service.execute(ownerId, drawRequest(randomUUID())),
    service.execute(ownerId, drawRequest(randomUUID())),
  ]);
  assert.equal(operationOf(responses[0]).replayed, false);
  assert.equal(operationOf(responses[1]).replayed, false);
  assert.equal(random.calls, 2);
  assert.equal(fulfillment.calls, 2);
  await assertOwnerState(ownerId, { balance: 10, attempts: 2, operations: 2, results: 2, effects: 2 });
}

async function verifyConflict() {
  const ownerId = await seedOwner(20);
  const random = new CountingRandom();
  const fulfillment = new QaFulfillment();
  const service = drawService(random, fulfillment);
  const key = randomUUID();
  await service.execute(ownerId, drawRequest(key));

  await dataSource.query(`
    UPDATE raffle_configurations SET status = 'DISABLED', disabled_at = now() WHERE id = $1
  `, [configurationId]);
  const secondConfigurationId = await seedSecondActiveConfiguration();
  try {
    await assert.rejects(
      service.execute(ownerId, {
        contractVersion: 'raffle-v2',
        configurationVersion: secondConfigurationId,
        idempotencyKey: key,
      }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(random.calls, 1);
    assert.equal(fulfillment.calls, 1);
    await assertOwnerState(ownerId, { balance: 15, attempts: 1, operations: 1, results: 1, effects: 1 });
  } finally {
    await dataSource.query(`
      UPDATE raffle_configurations SET status = 'DISABLED', disabled_at = now() WHERE id = $1
    `, [secondConfigurationId]);
  }
}

async function verifyRollbackAfterEffect() {
  const ownerId = await seedOwner(20);
  const random = new CountingRandom();
  const fulfillment = new QaFulfillment(true);
  const service = drawService(random, fulfillment);

  await assert.rejects(
    service.execute(ownerId, drawRequest(randomUUID())),
    /qa injected failure after economic effect/,
  );
  assert.equal(random.calls, 1);
  assert.equal(fulfillment.calls, 1);
  await assertOwnerState(ownerId, { balance: 20, attempts: 0, operations: 0, results: 0, effects: 0 });
}

async function verifyLifecycleGuards(runner: QueryRunner) {
  const [result] = await runner.query('SELECT id FROM raffle_draw_results_v2 ORDER BY created_at LIMIT 1');
  const [operation] = await runner.query('SELECT id FROM raffle_draw_operations ORDER BY created_at LIMIT 1');
  await expectSqlState(() => runner.query(
    'UPDATE raffle_draw_results_v2 SET ticket = ticket + 1 WHERE id = $1', [result.id],
  ), '23514');
  await expectSqlState(() => runner.query(
    'DELETE FROM raffle_draw_results_v2 WHERE id = $1', [result.id],
  ), '23514');
  await expectSqlState(() => runner.query(
    'DELETE FROM raffle_draw_operations WHERE id = $1', [operation.id],
  ), '23514');
}

function drawService(random: CountingRandom, fulfillment: QaFulfillment) {
  return new RaffleV2DrawCoreService(
    new RaffleV2DrawRepository(dataSource),
    new RaffleV2IntegerSelectionService(random),
    fulfillment,
  );
}

function drawRequest(idempotencyKey: string) {
  return { contractVersion: 'raffle-v2', configurationVersion: configurationId, idempotencyKey };
}

async function seedOwner(balance: number) {
  const ownerId = randomUUID();
  await dataSource.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin, created_at, updated_at)
    VALUES ($1, $2, $3, 'Raffle QA', false, now(), now())
  `, [ownerId, `raffle-qa-${ownerId}`, `raffle_qa_${ownerId.replaceAll('-', '')}`]);
  await dataSource.query(`
    INSERT INTO qa_raffle_accounts (owner_id, balance, attempts) VALUES ($1, $2, 0)
  `, [ownerId, balance]);
  return ownerId;
}

async function assertOwnerState(
  ownerId: string,
  expected: { balance: number; attempts: number; operations: number; results: number; effects: number },
) {
  const [state] = await dataSource.query(`
    SELECT account.balance, account.attempts,
      (SELECT count(*)::int FROM raffle_draw_operations WHERE owner_user_id = $1) AS operations,
      (SELECT count(*)::int FROM raffle_draw_results_v2 WHERE owner_user_id = $1) AS results,
      (SELECT count(*)::int FROM qa_raffle_effects WHERE owner_id = $1) AS effects
    FROM qa_raffle_accounts account WHERE owner_id = $1
  `, [ownerId]);
  assert.deepEqual(state, expected);
}

function operationOf(response: Record<string, unknown>) {
  return response.operation as { replayed: boolean };
}

function assertReplayOf(replay: Record<string, unknown>, original: Record<string, unknown>) {
  assert.equal(operationOf(original).replayed, false);
  assert.equal(operationOf(replay).replayed, true);
  assert.deepEqual(
    { ...replay, operation: { ...(replay.operation as Record<string, unknown>), replayed: false } },
    original,
  );
}

async function seedSecondActiveConfiguration() {
  const id = randomUUID();
  await dataSource.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, 'raffle-v2', 'DRAFT', 'Second QA', 5, 5, $3)
  `, [id, machineId, await creatorId()]);
  await dataSource.query(`
    INSERT INTO raffle_configuration_rewards
      (configuration_id, reward_id, segment_index, weight, reward_snapshot)
    VALUES ($1, $2, 0, 100, $3::jsonb)
  `, [id, rewardId, JSON.stringify(rewardSnapshot())]);
  await dataSource.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [id]);
  return id;
}

async function creatorId() {
  const [row] = await dataSource.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  return row.id as string;
}

async function resetMinimalSchema(runner: QueryRunner) {
  await runner.query('DROP SCHEMA public CASCADE');
  await runner.query('CREATE SCHEMA public');
  await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await runner.query(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), telegram_id varchar(64) UNIQUE NOT NULL,
      username varchar(64), first_name varchar(128), last_name varchar(128), photo_url varchar(512),
      is_admin boolean NOT NULL DEFAULT false, last_login_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await runner.query(`
    CREATE TABLE rewards (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), code varchar(64) UNIQUE NOT NULL,
      title varchar(128) NOT NULL, description text, type varchar(32) NOT NULL,
      amount numeric(24,0), amount_exact numeric(30,0), metadata jsonb, image_url varchar(512),
      is_active boolean NOT NULL DEFAULT true, stock_total integer, stock_remaining integer,
      per_user_limit integer, daily_global_limit integer,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function seedDraw(runner: QueryRunner) {
  const creator = randomUUID();
  await runner.query(`
    INSERT INTO users (id, telegram_id, username, first_name, is_admin)
    VALUES ($1, 'raffle-v2-qa-creator', 'raffle_v2_qa_creator', 'QA Creator', true)
  `, [creator]);
  await runner.query(`
    INSERT INTO rewards (id, code, title, type, amount, amount_exact, is_active)
    VALUES ($1, 'ert-5-qa', '5 ERT', 'ERT', 5, 5, true)
  `, [rewardId]);
  await runner.query('INSERT INTO raffle_machines (id, code) VALUES ($1, $2)', [machineId, 'daily-draw']);
  await runner.query(`
    INSERT INTO raffle_configurations (
      id, machine_id, contract_version, status, title, cost_ert,
      daily_user_attempt_limit, created_by_user_id
    ) VALUES ($1, $2, 'raffle-v2', 'DRAFT', 'Daily Draw', 5, 5, $3)
  `, [configurationId, machineId, creator]);
  await runner.query(`
    INSERT INTO raffle_configuration_rewards
      (configuration_id, reward_id, segment_index, weight, reward_snapshot)
    VALUES ($1, $2, 0, 100, $3::jsonb)
  `, [configurationId, rewardId, JSON.stringify(rewardSnapshot())]);
  await runner.query(`
    UPDATE raffle_configurations SET status = 'ACTIVE', activated_at = now() WHERE id = $1
  `, [configurationId]);
  await runner.query(`
    CREATE TABLE qa_raffle_accounts (
      owner_id uuid PRIMARY KEY REFERENCES users(id), balance integer NOT NULL, attempts integer NOT NULL
    )
  `);
  await runner.query(`
    CREATE TABLE qa_raffle_effects (
      operation_id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id)
    )
  `);
}

function rewardSnapshot() {
  return {
    rewardId,
    code: 'ert-5',
    title: '5 ERT',
    type: 'ERT',
    segmentIndex: 0,
    weight: '100',
    probability: { numerator: '100', denominator: '100' },
    imageUrl: null,
    amountExact: '5',
    amountDisplay: '5.00',
  };
}

async function evidenceFingerprint(runner: QueryRunner) {
  return runner.query(`
    SELECT kind, object_name, definition FROM (
      SELECT 'column' AS kind, table_name || '.' || column_name AS object_name,
        data_type || ':' || is_nullable || ':' || COALESCE(column_default, '') AS definition
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY(ARRAY['raffle_draw_operations', 'raffle_draw_results_v2'])
      UNION ALL
      SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid IN ('raffle_draw_operations'::regclass, 'raffle_draw_results_v2'::regclass)
      UNION ALL
      SELECT 'index', tablename || '.' || indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ANY(ARRAY['raffle_draw_operations', 'raffle_draw_results_v2'])
    ) evidence ORDER BY kind, object_name, definition
  `);
}

async function expectSqlState(operation: () => Promise<unknown>, expected: string) {
  await assert.rejects(operation, (error) => (error as { code?: string }).code === expected);
}

async function runMigration(runner: QueryRunner, migration: MigrationInterface, direction: 'up' | 'down') {
  await runner.startTransaction();
  try {
    await migration[direction](runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
