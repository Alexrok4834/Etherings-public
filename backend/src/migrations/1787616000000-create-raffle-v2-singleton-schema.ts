import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRaffleV2SingletonSchema1787616000000 implements MigrationInterface {
  name = 'CreateRaffleV2SingletonSchema1787616000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NULL OR to_regclass('public.rewards') IS NULL THEN
          RAISE EXCEPTION 'raffle v2 requires existing users and rewards tables' USING ERRCODE = '42P01';
        END IF;
      END
      $$
    `);
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(`
      CREATE TABLE "raffle_machines" (
        "singleton_key" smallint NOT NULL DEFAULT 1,
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" varchar(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_raffle_machines" PRIMARY KEY ("singleton_key"),
        CONSTRAINT "UQ_raffle_machines_id" UNIQUE ("id"),
        CONSTRAINT "UQ_raffle_machines_code" UNIQUE ("code"),
        CONSTRAINT "CHK_raffle_machines_singleton" CHECK ("singleton_key" = 1),
        CONSTRAINT "CHK_raffle_machines_code" CHECK (length(btrim("code")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "raffle_v2_protect_machine_v1"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'raffle machine identity is immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_v2_machine_immutable"
      BEFORE UPDATE OR DELETE ON "raffle_machines"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_protect_machine_v1"()
    `);

    await queryRunner.query(`
      CREATE TABLE "raffle_configurations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "machine_id" uuid NOT NULL,
        "contract_version" varchar(32) NOT NULL,
        "status" varchar(16) NOT NULL,
        "title" varchar(128) NOT NULL,
        "description" text,
        "cost_ert" numeric(48,18) NOT NULL,
        "daily_user_attempt_limit" smallint NOT NULL,
        "created_by_user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "activated_at" TIMESTAMP WITH TIME ZONE,
        "disabled_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_raffle_configurations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_raffle_configurations_contract" CHECK ("contract_version" = 'raffle-v2'),
        CONSTRAINT "CHK_raffle_configurations_status" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DISABLED')),
        CONSTRAINT "CHK_raffle_configurations_title" CHECK (length(btrim("title")) > 0),
        CONSTRAINT "CHK_raffle_configurations_cost" CHECK ("cost_ert" > 0),
        CONSTRAINT "CHK_raffle_configurations_attempt_limit" CHECK ("daily_user_attempt_limit" > 0),
        CONSTRAINT "CHK_raffle_configurations_lifecycle_timestamps" CHECK (
          ("status" = 'DRAFT' AND "activated_at" IS NULL AND "disabled_at" IS NULL)
          OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "disabled_at" IS NULL)
          OR (
            "status" = 'DISABLED'
            AND "activated_at" IS NOT NULL
            AND "disabled_at" IS NOT NULL
            AND "disabled_at" >= "activated_at"
          )
        ),
        CONSTRAINT "FK_raffle_configurations_machine" FOREIGN KEY ("machine_id")
          REFERENCES "raffle_machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configurations_creator" FOREIGN KEY ("created_by_user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_raffle_configurations_active_machine"
      ON "raffle_configurations" ("machine_id") WHERE "status" = 'ACTIVE'
    `);

    await queryRunner.query(`
      CREATE TABLE "raffle_configuration_rewards" (
        "configuration_id" uuid NOT NULL,
        "reward_id" uuid NOT NULL,
        "segment_index" smallint NOT NULL,
        "weight" integer NOT NULL,
        "reward_snapshot" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_raffle_configuration_rewards" PRIMARY KEY ("configuration_id", "reward_id"),
        CONSTRAINT "UQ_raffle_configuration_rewards_segment" UNIQUE ("configuration_id", "segment_index"),
        CONSTRAINT "CHK_raffle_configuration_rewards_segment" CHECK ("segment_index" >= 0),
        CONSTRAINT "CHK_raffle_configuration_rewards_weight" CHECK ("weight" > 0),
        CONSTRAINT "CHK_raffle_configuration_rewards_snapshot"
          CHECK (jsonb_typeof("reward_snapshot") = 'object'),
        CONSTRAINT "FK_raffle_configuration_rewards_configuration" FOREIGN KEY ("configuration_id")
          REFERENCES "raffle_configurations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configuration_rewards_reward" FOREIGN KEY ("reward_id")
          REFERENCES "rewards"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "raffle_v2_guard_configuration_reward_v1"() RETURNS trigger AS $$
      DECLARE
        old_status varchar(16);
        new_status varchar(16);
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          SELECT "status" INTO old_status FROM "raffle_configurations"
          WHERE "id" = OLD."configuration_id";
          IF old_status IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'raffle configuration rewards are immutable after activation'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          SELECT "status" INTO new_status FROM "raffle_configurations"
          WHERE "id" = NEW."configuration_id";
          IF new_status IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'raffle configuration rewards require a draft configuration'
              USING ERRCODE = '23514';
          END IF;
          IF TG_OP = 'UPDATE' AND NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
            RAISE EXCEPTION 'raffle configuration reward creation time is immutable'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_v2_configuration_reward_guard"
      BEFORE INSERT OR UPDATE OR DELETE ON "raffle_configuration_rewards"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_guard_configuration_reward_v1"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "raffle_v2_guard_configuration_v1"() RETURNS trigger AS $$
      DECLARE
        reward_count bigint;
        min_segment integer;
        max_segment integer;
        total_weight bigint;
        all_rewards_active boolean;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'raffle configuration must be created as draft' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'raffle configuration history cannot be deleted' USING ERRCODE = '23514';
        END IF;

        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."machine_id" IS DISTINCT FROM OLD."machine_id"
          OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
          OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        THEN
          RAISE EXCEPTION 'raffle configuration identity is immutable' USING ERRCODE = '23514';
        END IF;

        IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
          RETURN NEW;
        END IF;

        IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
          PERFORM 1 FROM "raffle_machines" WHERE "id" = NEW."machine_id" FOR UPDATE;
          SELECT count(*), min(mapping."segment_index"), max(mapping."segment_index"),
            COALESCE(sum(mapping."weight"), 0), COALESCE(bool_and(reward."is_active"), false)
          INTO reward_count, min_segment, max_segment, total_weight, all_rewards_active
          FROM "raffle_configuration_rewards" mapping
          JOIN "rewards" reward ON reward."id" = mapping."reward_id"
          WHERE mapping."configuration_id" = NEW."id";

          IF reward_count = 0
            OR min_segment <> 0
            OR max_segment <> reward_count - 1
            OR total_weight > 2147483647
            OR NOT all_rewards_active
          THEN
            RAISE EXCEPTION 'raffle configuration reward mapping is not activatable'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF OLD."status" = 'ACTIVE' AND NEW."status" = 'DISABLED' THEN
          IF NEW."title" IS DISTINCT FROM OLD."title"
            OR NEW."description" IS DISTINCT FROM OLD."description"
            OR NEW."cost_ert" IS DISTINCT FROM OLD."cost_ert"
            OR NEW."daily_user_attempt_limit" IS DISTINCT FROM OLD."daily_user_attempt_limit"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
          THEN
            RAISE EXCEPTION 'active raffle configuration economics are immutable'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        RAISE EXCEPTION 'invalid raffle configuration lifecycle transition' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_v2_configuration_guard"
      BEFORE INSERT OR UPDATE OR DELETE ON "raffle_configurations"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_guard_configuration_v1"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT (
        (SELECT count(*) FROM "raffle_machines")
        + (SELECT count(*) FROM "raffle_configurations")
        + (SELECT count(*) FROM "raffle_configuration_rewards")
      )::text AS count
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove raffle v2 singleton schema while v2 rows exist');

    await queryRunner.query(
      'DROP TRIGGER "TRG_raffle_v2_configuration_guard" ON "raffle_configurations"',
    );
    await queryRunner.query('DROP FUNCTION "raffle_v2_guard_configuration_v1"()');
    await queryRunner.query(
      'DROP TRIGGER "TRG_raffle_v2_configuration_reward_guard" ON "raffle_configuration_rewards"',
    );
    await queryRunner.query('DROP FUNCTION "raffle_v2_guard_configuration_reward_v1"()');
    await queryRunner.query('DROP TABLE "raffle_configuration_rewards"');
    await queryRunner.query('DROP TABLE "raffle_configurations"');
    await queryRunner.query(
      'DROP TRIGGER "TRG_raffle_v2_machine_immutable" ON "raffle_machines"',
    );
    await queryRunner.query('DROP FUNCTION "raffle_v2_protect_machine_v1"()');
    await queryRunner.query('DROP TABLE "raffle_machines"');
  }
}
