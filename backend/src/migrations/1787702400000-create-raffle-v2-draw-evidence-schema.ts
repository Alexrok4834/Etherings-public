import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRaffleV2DrawEvidenceSchema1787702400000 implements MigrationInterface {
  name = 'CreateRaffleV2DrawEvidenceSchema1787702400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NULL
          OR to_regclass('public.rewards') IS NULL
          OR to_regclass('public.raffle_machines') IS NULL
          OR to_regclass('public.raffle_configurations') IS NULL
          OR to_regclass('public.raffle_configuration_rewards') IS NULL
        THEN
          RAISE EXCEPTION 'raffle v2 draw evidence requires singleton schema prerequisites'
            USING ERRCODE = '42P01';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE "raffle_draw_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_user_id" uuid NOT NULL,
        "idempotency_key" uuid NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "contract_version" varchar(32) NOT NULL,
        "configuration_id" uuid NOT NULL,
        "status" varchar(16) NOT NULL,
        "response_snapshot" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_raffle_draw_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_raffle_draw_operations_owner_key" UNIQUE ("owner_user_id", "idempotency_key"),
        CONSTRAINT "CHK_raffle_draw_operations_idempotency_v4" CHECK (
          "idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT "CHK_raffle_draw_operations_fingerprint" CHECK (
          "request_fingerprint" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_raffle_draw_operations_contract" CHECK ("contract_version" = 'raffle-v2'),
        CONSTRAINT "CHK_raffle_draw_operations_status" CHECK ("status" IN ('PENDING', 'COMPLETED')),
        CONSTRAINT "CHK_raffle_draw_operations_lifecycle" CHECK (
          ("status" = 'PENDING' AND "response_snapshot" IS NULL AND "completed_at" IS NULL)
          OR (
            "status" = 'COMPLETED'
            AND "response_snapshot" IS NOT NULL
            AND jsonb_typeof("response_snapshot") = 'object'
            AND "completed_at" IS NOT NULL
            AND "completed_at" >= "created_at"
          )
        ),
        CONSTRAINT "CHK_raffle_draw_operations_updated_at" CHECK ("updated_at" >= "created_at"),
        CONSTRAINT "FK_raffle_draw_operations_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_draw_operations_configuration" FOREIGN KEY ("configuration_id")
          REFERENCES "raffle_configurations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "raffle_draw_results_v2" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "operation_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "configuration_id" uuid NOT NULL,
        "selected_reward_id" uuid NOT NULL,
        "selected_segment_index" smallint NOT NULL,
        "algorithm" varchar(64) NOT NULL,
        "ticket" integer NOT NULL,
        "total_weight" integer NOT NULL,
        "ranges_snapshot" jsonb NOT NULL,
        "cost_ert" numeric(48,18) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_raffle_draw_results_v2" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_raffle_draw_results_v2_operation" UNIQUE ("operation_id"),
        CONSTRAINT "CHK_raffle_draw_results_v2_algorithm" CHECK (
          "algorithm" = 'CSPRNG_UNBIASED_INT_V1'
        ),
        CONSTRAINT "CHK_raffle_draw_results_v2_ticket" CHECK (
          "ticket" >= 0 AND "total_weight" > 0 AND "ticket" < "total_weight"
        ),
        CONSTRAINT "CHK_raffle_draw_results_v2_segment" CHECK ("selected_segment_index" >= 0),
        CONSTRAINT "CHK_raffle_draw_results_v2_ranges" CHECK (
          jsonb_typeof("ranges_snapshot") = 'object'
        ),
        CONSTRAINT "CHK_raffle_draw_results_v2_cost" CHECK ("cost_ert" > 0),
        CONSTRAINT "FK_raffle_draw_results_v2_operation" FOREIGN KEY ("operation_id")
          REFERENCES "raffle_draw_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_draw_results_v2_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_draw_results_v2_machine" FOREIGN KEY ("machine_id")
          REFERENCES "raffle_machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_draw_results_v2_configuration" FOREIGN KEY ("configuration_id")
          REFERENCES "raffle_configurations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_draw_results_v2_reward" FOREIGN KEY ("selected_reward_id")
          REFERENCES "rewards"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_raffle_draw_results_v2_owner_history"
      ON "raffle_draw_results_v2" ("owner_user_id", "created_at", "id")
    `);

    await queryRunner.query(`
      CREATE FUNCTION "raffle_v2_guard_draw_result_v1"() RETURNS trigger AS $$
      DECLARE
        operation_owner uuid;
        operation_configuration uuid;
        operation_status varchar(16);
        configuration_machine uuid;
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          RAISE EXCEPTION 'raffle draw result evidence is immutable' USING ERRCODE = '23514';
        END IF;

        SELECT "owner_user_id", "configuration_id", "status"
        INTO operation_owner, operation_configuration, operation_status
        FROM "raffle_draw_operations"
        WHERE "id" = NEW."operation_id";

        IF operation_status IS DISTINCT FROM 'PENDING'
          OR operation_owner IS DISTINCT FROM NEW."owner_user_id"
          OR operation_configuration IS DISTINCT FROM NEW."configuration_id"
        THEN
          RAISE EXCEPTION 'raffle draw result does not match pending operation'
            USING ERRCODE = '23514';
        END IF;

        SELECT "machine_id" INTO configuration_machine
        FROM "raffle_configurations"
        WHERE "id" = NEW."configuration_id";
        IF configuration_machine IS DISTINCT FROM NEW."machine_id" THEN
          RAISE EXCEPTION 'raffle draw result does not match configuration machine'
            USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM "raffle_configuration_rewards"
          WHERE "configuration_id" = NEW."configuration_id"
            AND "reward_id" = NEW."selected_reward_id"
            AND "segment_index" = NEW."selected_segment_index"
        ) THEN
          RAISE EXCEPTION 'raffle draw result does not match configuration reward segment'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_v2_draw_result_guard"
      BEFORE INSERT OR UPDATE OR DELETE ON "raffle_draw_results_v2"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_guard_draw_result_v1"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "raffle_v2_guard_draw_operation_v1"() RETURNS trigger AS $$
      DECLARE
        configuration_status varchar(16);
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW."status" <> 'PENDING' THEN
            RAISE EXCEPTION 'raffle draw operation must be created pending' USING ERRCODE = '23514';
          END IF;
          SELECT "status" INTO configuration_status
          FROM "raffle_configurations" WHERE "id" = NEW."configuration_id";
          IF configuration_status IS DISTINCT FROM 'ACTIVE' THEN
            RAISE EXCEPTION 'raffle draw operation requires active configuration'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'raffle draw operation history cannot be deleted' USING ERRCODE = '23514';
        END IF;

        IF OLD."status" <> 'PENDING' OR NEW."status" <> 'COMPLETED'
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
          OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
          OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
          OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
          OR NEW."configuration_id" IS DISTINCT FROM OLD."configuration_id"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        THEN
          RAISE EXCEPTION 'invalid raffle draw operation lifecycle transition'
            USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM "raffle_draw_results_v2" WHERE "operation_id" = NEW."id"
        ) THEN
          RAISE EXCEPTION 'completed raffle draw operation requires result evidence'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_v2_draw_operation_guard"
      BEFORE INSERT OR UPDATE OR DELETE ON "raffle_draw_operations"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_guard_draw_operation_v1"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT (
        (SELECT count(*) FROM "raffle_draw_operations")
        + (SELECT count(*) FROM "raffle_draw_results_v2")
      )::text AS count
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove raffle v2 draw evidence schema while rows exist');

    await queryRunner.query(
      'DROP TRIGGER "TRG_raffle_v2_draw_operation_guard" ON "raffle_draw_operations"',
    );
    await queryRunner.query('DROP FUNCTION "raffle_v2_guard_draw_operation_v1"()');
    await queryRunner.query(
      'DROP TRIGGER "TRG_raffle_v2_draw_result_guard" ON "raffle_draw_results_v2"',
    );
    await queryRunner.query('DROP FUNCTION "raffle_v2_guard_draw_result_v1"()');
    await queryRunner.query('DROP TABLE "raffle_draw_results_v2"');
    await queryRunner.query('DROP TABLE "raffle_draw_operations"');
  }
}
