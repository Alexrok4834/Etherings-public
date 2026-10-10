const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { AdminRaffleV2Service } = require(path.join(process.cwd(), 'dist', 'admin', 'admin-raffle-v2.service.js'));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^raffle_v2_prod_rehearsal(?:_[a-z0-9]+)*_qa$/.test(databaseName)) {
  throw new Error('Refusing to inspect a database outside the approved restored-copy name');
}

async function main() {
  const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });
  await dataSource.initialize();
  try {
    const service = new AdminRaffleV2Service(dataSource);
    const before = await protectedState(dataSource);
    const admins = await dataSource.query('SELECT "id" FROM "users" WHERE "is_admin" ORDER BY "id"');
    assert.ok(admins.length >= 1);
    const adminId = admins[0].id;
    const initial = await service.overview();
    const oldActive = initial.configurations.find((item) => item.status === 'ACTIVE');
    assert.ok(oldActive);
    assert.ok(oldActive.rewards.length > 0);
    assert.equal(initial.machine.available, true);

    const draft = await service.createDraft(adminId, {
      title: 'Raffle admin restore rehearsal', description: 'Disposable restored-copy verification',
      costErtExact: '6', dailyUserAttemptLimit: 4,
    });
    await service.updateDraft(draft.id, { title: 'Raffle admin restore rehearsal verified' });
    await service.replaceDraftRewards(draft.id, {
      rewards: oldActive.rewards.map((item) => ({ rewardId: item.rewardId, weight: Number(item.weight) })),
    });
    const preview = await service.previewDraft(draft.id);
    assert.equal(preview.valid, true);

    const activation = {
      expectedActiveConfigurationVersion: oldActive.id,
      reason: 'Restored-copy admin lifecycle rehearsal', idempotencyKey: randomUUID(),
    };
    const activated = await service.activateDraft(adminId, draft.id, activation);
    const replay = await service.activateDraft(adminId, draft.id, activation);
    assert.equal(activated.activeConfigurationVersion, draft.id);
    assert.equal(replay.replay, true);

    const invalid = await service.createDraft(adminId, {
      title: 'Invalid rehearsal draft', description: null, costErtExact: '7', dailyUserAttemptLimit: 3,
    });
    await assert.rejects(() => service.activateDraft(adminId, invalid.id, {
      expectedActiveConfigurationVersion: draft.id,
      reason: 'Expected rollback', idempotencyKey: randomUUID(),
    }));

    const pause = { expectedAvailable: true, reason: 'Restored-copy pause rehearsal', idempotencyKey: randomUUID() };
    const paused = await service.setAvailability(adminId, 'PAUSE', pause);
    const pauseReplay = await service.setAvailability(adminId, 'PAUSE', pause);
    assert.equal(paused.available, false);
    assert.equal(pauseReplay.replay, true);
    const resumed = await service.setAvailability(adminId, 'RESUME', {
      expectedAvailable: false, reason: 'Restored-copy resume rehearsal', idempotencyKey: randomUUID(),
    });
    assert.equal(resumed.available, true);

    await assert.rejects(() => dataSource.query(
      'UPDATE rewards SET title=title||\' forbidden\' WHERE id=$1', [oldActive.rewards[0].rewardId],
    ));
    const final = await service.overview();
    assert.equal(final.machine.available, true);
    assert.equal(final.configurations.filter((item) => item.status === 'ACTIVE').length, 1);
    assert.equal(final.configurations.find((item) => item.id === draft.id).status, 'ACTIVE');
    assert.equal(final.configurations.find((item) => item.id === oldActive.id).status, 'DISABLED');
    assert.equal(final.configurations.find((item) => item.id === invalid.id).status, 'DRAFT');
    const [operations] = await dataSource.query(`SELECT
      (SELECT count(*)::int FROM raffle_configuration_activation_operations) activations,
      (SELECT count(*)::int FROM raffle_machine_availability_operations) availability`);
    assert.equal(operations.activations, 1);
    assert.equal(operations.availability, 2);
    assert.deepEqual(await protectedState(dataSource), before);

    console.log(JSON.stringify({
      restoredProductionCopy: true, migrations: 16, draftEdited: true,
      orderedOutcomesPreserved: oldActive.rewards.length, canonicalPreviewValid: true,
      activationExactlyOnce: true, activationReplay: true, invalidActivationRolledBack: true,
      activeRewardGuarded: true, pauseReplayExactlyOnce: true,
      resumePreservedActiveConfiguration: true, protectedEconomyAndHistoryUnchanged: true,
    }));
  } finally {
    await dataSource.destroy();
  }
}

async function protectedState(dataSource) {
  const [result] = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM users) users,
    (SELECT count(*)::int FROM balances) balances,
    (SELECT coalesce(sum(ert_balance),0)::text FROM balances) ert,
    (SELECT coalesce(sum(eru_balance),0)::text FROM balances) eru,
    (SELECT count(*)::int FROM ledger_transactions) ledger,
    (SELECT count(*)::int FROM raffle_draws) legacy_draws,
    (SELECT count(*)::int FROM raffle_draw_results_v2) v2_draws,
    (SELECT count(*)::int FROM user_rewards) user_rewards,
    (SELECT count(*)::int FROM game_rings) rings,
    (SELECT count(*)::int FROM ring_events) ring_events`);
  return result;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
