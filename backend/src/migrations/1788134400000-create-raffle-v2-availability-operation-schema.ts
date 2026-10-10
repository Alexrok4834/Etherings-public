import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRaffleV2AvailabilityOperationSchema1788134400000 implements MigrationInterface {
  name = 'CreateRaffleV2AvailabilityOperationSchema1788134400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "raffle_machines"
      ADD COLUMN "is_available" boolean NOT NULL DEFAULT true,
      ADD COLUMN "paused_at" TIMESTAMP WITH TIME ZONE,
      ADD CONSTRAINT "CHK_raffle_machines_availability" CHECK (
        ("is_available" AND "paused_at" IS NULL) OR (NOT "is_available" AND "paused_at" IS NOT NULL)
      )`);
    await queryRunner.query(`DROP TRIGGER "TRG_raffle_v2_machine_immutable" ON "raffle_machines"`);
    await queryRunner.query(`DROP FUNCTION "raffle_v2_protect_machine_v1"()`);
    await queryRunner.query(`CREATE FUNCTION "raffle_v2_protect_machine_v2"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR NEW."singleton_key" IS DISTINCT FROM OLD."singleton_key"
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."code" IS DISTINCT FROM OLD."code"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."is_available" IS NOT DISTINCT FROM OLD."is_available"
          OR (NEW."is_available" AND NEW."paused_at" IS NOT NULL)
          OR (NOT NEW."is_available" AND NEW."paused_at" IS NULL)
        THEN RAISE EXCEPTION 'raffle machine identity and availability lifecycle are protected' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_raffle_v2_machine_immutable"
      BEFORE UPDATE OR DELETE ON "raffle_machines"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_protect_machine_v2"()`);

    await queryRunner.query(`CREATE TABLE "raffle_machine_availability_operations" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "machine_id" uuid NOT NULL,
      "admin_user_id" uuid NOT NULL, "action" varchar(16) NOT NULL,
      "expected_available" boolean NOT NULL, "result_available" boolean NOT NULL,
      "reason" varchar(512) NOT NULL, "idempotency_key" uuid NOT NULL,
      "request_fingerprint" char(64) NOT NULL, "response_snapshot" jsonb NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_raffle_machine_availability_operations" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_raffle_machine_availability_admin_key" UNIQUE ("admin_user_id", "idempotency_key"),
      CONSTRAINT "CHK_raffle_machine_availability_action" CHECK (
        ("action" = 'PAUSE' AND "expected_available" AND NOT "result_available")
        OR ("action" = 'RESUME' AND NOT "expected_available" AND "result_available")
      ),
      CONSTRAINT "CHK_raffle_machine_availability_reason" CHECK (length(btrim("reason")) > 0),
      CONSTRAINT "CHK_raffle_machine_availability_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "CHK_raffle_machine_availability_response" CHECK (jsonb_typeof("response_snapshot") = 'object'),
      CONSTRAINT "FK_raffle_machine_availability_machine" FOREIGN KEY ("machine_id")
        REFERENCES "raffle_machines"("id") ON DELETE RESTRICT,
      CONSTRAINT "FK_raffle_machine_availability_admin" FOREIGN KEY ("admin_user_id")
        REFERENCES "users"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query(`CREATE FUNCTION "protect_raffle_machine_availability_operation_v1"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Raffle machine availability audit is immutable' USING ERRCODE = '23514'; END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_raffle_machine_availability_operation_immutable"
      BEFORE UPDATE OR DELETE ON "raffle_machine_availability_operations"
      FOR EACH ROW EXECUTE FUNCTION "protect_raffle_machine_availability_operation_v1"()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`SELECT count(*)::text AS count FROM "raffle_machine_availability_operations"`);
    if (count !== '0') throw new Error('Cannot remove Raffle v2 availability audit history');
    await queryRunner.query(`DROP TRIGGER "TRG_raffle_machine_availability_operation_immutable" ON "raffle_machine_availability_operations"`);
    await queryRunner.query(`DROP FUNCTION "protect_raffle_machine_availability_operation_v1"()`);
    await queryRunner.query(`DROP TABLE "raffle_machine_availability_operations"`);
    await queryRunner.query(`DROP TRIGGER "TRG_raffle_v2_machine_immutable" ON "raffle_machines"`);
    await queryRunner.query(`DROP FUNCTION "raffle_v2_protect_machine_v2"()`);
    await queryRunner.query(`ALTER TABLE "raffle_machines" DROP CONSTRAINT "CHK_raffle_machines_availability",
      DROP COLUMN "paused_at", DROP COLUMN "is_available"`);
    await queryRunner.query(`CREATE FUNCTION "raffle_v2_protect_machine_v1"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'raffle machine identity is immutable' USING ERRCODE = '23514'; END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_raffle_v2_machine_immutable"
      BEFORE UPDATE OR DELETE ON "raffle_machines"
      FOR EACH ROW EXECUTE FUNCTION "raffle_v2_protect_machine_v1"()`);
  }
}
