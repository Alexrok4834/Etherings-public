import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRingEquipmentOperationSchema1787875200000 implements MigrationInterface {
  name = 'CreateRingEquipmentOperationSchema1787875200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NULL
          OR to_regclass('public.game_rings') IS NULL
          OR to_regclass('public.equipped_rings') IS NULL
          OR to_regclass('public.ring_events') IS NULL
        THEN
          RAISE EXCEPTION 'Ring equipment operation requires Copper Ring prerequisites'
            USING ERRCODE = '42P01';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"`);
    await queryRunner.query(`ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type" CHECK (
      "event_type" IN ('STARTER_ISSUED', 'LEVEL_UP', 'ATTRIBUTE_POINTS_ALLOCATED', 'RAFFLE_AWARDED', 'EQUIPPED')
    )`);

    await queryRunner.query(`
      CREATE TABLE "ring_equipment_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_user_id" uuid NOT NULL,
        "target_ring_id" uuid NOT NULL,
        "expected_equipped_ring_id" uuid NOT NULL,
        "idempotency_key" uuid NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "contract_version" varchar(32) NOT NULL,
        "status" varchar(16) NOT NULL,
        "response_snapshot" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_ring_equipment_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ring_equipment_operations_owner_key" UNIQUE ("owner_user_id", "idempotency_key"),
        CONSTRAINT "CHK_ring_equipment_operations_idempotency_v4" CHECK (
          "idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT "CHK_ring_equipment_operations_fingerprint" CHECK (
          "request_fingerprint" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_ring_equipment_operations_contract" CHECK (
          "contract_version" = 'ring-equipment-v1'
        ),
        CONSTRAINT "CHK_ring_equipment_operations_status" CHECK (
          "status" IN ('PENDING', 'COMPLETED')
        ),
        CONSTRAINT "CHK_ring_equipment_operations_lifecycle" CHECK (
          ("status" = 'PENDING' AND "response_snapshot" IS NULL AND "completed_at" IS NULL)
          OR (
            "status" = 'COMPLETED'
            AND "response_snapshot" IS NOT NULL
            AND jsonb_typeof("response_snapshot") = 'object'
            AND "completed_at" IS NOT NULL
            AND "completed_at" >= "created_at"
          )
        ),
        CONSTRAINT "CHK_ring_equipment_operations_updated_at" CHECK ("updated_at" >= "created_at"),
        CONSTRAINT "FK_ring_equipment_operations_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_ring_equipment_operations_target_owner" FOREIGN KEY ("target_ring_id", "owner_user_id")
          REFERENCES "game_rings" ("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_ring_equipment_operations_expected_owner" FOREIGN KEY ("expected_equipped_ring_id", "owner_user_id")
          REFERENCES "game_rings" ("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "protect_ring_equipment_operation"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR OLD."status" = 'COMPLETED'
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
          OR NEW."target_ring_id" IS DISTINCT FROM OLD."target_ring_id"
          OR NEW."expected_equipped_ring_id" IS DISTINCT FROM OLD."expected_equipped_ring_id"
          OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
          OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
          OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NOT (OLD."status" = 'PENDING' AND NEW."status" = 'COMPLETED')
        THEN
          RAISE EXCEPTION 'Ring equipment operation is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE TRIGGER "TRG_ring_equipment_operations_immutable"
      BEFORE UPDATE OR DELETE ON "ring_equipment_operations"
      FOR EACH ROW EXECUTE FUNCTION "protect_ring_equipment_operation"()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT (
        (SELECT count(*) FROM "ring_equipment_operations")
        + (SELECT count(*) FROM "ring_events" WHERE "event_type" = 'EQUIPPED')
      )::text AS count
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove Ring equipment operation schema while equipment history exists');

    await queryRunner.query(`DROP TRIGGER "TRG_ring_equipment_operations_immutable" ON "ring_equipment_operations"`);
    await queryRunner.query(`DROP FUNCTION "protect_ring_equipment_operation"()`);
    await queryRunner.query(`DROP TABLE "ring_equipment_operations"`);
    await queryRunner.query(`ALTER TABLE "ring_events" DROP CONSTRAINT "CHK_ring_events_type"`);
    await queryRunner.query(`ALTER TABLE "ring_events" ADD CONSTRAINT "CHK_ring_events_type" CHECK (
      "event_type" IN ('STARTER_ISSUED', 'LEVEL_UP', 'ATTRIBUTE_POINTS_ALLOCATED', 'RAFFLE_AWARDED')
    )`);
  }
}
