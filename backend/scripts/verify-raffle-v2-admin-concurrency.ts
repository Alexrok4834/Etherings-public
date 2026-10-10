import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AdminRaffleV2Service } from '../src/admin/admin-raffle-v2.service';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });

async function main() {
  await dataSource.initialize();
  try {
    const service = new AdminRaffleV2Service(dataSource);
    const [{ id: adminId }] = await dataSource.query(`SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1`);
    assert.ok(adminId);
    await dataSource.query(`
      INSERT INTO "raffle_machines" ("singleton_key", "code") VALUES (1, 'daily-draw')
      ON CONFLICT ("singleton_key") DO NOTHING
    `);

    const reward = await service.createReward(rewardInput(`qa_ert_${Date.now()}`)) as { id: string };
    const first = await configuredDraft(service, adminId, reward.id, 'Initial active');
    const firstActivation = await service.activateDraft(adminId, first.id, activation(null, 'Initial QA activation')) as any;
    assert.equal(firstActivation.activeConfigurationVersion, first.id);

    const left = await configuredDraft(service, adminId, reward.id, 'Concurrent left');
    const right = await configuredDraft(service, adminId, reward.id, 'Concurrent right');
    const concurrent = await Promise.allSettled([
      service.activateDraft(adminId, left.id, activation(first.id, 'Concurrent left activation')),
      service.activateDraft(adminId, right.id, activation(first.id, 'Concurrent right activation')),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);

    const overviewAfterRace = await service.overview() as any;
    const active = overviewAfterRace.configurations.filter((item: any) => item.status === 'ACTIVE');
    assert.equal(active.length, 1);
    const losingDraft = overviewAfterRace.configurations.find((item: any) => item.status === 'DRAFT');
    assert.ok(losingDraft, 'losing concurrent activation must remain a draft');

    const invalid = await service.createDraft(adminId, {
      title: 'Invalid empty QA draft', description: null, costErtExact: '5', dailyUserAttemptLimit: 5,
    }) as { id: string };
    await assert.rejects(() => service.activateDraft(adminId, invalid.id, activation(active[0].id, 'Must roll back')));
    const afterInvalid = await service.overview() as any;
    assert.equal(afterInvalid.configurations.filter((item: any) => item.status === 'ACTIVE')[0].id, active[0].id);
    assert.equal(afterInvalid.configurations.find((item: any) => item.id === invalid.id).status, 'DRAFT');

    const pauseRequest = availability(true, 'Concurrent pause');
    const pauses = await Promise.all([
      service.setAvailability(adminId, 'PAUSE', pauseRequest),
      service.setAvailability(adminId, 'PAUSE', pauseRequest),
    ]) as any[];
    assert.equal(pauses.every((result) => result.available === false), true);
    const [{ count: pauseCount }] = await dataSource.query(`
      SELECT count(*)::int AS count FROM "raffle_machine_availability_operations"
      WHERE "admin_user_id" = $1 AND "idempotency_key" = $2
    `, [adminId, pauseRequest.idempotencyKey]);
    assert.equal(pauseCount, 1);

    const resumed = await service.setAvailability(adminId, 'RESUME', availability(false, 'QA resume')) as any;
    assert.equal(resumed.available, true);
    const [{ activeCount, activationCount }] = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM "raffle_configurations" WHERE "status" = 'ACTIVE') AS "activeCount",
        (SELECT count(*)::int FROM "raffle_configuration_activation_operations" WHERE "status" = 'COMPLETED') AS "activationCount"
    `);
    assert.equal(activeCount, 1);
    assert.equal(activationCount, 2);

    console.log(JSON.stringify({
      database: databaseName,
      concurrentActivationSingleWinner: true,
      losingDraftPreserved: true,
      invalidActivationRolledBack: true,
      pauseReplayExactlyOnce: true,
      resumePreservedActiveVersion: true,
      activeConfigurationId: active[0].id,
    }, null, 2));
  } finally {
    await dataSource.destroy();
  }
}

async function configuredDraft(service: AdminRaffleV2Service, adminId: string, rewardId: string, title: string) {
  const draft = await service.createDraft(adminId, {
    title, description: null, costErtExact: '5', dailyUserAttemptLimit: 5,
  }) as { id: string };
  await service.replaceDraftRewards(draft.id, { rewards: [{ rewardId, weight: 100 }] });
  const preview = await service.previewDraft(draft.id) as any;
  assert.equal(preview.valid, true);
  return draft;
}

function rewardInput(code: string) {
  return {
    code, title: 'QA exact ERT', description: null, type: 'ERT', amountExact: '1', imageUrl: null,
    stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
  };
}

function activation(expectedActiveConfigurationVersion: string | null, reason: string) {
  return { expectedActiveConfigurationVersion, reason, idempotencyKey: randomUUID() };
}

function availability(expectedAvailable: boolean, reason: string) {
  return { expectedAvailable, reason, idempotencyKey: randomUUID() };
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
