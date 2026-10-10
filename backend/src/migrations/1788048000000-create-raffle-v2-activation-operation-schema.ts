import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRaffleV2ActivationOperationSchema1788048000000 implements MigrationInterface {
  name = 'CreateRaffleV2ActivationOperationSchema1788048000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NULL
          OR to_regclass('public.raffle_machines') IS NULL
          OR to_regclass('public.raffle_configurations') IS NULL
        THEN
          RAISE EXCEPTION 'Raffle v2 activation operations require existing v2 configuration schema'
            USING ERRCODE = '42P01';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TABLE "raffle_configuration_activation_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "machine_id" uuid NOT NULL,
        "target_configuration_id" uuid NOT NULL,
        "expected_active_configuration_id" uuid,
        "previous_active_configuration_id" uuid,
        "admin_user_id" uuid NOT NULL,
        "reason" varchar(512) NOT NULL,
        "idempotency_key" uuid NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "contract_version" varchar(32) NOT NULL,
        "status" varchar(16) NOT NULL,
        "response_snapshot" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_raffle_configuration_activation_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_raffle_configuration_activation_admin_key" UNIQUE ("admin_user_id", "idempotency_key"),
        CONSTRAINT "CHK_raffle_configuration_activation_reason" CHECK (length(btrim("reason")) > 0),
        CONSTRAINT "CHK_raffle_configuration_activation_key_v4" CHECK (
          "idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT "CHK_raffle_configuration_activation_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_raffle_configuration_activation_contract" CHECK ("contract_version" = 'raffle-admin-activation-v1'),
        CONSTRAINT "CHK_raffle_configuration_activation_status" CHECK ("status" IN ('PENDING', 'COMPLETED')),
        CONSTRAINT "CHK_raffle_configuration_activation_lifecycle" CHECK (
          ("status" = 'PENDING' AND "response_snapshot" IS NULL AND "completed_at" IS NULL)
          OR (
            "status" = 'COMPLETED'
            AND jsonb_typeof("response_snapshot") = 'object'
            AND "completed_at" IS NOT NULL
            AND "completed_at" >= "created_at"
          )
        ),
        CONSTRAINT "FK_raffle_configuration_activation_machine" FOREIGN KEY ("machine_id")
          REFERENCES "raffle_machines" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configuration_activation_target" FOREIGN KEY ("target_configuration_id")
          REFERENCES "raffle_configurations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configuration_activation_expected" FOREIGN KEY ("expected_active_configuration_id")
          REFERENCES "raffle_configurations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configuration_activation_previous" FOREIGN KEY ("previous_active_configuration_id")
          REFERENCES "raffle_configurations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_raffle_configuration_activation_admin" FOREIGN KEY ("admin_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "protect_raffle_configuration_activation_operation_v1"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR OLD."status" = 'COMPLETED'
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."machine_id" IS DISTINCT FROM OLD."machine_id"
          OR NEW."target_configuration_id" IS DISTINCT FROM OLD."target_configuration_id"
          OR NEW."expected_active_configuration_id" IS DISTINCT FROM OLD."expected_active_configuration_id"
          OR NEW."previous_active_configuration_id" IS DISTINCT FROM OLD."previous_active_configuration_id"
          OR NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
          OR NEW."reason" IS DISTINCT FROM OLD."reason"
          OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
          OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
          OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NOT (OLD."status" = 'PENDING' AND NEW."status" = 'COMPLETED')
        THEN
          RAISE EXCEPTION 'Raffle configuration activation operation is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_raffle_configuration_activation_operation_immutable"
      BEFORE UPDATE OR DELETE ON "raffle_configuration_activation_operations"
      FOR EACH ROW EXECUTE FUNCTION "protect_raffle_configuration_activation_operation_v1"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT count(*)::text AS count FROM "raffle_configuration_activation_operations"
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove Raffle v2 activation audit history');
    await queryRunner.query(`DROP TRIGGER "TRG_raffle_configuration_activation_operation_immutable"
      ON "raffle_configuration_activation_operations"`);
    await queryRunner.query(`DROP FUNCTION "protect_raffle_configuration_activation_operation_v1"()`);
    await queryRunner.query(`DROP TABLE "raffle_configuration_activation_operations"`);
  }
}
