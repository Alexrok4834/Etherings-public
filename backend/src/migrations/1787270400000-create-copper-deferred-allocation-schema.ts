import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCopperDeferredAllocationSchema1787270400000 implements MigrationInterface {
  name = 'CreateCopperDeferredAllocationSchema1787270400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "game_rings"
      ADD COLUMN "unspent_attribute_points" smallint NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "game_rings"
      ADD CONSTRAINT "CHK_game_rings_unspent_attribute_points"
      CHECK ("unspent_attribute_points" BETWEEN 0 AND 76)
    `);

    await queryRunner.query(
      'ALTER TABLE "copper_level_up_operations" DROP CONSTRAINT "CHK_copper_level_up_operation_rules"',
    );
    await queryRunner.query(`
      ALTER TABLE "copper_level_up_operations"
      ADD CONSTRAINT "CHK_copper_level_up_operation_rules"
      CHECK ("rules_version" IN ('copper-level-up-v1', 'copper-level-up-v2'))
    `);
    await queryRunner.query(
      'ALTER TABLE "copper_level_up_operations" DROP CONSTRAINT "CHK_copper_level_up_operation_response"',
    );
    await queryRunner.query(`
      ALTER TABLE "copper_level_up_operations"
      ADD CONSTRAINT "CHK_copper_level_up_operation_response" CHECK (
        ("status" = 'PENDING' AND "response_snapshot" IS NULL)
        OR (
          "status" = 'COMPLETED'
          AND "response_snapshot" IS NOT NULL
          AND jsonb_typeof("response_snapshot") = 'object'
        )
      )
    `);

    await queryRunner.query('ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"');
    await queryRunner.query(`
      ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type"
      CHECK ("event_type" IN ('STARTER_ISSUED', 'LEVEL_UP', 'ATTRIBUTE_POINTS_ALLOCATED'))
    `);

    await queryRunner.query(`
      CREATE TABLE "copper_attribute_allocation_operations" (
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
        CONSTRAINT "PK_copper_attribute_allocation_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_copper_attribute_allocation_owner_key"
          UNIQUE ("owner_user_id", "idempotency_key"),
        CONSTRAINT "CHK_copper_attribute_allocation_operation_fingerprint"
          CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_copper_attribute_allocation_operation_status"
          CHECK ("status" IN ('PENDING', 'COMPLETED')),
        CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"
          CHECK ("rules_version" = 'copper-attribute-allocation-v1'),
        CONSTRAINT "CHK_copper_attribute_allocation_operation_response" CHECK (
          ("status" = 'PENDING' AND "response_snapshot" IS NULL)
          OR (
            "status" = 'COMPLETED'
            AND "response_snapshot" IS NOT NULL
            AND jsonb_typeof("response_snapshot") = 'object'
          )
        ),
        CONSTRAINT "FK_copper_attribute_allocation_operation_owner"
          FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_copper_attribute_allocation_operation_ring_owner"
          FOREIGN KEY ("ring_id", "owner_user_id") REFERENCES "game_rings"("id", "owner_user_id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "protect_copper_attribute_allocation_operation"() RETURNS trigger AS $$
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
          RAISE EXCEPTION 'copper attribute allocation operation is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_copper_attribute_allocation_operation_immutable"
      BEFORE UPDATE OR DELETE ON "copper_attribute_allocation_operations"
      FOR EACH ROW EXECUTE FUNCTION "protect_copper_attribute_allocation_operation"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "game_rings" WHERE "unspent_attribute_points" <> 0
        ) OR EXISTS (
          SELECT 1 FROM "copper_level_up_operations"
          WHERE "rules_version" = 'copper-level-up-v2'
        ) OR EXISTS (
          SELECT 1 FROM "copper_attribute_allocation_operations"
        ) OR EXISTS (
          SELECT 1 FROM "ring_events" WHERE "event_type" = 'ATTRIBUTE_POINTS_ALLOCATED'
        ) THEN
          RAISE EXCEPTION 'cannot remove deferred allocation schema after v2 progression exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);

    await queryRunner.query(
      'DROP TRIGGER "TRG_copper_attribute_allocation_operation_immutable" '
      + 'ON "copper_attribute_allocation_operations"',
    );
    await queryRunner.query('DROP FUNCTION "protect_copper_attribute_allocation_operation"()');
    await queryRunner.query('DROP TABLE "copper_attribute_allocation_operations"');

    await queryRunner.query('ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"');
    await queryRunner.query(`
      ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type"
      CHECK ("event_type" IN ('STARTER_ISSUED', 'LEVEL_UP'))
    `);

    await queryRunner.query(
      'ALTER TABLE "copper_level_up_operations" DROP CONSTRAINT "CHK_copper_level_up_operation_rules"',
    );
    await queryRunner.query(`
      ALTER TABLE "copper_level_up_operations"
      ADD CONSTRAINT "CHK_copper_level_up_operation_rules"
      CHECK ("rules_version" = 'copper-level-up-v1')
    `);
    await queryRunner.query(
      'ALTER TABLE "copper_level_up_operations" DROP CONSTRAINT "CHK_copper_level_up_operation_response"',
    );
    await queryRunner.query(`
      ALTER TABLE "copper_level_up_operations"
      ADD CONSTRAINT "CHK_copper_level_up_operation_response" CHECK (
        ("status" = 'PENDING' AND "response_snapshot" IS NULL)
        OR ("status" = 'COMPLETED' AND jsonb_typeof("response_snapshot") = 'object')
      )
    `);

    await queryRunner.query(
      'ALTER TABLE "game_rings" DROP CONSTRAINT "CHK_game_rings_unspent_attribute_points"',
    );
    await queryRunner.query('ALTER TABLE "game_rings" DROP COLUMN "unspent_attribute_points"');
  }
}
