import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { MobileCredential } from '../src/auth/mobile-credential.entity';
import { MobileRegistrationService } from '../src/auth/mobile-registration.service';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { Balance } from '../src/balance/balance.entity';
import { CopperRingBackfillService } from '../src/ring/copper-ring-backfill.service';
import { CopperRingEntitlementService } from '../src/ring/copper-ring-entitlement.service';
import { CopperRingInventoryService } from '../src/ring/copper-ring-inventory.service';
import { CopperInitialAttributes, CopperRingRandomService } from '../src/ring/copper-ring-random.service';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { EquippedRing } from '../src/ring/equipped-ring.entity';
import { CopperIssuanceReason, CopperVisualVariant, GameRing } from '../src/ring/game-ring.entity';
import { RingEvent } from '../src/ring/ring-event.entity';
import { CreateCopperRingSchema1787097600000 } from '../src/migrations/1787097600000-create-copper-ring-schema';
import { AdminCopperRingsService } from '../src/admin/admin-copper-rings.service';
import { CopperRingErrorCode } from '../src/ring/copper-ring-errors';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.slice(1).toLowerCase().includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}

class DeterministicRandom extends CopperRingRandomService {
  calls = 0;

  override generateAttributes(): CopperInitialAttributes {
    this.calls += 1;
    return { comfort: 2, charm: 20, quality: 7, luck: 11 };
  }

  override selectVisualVariant() {
    return CopperVisualVariant.Celtic;
  }
}

class QaCopperRingRepository extends CopperRingRepository {
  override findRaffleAwardForRing() {
    return Promise.resolve(null);
  }
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, MobileCredential, Balance, GameRing, EquippedRing, RingEvent],
});
const migration = new CreateCopperRingSchema1787097600000();
const userIds = Array.from(
  { length: 8 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let createdUsersTable = false;
  let createdBalancesTable = false;
  let createdCredentialsTable = false;

  try {
    for (const table of ['game_rings', 'equipped_rings', 'ring_events']) {
      if (await runner.hasTable(table)) throw new Error(`Disposable QA requires ${table} to be absent`);
    }
    if (!await runner.hasTable('users')) {
      createdUsersTable = true;
      await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await runner.query(`
        CREATE TABLE "users" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "telegram_id" varchar(64) NOT NULL,
          "username" varchar(64), "first_name" varchar(128), "last_name" varchar(128),
          "photo_url" varchar(512), "is_admin" boolean NOT NULL DEFAULT false,
          "last_login_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_users" PRIMARY KEY ("id"), CONSTRAINT "UQ_users_telegram_id" UNIQUE ("telegram_id")
        )
      `);
    }
    if (!await runner.hasTable('balances')) {
      createdBalancesTable = true;
      await runner.query(`
        CREATE TABLE "balances" (
          "user_id" uuid NOT NULL, "ert_balance" numeric(48,18) NOT NULL DEFAULT 0,
          "lifetime_earned_ert" numeric(48,18) NOT NULL DEFAULT 0,
          "lifetime_spent_ert" numeric(48,18) NOT NULL DEFAULT 0,
          "eru_balance" numeric(48,0) NOT NULL DEFAULT 0,
          "lifetime_earned_eru" numeric(48,0) NOT NULL DEFAULT 0,
          "lifetime_spent_eru" numeric(48,0) NOT NULL DEFAULT 0,
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_balances" PRIMARY KEY ("user_id"),
          CONSTRAINT "FK_balances_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
        )
      `);
    }
    if (!await runner.hasTable('mobile_credentials')) {
      createdCredentialsTable = true;
      await runner.query(`
        CREATE TABLE "mobile_credentials" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL,
          "username" varchar(64) NOT NULL, "password_hash" varchar(255) NOT NULL,
          "password_changed_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_mobile_credentials" PRIMARY KEY ("id"),
          CONSTRAINT "UQ_mobile_credentials_user" UNIQUE ("user_id"),
          CONSTRAINT "UQ_mobile_credentials_username" UNIQUE ("username"),
          CONSTRAINT "FK_mobile_credentials_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
        )
      `);
    }
    await migration.up(runner);
    await runner.query(`ALTER TABLE "game_rings"
      ADD COLUMN "unspent_attribute_points" integer NOT NULL DEFAULT 0`);
    for (const [index, id] of userIds.entries()) {
      await runner.query(`INSERT INTO "users" ("id", "telegram_id", "username", "first_name") VALUES ($1, $2, $3, $4)`,
        [id, `entitlement-qa-${id}`, `entitlement_qa_${index}`, `Entitlement QA ${index}`]);
    }

    const random = new DeterministicRandom();
    const service = new CopperRingEntitlementService(new QaCopperRingRepository(dataSource), random);
    const first = await service.ensureStarterCopper(userIds[0], CopperIssuanceReason.Registration);
    assert.equal(first.created, true);
    assert.deepEqual(pickRing(first.ring), {
      ownerUserId: userIds[0], level: 1, shine: 100, comfort: 2, charm: 20,
      quality: 7, luck: 11, visualVariantCode: CopperVisualVariant.Celtic,
      issuedReason: CopperIssuanceReason.Registration,
    });
    const retry = await service.ensureStarterCopper(userIds[0], CopperIssuanceReason.LazyEnsure);
    assert.equal(retry.created, false);
    assert.equal(retry.ring.id, first.ring.id);
    assert.equal(random.calls, 1);

    const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
      service.ensureStarterCopper(userIds[1], CopperIssuanceReason.LegacyBackfill)));
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.equal(new Set(concurrent.map((result) => result.ring.id)).size, 1);
    await assertCounts(userIds[1], { rings: 1, equipment: 1, events: 1 });

    await verifyPersistenceFailure(runner, service, userIds[2], 'game_rings', 'ring');
    await verifyPersistenceFailure(runner, service, userIds[3], 'equipped_rings', 'equipment');
    await verifyPersistenceFailure(runner, service, userIds[4], 'ring_events', 'event');

    const backfill = new CopperRingBackfillService(dataSource, service);
    assert.deepEqual(await backfill.summarize(), { totalUsers: 8, coveredUsers: 2, missingUsers: 6 });
    let interruptedCalls = 0;
    const interruptingEntitlement = {
      ensureStarterCopper: async (userId: string, reason: CopperIssuanceReason) => {
        interruptedCalls += 1;
        if (interruptedCalls === 4) throw new Error('forced backfill interruption');
        return service.ensureStarterCopper(userId, reason);
      },
    } as CopperRingEntitlementService;
    const interruptedBackfill = new CopperRingBackfillService(dataSource, interruptingEntitlement);
    await assert.rejects(() => interruptedBackfill.apply(1), /forced backfill interruption/);
    assert.deepEqual(await backfill.summarize(), { totalUsers: 8, coveredUsers: 3, missingUsers: 5 });

    const backfillResult = await backfill.apply(1);
    assert.deepEqual({
      created: backfillResult.created,
      existing: backfillResult.existing,
      processed: backfillResult.processed,
    }, { created: 5, existing: 3, processed: 8 });
    assert.deepEqual(await backfill.summarize(), { totalUsers: 8, coveredUsers: 8, missingUsers: 0 });
    const repeatedBackfill = await backfill.apply(2);
    assert.deepEqual({
      created: repeatedBackfill.created,
      existing: repeatedBackfill.existing,
      processed: repeatedBackfill.processed,
    }, { created: 0, existing: 8, processed: 8 });

    const inventory = new CopperRingInventoryService(new QaCopperRingRepository(dataSource), service);
    const owner = Object.assign(new User(), { id: userIds[0] });
    const eventsBeforeReads = await dataSource.getRepository(RingEvent).count();
    const inventoryResult = await inventory.listForOwner(owner);
    assert.equal(inventoryResult.rings.length, 1);
    assert.equal(inventoryResult.rings[0].id, first.ring.id);
    assert.equal(inventoryResult.rings[0].equipped, true);
    assert.equal('ownerUserId' in inventoryResult.rings[0], false);
    assert.equal((await inventory.getForOwner(owner, first.ring.id)).id, first.ring.id);
    const equippedResult = await inventory.getEquippedForOwner(owner);
    assert.equal(equippedResult.ring.id, first.ring.id);
    assert.equal(equippedResult.ring.equipped, true);
    assert.equal(Number.isNaN(Date.parse(equippedResult.equippedAt)), false);
    await assert.rejects(
      () => inventory.getForOwner(owner, concurrent[0].ring.id),
      (error) => {
        const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
        return exception.getStatus?.() === 404
          && (exception.getResponse?.() as { code?: string }).code === CopperRingErrorCode.NotFound;
      },
    );
    assert.equal(await dataSource.getRepository(RingEvent).count(), eventsBeforeReads);

    const adminRings = new AdminCopperRingsService(new QaCopperRingRepository(dataSource));
    const adminPage = await adminRings.list({ limit: 3, offset: 0 });
    assert.equal(adminPage.items.length, 3);
    assert.equal(adminPage.total, 8);
    assert.equal(adminPage.items.every((item) => item.equipment?.userId === item.owner.id), true);
    const adminSearch = await adminRings.list({ query: 'entitlement_qa_0', limit: 10, offset: 0 });
    assert.equal(adminSearch.total, 1);
    assert.equal(adminSearch.items[0].id, first.ring.id);
    assert.equal(adminSearch.items[0].owner.id, userIds[0]);
    assert.equal((await adminRings.list({ query: '%', limit: 10, offset: 0 })).total, 0);
    const adminDetail = await adminRings.detail(first.ring.id);
    assert.equal(adminDetail.ring.owner.id, userIds[0]);
    assert.equal(adminDetail.ring.equipment?.userId, userIds[0]);
    const adminEvents = await adminRings.events(first.ring.id, { limit: 10, offset: 0 });
    assert.equal(adminEvents.total, 1);
    assert.equal(adminEvents.items[0].ringId, first.ring.id);
    assert.equal(adminEvents.items[0].snapshot.ringId, first.ring.id);
    await assert.rejects(
      () => adminRings.detail(randomUUID()),
      (error) => {
        const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
        return exception.getStatus?.() === 404
          && (exception.getResponse?.() as { code?: string }).code === CopperRingErrorCode.NotFound;
      },
    );
    assert.equal(await dataSource.getRepository(RingEvent).count(), eventsBeforeReads);

    const registration = new MobileRegistrationService(dataSource, new PasswordHasherService(), service);
    const qaPassword = `Qa-${randomUUID()}`;
    const registrationRace = await Promise.allSettled(Array.from({ length: 2 }, () => registration.register({
      username: 'copper_registration_race',
      password: qaPassword,
      displayName: 'Copper Registration QA',
    })));
    assert.equal(registrationRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(registrationRace.filter((result) => result.status === 'rejected').length, 1);
    const rejectedRegistration = registrationRace.find((result) => result.status === 'rejected');
    assert.equal((rejectedRegistration as PromiseRejectedResult).reason.getStatus(), 409);
    const registrationRows = await dataSource.query<Array<{
      userCount: number;
      balanceCount: number;
      ringCount: number;
      equipmentCount: number;
      eventCount: number;
    }>>(`
      SELECT
        COUNT(DISTINCT u."id")::int AS "userCount",
        COUNT(DISTINCT b."user_id")::int AS "balanceCount",
        COUNT(DISTINCT r."id")::int AS "ringCount",
        COUNT(DISTINCT e."user_id")::int AS "equipmentCount",
        COUNT(DISTINCT re."id")::int AS "eventCount"
      FROM "mobile_credentials" mc
      JOIN "users" u ON u."id" = mc."user_id"
      LEFT JOIN "balances" b ON b."user_id" = u."id"
      LEFT JOIN "game_rings" r ON r."owner_user_id" = u."id"
      LEFT JOIN "equipped_rings" e ON e."user_id" = u."id" AND e."ring_id" = r."id"
      LEFT JOIN "ring_events" re ON re."owner_user_id" = u."id" AND re."ring_id" = r."id"
      WHERE mc."username" = 'copper_registration_race'
    `);
    assert.deepEqual(registrationRows[0], {
      userCount: 1,
      balanceCount: 1,
      ringCount: 1,
      equipmentCount: 1,
      eventCount: 1,
    });
    assert.deepEqual(await reconciliationCounts(), {
      usersWithoutExactlyOneStarter: 0,
      ringsWithoutOwnerSafeEquipment: 0,
      ringsWithoutExactlyOneStarterEvent: 0,
      invalidStarterSnapshots: 0,
    });

    console.log(JSON.stringify({
      deterministicGeneration: true,
      retryIdempotent: true,
      concurrentEnsureIdempotent: true,
      automaticEquipment: true,
      immutableIssuanceEvent: true,
      transactionRollbackAtRingBoundary: true,
      transactionRollbackAtEquipmentBoundary: true,
      transactionRollbackAtEventBoundary: true,
      interruptedBackfillCommittedPrefixOnly: true,
      resumableBackfill: true,
      repeatedBackfillIdempotent: true,
      concurrentRegistrationAtomic: true,
      ownerScopedInventoryReads: true,
      readOnlyEquippedRingState: true,
      inventoryReadsCreateNoAuditEvents: true,
      adminRingSearchAndAuditReads: true,
      adminRingReadsCreateNoAuditEvents: true,
      stableRingNotFoundCode: true,
      reconciliationAnomalies: 0,
    }, null, 2));
  } finally {
    if (await runner.hasTable('game_rings') && await runner.hasColumn('game_rings', 'unspent_attribute_points')) {
      await runner.query('ALTER TABLE "game_rings" DROP COLUMN "unspent_attribute_points"');
    }
    if (await runner.hasTable('ring_events')) await migration.down(runner);
    if (await runner.hasTable('mobile_credentials')) {
      await runner.query('DELETE FROM "mobile_credentials" WHERE "username" = $1', ['copper_registration_race']);
    }
    if (await runner.hasTable('balances')) {
      await runner.query(`DELETE FROM "balances" WHERE "user_id" IN (
        SELECT "id" FROM "users" WHERE "telegram_id" LIKE 'mobile:%'
      )`);
    }
    if (await runner.hasTable('users')) {
      await runner.query(`DELETE FROM "users" WHERE "telegram_id" LIKE 'mobile:%'`);
    }
    if (await runner.hasTable('users')) {
      await runner.query('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', [userIds]);
    }
    if (createdCredentialsTable && await runner.hasTable('mobile_credentials')) {
      await runner.query('DROP TABLE "mobile_credentials"');
    }
    if (createdBalancesTable && await runner.hasTable('balances')) await runner.query('DROP TABLE "balances"');
    if (createdUsersTable && await runner.hasTable('users')) await runner.query('DROP TABLE "users"');
    await runner.release();
    await dataSource.destroy();
  }
}

function pickRing(ring: GameRing) {
  const { ownerUserId, level, shine, comfort, charm, quality, luck, visualVariantCode, issuedReason } = ring;
  return { ownerUserId, level, shine, comfort, charm, quality, luck, visualVariantCode, issuedReason };
}

async function assertCounts(userId: string, expected: { rings: number; equipment: number; events: number }) {
  const [rings, equipment, events] = await Promise.all([
    dataSource.getRepository(GameRing).countBy({ ownerUserId: userId }),
    dataSource.getRepository(EquippedRing).countBy({ userId }),
    dataSource.getRepository(RingEvent).countBy({ ownerUserId: userId }),
  ]);
  assert.deepEqual({ rings, equipment, events }, expected);
}

async function verifyPersistenceFailure(
  runner: import('typeorm').QueryRunner,
  service: CopperRingEntitlementService,
  userId: string,
  table: 'game_rings' | 'equipped_rings' | 'ring_events',
  suffix: 'ring' | 'equipment' | 'event',
) {
  const functionName = `copper_qa_reject_${suffix}`;
  const triggerName = `TRG_copper_qa_reject_${suffix}`;
  await runner.query(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'forced ${suffix} failure'; END;
    $$ LANGUAGE plpgsql
  `);
  await runner.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${table}"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
  try {
    await assert.rejects(
      () => service.ensureStarterCopper(userId, CopperIssuanceReason.LegacyBackfill),
      new RegExp(`forced ${suffix} failure`),
    );
    await assertCounts(userId, { rings: 0, equipment: 0, events: 0 });
  } finally {
    await runner.query(`DROP TRIGGER "${triggerName}" ON "${table}"`);
    await runner.query(`DROP FUNCTION "${functionName}"()`);
  }
}

async function reconciliationCounts() {
  const [starterCoverage, equipment, events, snapshots] = await Promise.all([
    dataSource.query<Array<{ count: number }>>(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT u."id" FROM "users" u
        LEFT JOIN "game_rings" r ON r."owner_user_id" = u."id"
          AND r."entitlement_code" = 'starter-copper-v1'
        GROUP BY u."id" HAVING COUNT(r."id") <> 1
      ) anomalies
    `),
    dataSource.query<Array<{ count: number }>>(`
      SELECT COUNT(*)::int AS count FROM "game_rings" r
      LEFT JOIN "equipped_rings" e ON e."ring_id" = r."id" AND e."user_id" = r."owner_user_id"
      WHERE e."ring_id" IS NULL
    `),
    dataSource.query<Array<{ count: number }>>(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT r."id" FROM "game_rings" r
        LEFT JOIN "ring_events" re ON re."ring_id" = r."id" AND re."event_type" = 'STARTER_ISSUED'
        GROUP BY r."id" HAVING COUNT(re."id") <> 1
      ) anomalies
    `),
    dataSource.query<Array<{ count: number }>>(`
      SELECT COUNT(*)::int AS count
      FROM "game_rings" r
      JOIN "ring_events" re ON re."ring_id" = r."id" AND re."event_type" = 'STARTER_ISSUED'
      WHERE re."owner_user_id" <> r."owner_user_id"
        OR re."snapshot"->>'ringId' <> r."id"::text
        OR re."snapshot"->>'ownerUserId' <> r."owner_user_id"::text
        OR re."snapshot"->>'entitlementCode' <> r."entitlement_code"
        OR re."snapshot"->>'visualVariantCode' <> r."visual_variant_code"
        OR re."snapshot"->>'equipped' <> 'true'
    `),
  ]);
  return {
    usersWithoutExactlyOneStarter: starterCoverage[0].count,
    ringsWithoutOwnerSafeEquipment: equipment[0].count,
    ringsWithoutExactlyOneStarterEvent: events[0].count,
    invalidStarterSnapshots: snapshots[0].count,
  };
}

void main();
