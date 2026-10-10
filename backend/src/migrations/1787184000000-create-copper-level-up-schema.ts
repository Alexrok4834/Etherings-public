import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCopperLevelUpSchema1787184000000 implements MigrationInterface {
  name = 'CreateCopperLevelUpSchema1787184000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_ledger_copper_level_up_reference"');
    await queryRunner.query(
      'ALTER TABLE "ledger_transactions" ALTER COLUMN "type" TYPE varchar USING "type"::text',
    );
    await queryRunner.query('DROP TYPE "public"."ledger_transactions_type_enum"');
    await queryRunner.query(`
      CREATE TYPE "public"."ledger_transactions_type_enum" AS ENUM (
        'WALK_REWARD', 'RAFFLE_SPEND', 'RAFFLE_REWARD', 'ADMIN_ADJUSTMENT', 'RAFFLE_REFUND',
        'COPPER_LEVEL_UP_SPEND'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "ledger_transactions" ALTER COLUMN "type"
      TYPE "public"."ledger_transactions_type_enum"
      USING "type"::"public"."ledger_transactions_type_enum"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ledger_copper_level_up_reference"
      ON "ledger_transactions" ("reference_type", "reference_id")
      WHERE "type" = 'COPPER_LEVEL_UP_SPEND' AND "reference_id" IS NOT NULL
    `);

    await queryRunner.query('ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"');
    await queryRunner.query(`
      ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type"
      CHECK ("event_type" IN ('STARTER_ISSUED', 'LEVEL_UP'))
    `);

    await queryRunner.query(`
      CREATE TABLE "copper_level_up_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_user_id" uuid NOT NULL,
        "ring_id" uuid NOT NULL,
        "idempotency_key" uuid NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "rules_version" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL,
        "response_snapshot" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_copper_level_up_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_copper_level_up_owner_key" UNIQUE ("owner_user_id", "idempotency_key"),
        CONSTRAINT "CHK_copper_level_up_operation_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_copper_level_up_operation_status" CHECK ("status" IN ('PENDING', 'COMPLETED')),
        CONSTRAINT "CHK_copper_level_up_operation_rules" CHECK ("rules_version" = 'copper-level-up-v1'),
        CONSTRAINT "CHK_copper_level_up_operation_response" CHECK (
          ("status" = 'PENDING' AND "response_snapshot" IS NULL)
          OR ("status" = 'COMPLETED' AND jsonb_typeof("response_snapshot") = 'object')
        ),
        CONSTRAINT "FK_copper_level_up_operation_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "protect_copper_level_up_operation"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR OLD."status" = 'COMPLETED'
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
          OR NEW."ring_id" IS DISTINCT FROM OLD."ring_id"
          OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
          OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
          OR NEW."rules_version" IS DISTINCT FROM OLD."rules_version"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NOT (OLD."status" = 'PENDING' AND NEW."status" = 'COMPLETED')
        THEN
          RAISE EXCEPTION 'copper level-up operation is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_copper_level_up_operation_immutable"
      BEFORE UPDATE OR DELETE ON "copper_level_up_operations"
      FOR EACH ROW EXECUTE FUNCTION "protect_copper_level_up_operation"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER "TRG_copper_level_up_operation_immutable" ON "copper_level_up_operations"',
    );
    await queryRunner.query('DROP FUNCTION "protect_copper_level_up_operation"()');
    await queryRunner.query('DROP TABLE "copper_level_up_operations"');
    await queryRunner.query('ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"');
    await queryRunner.query(`
      ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type"
      CHECK ("event_type" = 'STARTER_ISSUED')
    `);
    await queryRunner.query('DROP INDEX "UQ_ledger_copper_level_up_reference"');
    await queryRunner.query('ALTER TABLE "ledger_transactions" ALTER COLUMN "type" TYPE varchar USING "type"::text');
    await queryRunner.query('DROP TYPE "public"."ledger_transactions_type_enum"');
    await queryRunner.query(`
      CREATE TYPE "public"."ledger_transactions_type_enum" AS ENUM (
        'WALK_REWARD', 'RAFFLE_SPEND', 'RAFFLE_REWARD', 'ADMIN_ADJUSTMENT', 'RAFFLE_REFUND'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "ledger_transactions" ALTER COLUMN "type"
      TYPE "public"."ledger_transactions_type_enum"
      USING "type"::"public"."ledger_transactions_type_enum"
    `);
  }
}
