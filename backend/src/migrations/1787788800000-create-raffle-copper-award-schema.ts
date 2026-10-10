import { MigrationInterface, QueryRunner } from 'typeorm';

const rewardTypesBefore = "'ERT', 'ERU', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER'";
const rewardTypesAfter = "'ERT', 'ERU', 'COPPER_RING', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER'";

export class CreateRaffleCopperAwardSchema1787788800000 implements MigrationInterface {
  name = 'CreateRaffleCopperAwardSchema1787788800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.game_rings') IS NULL
          OR to_regclass('public.ring_events') IS NULL
          OR to_regclass('public.raffle_draw_results_v2') IS NULL
          OR to_regclass('public.user_rewards') IS NULL
        THEN
          RAISE EXCEPTION 'raffle Copper award schema requires Ring and raffle v2 evidence prerequisites'
            USING ERRCODE = '42P01';
        END IF;

        IF EXISTS (
          SELECT 1 FROM "game_rings"
          WHERE "entitlement_code" <> 'starter-copper-v1'
            OR "issued_reason" NOT IN ('REGISTRATION', 'LEGACY_BACKFILL', 'LAZY_ENSURE')
        ) THEN
          RAISE EXCEPTION 'existing Ring provenance is incompatible with raffle Copper widening'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);

    await this.dropEruTypeConstraints(queryRunner);
    await this.replaceEnum(queryRunner, 'rewards', 'rewards_type_enum', rewardTypesAfter);
    await this.replaceEnum(queryRunner, 'user_rewards', 'user_rewards_type_enum', rewardTypesAfter);
    await this.addEruTypeConstraints(queryRunner);
    await queryRunner.query(`ALTER TABLE "rewards" ADD CONSTRAINT "CHK_rewards_copper_ring_shape" CHECK (
      "type"::text <> 'COPPER_RING' OR ("amount" IS NULL AND "amount_exact" IS NULL AND "stock_total" IS NULL AND "stock_remaining" IS NULL)
    )`);

    await queryRunner.query(`ALTER TABLE "game_rings" DROP CONSTRAINT "CHK_game_rings_entitlement"`);
    await queryRunner.query(`ALTER TABLE "game_rings" DROP CONSTRAINT "CHK_game_rings_issued_reason"`);
    await queryRunner.query(`ALTER TABLE "game_rings" ADD CONSTRAINT "CHK_game_rings_entitlement" CHECK (
      "entitlement_code" = 'starter-copper-v1'
      OR "entitlement_code" ~ '^raffle-copper-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )`);
    await queryRunner.query(`ALTER TABLE "game_rings" ADD CONSTRAINT "CHK_game_rings_issued_reason" CHECK (
      "issued_reason" IN ('REGISTRATION', 'LEGACY_BACKFILL', 'LAZY_ENSURE', 'RAFFLE')
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_game_rings_raffle_entitlement"
      ON "game_rings" ("entitlement_code") WHERE "issued_reason" = 'RAFFLE'`);

    await queryRunner.query(`ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"`);
    await queryRunner.query(`ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type" CHECK (
      "event_type" IN ('STARTER_ISSUED', 'LEVEL_UP', 'ATTRIBUTE_POINTS_ALLOCATED', 'RAFFLE_AWARDED')
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ring_events_raffle_awarded"
      ON "ring_events" ("ring_id") WHERE "event_type" = 'RAFFLE_AWARDED'`);
    await queryRunner.query(`ALTER TABLE "ring_events" ADD CONSTRAINT "UQ_ring_events_award_identity"
      UNIQUE ("id", "ring_id", "owner_user_id")`);

    await queryRunner.query(`ALTER TABLE "raffle_draw_results_v2" ADD CONSTRAINT "UQ_raffle_draw_results_v2_owner_reward"
      UNIQUE ("id", "owner_user_id", "selected_reward_id")`);
    await queryRunner.query(`ALTER TABLE "raffle_draw_results_v2" ADD CONSTRAINT "UQ_raffle_draw_results_v2_award_identity"
      UNIQUE ("id", "operation_id", "owner_user_id", "selected_reward_id")`);

    await queryRunner.query(`ALTER TABLE "user_rewards" ALTER COLUMN "raffle_draw_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD COLUMN "raffle_draw_result_v2_id" uuid`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_source" CHECK (
      ("raffle_draw_id" IS NOT NULL)::integer + ("raffle_draw_result_v2_id" IS NOT NULL)::integer = 1
    )`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_copper_ring_shape" CHECK (
      "type"::text <> 'COPPER_RING' OR ("amount" IS NULL AND "amount_exact" IS NULL AND "eru_balance_after" IS NULL)
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_user_rewards_raffle_draw_result_v2"
      ON "user_rewards" ("raffle_draw_result_v2_id") WHERE "raffle_draw_result_v2_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "FK_user_rewards_raffle_draw_result_v2_owner_reward"
      FOREIGN KEY ("raffle_draw_result_v2_id", "user_id", "reward_id")
      REFERENCES "raffle_draw_results_v2" ("id", "owner_user_id", "selected_reward_id")
      ON DELETE RESTRICT ON UPDATE NO ACTION`);

    await queryRunner.query(`
      CREATE TABLE "raffle_ring_awards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "operation_id" uuid NOT NULL,
        "draw_result_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "reward_id" uuid NOT NULL,
        "ring_id" uuid NOT NULL,
        "ring_event_id" uuid NOT NULL,
        "award_utc_date" date NOT NULL,
        "fulfillment_version" varchar(64) NOT NULL,
        "ruleset_version" varchar(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_raffle_ring_awards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_raffle_ring_awards_operation" UNIQUE ("operation_id"),
        CONSTRAINT "UQ_raffle_ring_awards_draw_result" UNIQUE ("draw_result_id"),
        CONSTRAINT "UQ_raffle_ring_awards_ring" UNIQUE ("ring_id"),
        CONSTRAINT "UQ_raffle_ring_awards_event" UNIQUE ("ring_event_id"),
        CONSTRAINT "UQ_raffle_ring_awards_owner_day" UNIQUE ("owner_user_id", "award_utc_date"),
        CONSTRAINT "CHK_raffle_ring_awards_fulfillment_version" CHECK ("fulfillment_version" = 'raffle-copper-fulfillment-v1'),
        CONSTRAINT "CHK_raffle_ring_awards_ruleset_version" CHECK ("ruleset_version" = 'copper-rules-v1'),
        CONSTRAINT "FK_raffle_ring_awards_operation" FOREIGN KEY ("operation_id")
          REFERENCES "raffle_draw_operations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_ring_awards_result_identity" FOREIGN KEY
          ("draw_result_id", "operation_id", "owner_user_id", "reward_id")
          REFERENCES "raffle_draw_results_v2" ("id", "operation_id", "owner_user_id", "selected_reward_id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_ring_awards_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_ring_awards_reward" FOREIGN KEY ("reward_id")
          REFERENCES "rewards" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_ring_awards_ring_owner" FOREIGN KEY ("ring_id", "owner_user_id")
          REFERENCES "game_rings" ("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_ring_awards_event_identity" FOREIGN KEY ("ring_event_id", "ring_id", "owner_user_id")
          REFERENCES "ring_events" ("id", "ring_id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "reject_raffle_ring_award_mutation"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'raffle Ring awards are append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE TRIGGER "TRG_raffle_ring_awards_append_only"
      BEFORE UPDATE OR DELETE ON "raffle_ring_awards"
      FOR EACH ROW EXECUTE FUNCTION "reject_raffle_ring_award_mutation"()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT (
        (SELECT count(*) FROM "raffle_ring_awards")
        + (SELECT count(*) FROM "game_rings" WHERE "issued_reason" = 'RAFFLE')
        + (SELECT count(*) FROM "ring_events" WHERE "event_type" = 'RAFFLE_AWARDED')
        + (SELECT count(*) FROM "user_rewards" WHERE "raffle_draw_result_v2_id" IS NOT NULL OR "type"::text = 'COPPER_RING')
        + (SELECT count(*) FROM "rewards" WHERE "type"::text = 'COPPER_RING')
      )::text AS count
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove raffle Copper award schema while Copper award data exists');

    await queryRunner.query(`DROP TRIGGER "TRG_raffle_ring_awards_append_only" ON "raffle_ring_awards"`);
    await queryRunner.query(`DROP FUNCTION "reject_raffle_ring_award_mutation"()`);
    await queryRunner.query(`DROP TABLE "raffle_ring_awards"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "FK_user_rewards_raffle_draw_result_v2_owner_reward"`);
    await queryRunner.query(`DROP INDEX "UQ_user_rewards_raffle_draw_result_v2"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_copper_ring_shape"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_source"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP COLUMN "raffle_draw_result_v2_id"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ALTER COLUMN "raffle_draw_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "raffle_draw_results_v2" DROP CONSTRAINT "UQ_raffle_draw_results_v2_award_identity"`);
    await queryRunner.query(`ALTER TABLE "raffle_draw_results_v2" DROP CONSTRAINT "UQ_raffle_draw_results_v2_owner_reward"`);
    await queryRunner.query(`ALTER TABLE "ring_events" DROP CONSTRAINT "UQ_ring_events_award_identity"`);
    await queryRunner.query(`DROP INDEX "UQ_ring_events_raffle_awarded"`);
    await queryRunner.query(`ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"`);
    await queryRunner.query(`ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type" CHECK (
      "event_type" IN ('STARTER_ISSUED', 'LEVEL_UP', 'ATTRIBUTE_POINTS_ALLOCATED')
    )`);
    await queryRunner.query(`DROP INDEX "UQ_game_rings_raffle_entitlement"`);
    await queryRunner.query(`ALTER TABLE "game_rings" DROP CONSTRAINT "CHK_game_rings_issued_reason"`);
    await queryRunner.query(`ALTER TABLE "game_rings" DROP CONSTRAINT "CHK_game_rings_entitlement"`);
    await queryRunner.query(`ALTER TABLE "game_rings" ADD CONSTRAINT "CHK_game_rings_entitlement" CHECK (
      "entitlement_code" = 'starter-copper-v1'
    )`);
    await queryRunner.query(`ALTER TABLE "game_rings" ADD CONSTRAINT "CHK_game_rings_issued_reason" CHECK (
      "issued_reason" IN ('REGISTRATION', 'LEGACY_BACKFILL', 'LAZY_ENSURE')
    )`);
    await queryRunner.query(`ALTER TABLE "rewards" DROP CONSTRAINT "CHK_rewards_copper_ring_shape"`);
    await this.dropEruTypeConstraints(queryRunner);
    await this.replaceEnum(queryRunner, 'rewards', 'rewards_type_enum', rewardTypesBefore);
    await this.replaceEnum(queryRunner, 'user_rewards', 'user_rewards_type_enum', rewardTypesBefore);
    await this.addEruTypeConstraints(queryRunner);
  }

  private async dropEruTypeConstraints(queryRunner: QueryRunner) {
    await queryRunner.query(`ALTER TABLE "rewards" DROP CONSTRAINT "CHK_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_amount_exact"`);
  }

  private async addEruTypeConstraints(queryRunner: QueryRunner) {
    await queryRunner.query(`ALTER TABLE "rewards" ADD CONSTRAINT "CHK_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0
        AND trunc("amount_exact") = "amount_exact"))`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0
        AND trunc("amount_exact") = "amount_exact"))`);
  }

  private async replaceEnum(queryRunner: QueryRunner, table: string, enumName: string, values: string) {
    const previousEnumName = `${enumName}_before_copper`;
    await queryRunner.query(`ALTER TYPE "public"."${enumName}" RENAME TO "${previousEnumName}"`);
    await queryRunner.query(`CREATE TYPE "public"."${enumName}" AS ENUM (${values})`);
    await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "type" TYPE "public"."${enumName}"
      USING "type"::text::"public"."${enumName}"`);
    await queryRunner.query(`DROP TYPE "public"."${previousEnumName}"`);
  }
}
