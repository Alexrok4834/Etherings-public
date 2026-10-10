import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProtectActiveRaffleV2Rewards1787961600000 implements MigrationInterface {
  name = 'ProtectActiveRaffleV2Rewards1787961600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.rewards') IS NULL
          OR to_regclass('public.raffle_configurations') IS NULL
          OR to_regclass('public.raffle_configuration_rewards') IS NULL
        THEN
          RAISE EXCEPTION 'Active Raffle v2 reward protection requires raffle v2 prerequisites'
            USING ERRCODE = '42P01';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION "protect_active_raffle_v2_reward"() RETURNS trigger AS $$
      DECLARE
        active_reference boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM "raffle_configuration_rewards" mapping
          INNER JOIN "raffle_configurations" configuration
            ON configuration."id" = mapping."configuration_id"
          WHERE mapping."reward_id" = OLD."id"
            AND configuration."status" = 'ACTIVE'
        ) INTO active_reference;

        IF NOT active_reference THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Active Raffle v2 rewards are immutable'
            USING ERRCODE = '23514';
        END IF;

        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."code" IS DISTINCT FROM OLD."code"
          OR NEW."title" IS DISTINCT FROM OLD."title"
          OR NEW."description" IS DISTINCT FROM OLD."description"
          OR NEW."type" IS DISTINCT FROM OLD."type"
          OR NEW."amount" IS DISTINCT FROM OLD."amount"
          OR NEW."amount_exact" IS DISTINCT FROM OLD."amount_exact"
          OR NEW."metadata" IS DISTINCT FROM OLD."metadata"
          OR NEW."image_url" IS DISTINCT FROM OLD."image_url"
          OR NEW."is_active" IS DISTINCT FROM OLD."is_active"
          OR NEW."stock_total" IS DISTINCT FROM OLD."stock_total"
          OR NEW."per_user_limit" IS DISTINCT FROM OLD."per_user_limit"
          OR NEW."daily_global_limit" IS DISTINCT FROM OLD."daily_global_limit"
          OR (OLD."stock_remaining" IS NULL AND NEW."stock_remaining" IS NOT NULL)
          OR (OLD."stock_remaining" IS NOT NULL AND NEW."stock_remaining" IS NULL)
          OR NEW."stock_remaining" > OLD."stock_remaining"
        THEN
          RAISE EXCEPTION 'Active Raffle v2 rewards are immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "TRG_rewards_protect_active_raffle_v2"
      BEFORE UPDATE OR DELETE ON "rewards"
      FOR EACH ROW EXECUTE FUNCTION "protect_active_raffle_v2_reward"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "TRG_rewards_protect_active_raffle_v2" ON "rewards"`);
    await queryRunner.query(`DROP FUNCTION "protect_active_raffle_v2_reward"()`);
  }
}
