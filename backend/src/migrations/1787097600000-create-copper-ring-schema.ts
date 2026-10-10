import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCopperRingSchema1787097600000 implements MigrationInterface {
  name = 'CreateCopperRingSchema1787097600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(`
      CREATE TABLE "game_rings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_user_id" uuid NOT NULL,
        "entitlement_code" varchar(64) NOT NULL,
        "ring_kind" varchar(32) NOT NULL,
        "status" varchar(32) NOT NULL,
        "level" smallint NOT NULL,
        "shine" smallint NOT NULL,
        "comfort" integer NOT NULL,
        "charm" integer NOT NULL,
        "quality" integer NOT NULL,
        "luck" integer NOT NULL,
        "visual_variant_code" varchar(64) NOT NULL,
        "ruleset_version" varchar(64) NOT NULL,
        "generation_version" varchar(64) NOT NULL,
        "visual_set_version" varchar(64) NOT NULL,
        "issued_reason" varchar(32) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_game_rings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_game_rings_owner_entitlement" UNIQUE ("owner_user_id", "entitlement_code"),
        CONSTRAINT "UQ_game_rings_id_owner" UNIQUE ("id", "owner_user_id"),
        CONSTRAINT "CHK_game_rings_entitlement" CHECK ("entitlement_code" = 'starter-copper-v1'),
        CONSTRAINT "CHK_game_rings_kind" CHECK ("ring_kind" = 'COPPER'),
        CONSTRAINT "CHK_game_rings_status" CHECK ("status" = 'ACTIVE'),
        CONSTRAINT "CHK_game_rings_level" CHECK ("level" BETWEEN 1 AND 20),
        CONSTRAINT "CHK_game_rings_shine" CHECK ("shine" = 100),
        CONSTRAINT "CHK_game_rings_comfort" CHECK ("comfort" >= 2),
        CONSTRAINT "CHK_game_rings_charm" CHECK ("charm" >= 2),
        CONSTRAINT "CHK_game_rings_quality" CHECK ("quality" >= 2),
        CONSTRAINT "CHK_game_rings_luck" CHECK ("luck" >= 2),
        CONSTRAINT "CHK_game_rings_visual_variant" CHECK ("visual_variant_code" IN (
          'copper_plain_polished',
          'copper_rune_rough',
          'copper_twisted',
          'copper_geometric',
          'copper_milgrain',
          'copper_leaves',
          'copper_celtic',
          'copper_filigree',
          'copper_signet'
        )),
        CONSTRAINT "CHK_game_rings_ruleset" CHECK ("ruleset_version" = 'copper-rules-v1'),
        CONSTRAINT "CHK_game_rings_generation" CHECK ("generation_version" = 'copper-generation-v1'),
        CONSTRAINT "CHK_game_rings_visual_set" CHECK ("visual_set_version" = 'copper-visual-v1'),
        CONSTRAINT "CHK_game_rings_issued_reason" CHECK ("issued_reason" IN ('REGISTRATION', 'LEGACY_BACKFILL', 'LAZY_ENSURE')),
        CONSTRAINT "FK_game_rings_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_game_rings_owner_created" ON "game_rings" ("owner_user_id", "created_at")',
    );

    await queryRunner.query(`
      CREATE FUNCTION "protect_game_ring_identity"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
          OR NEW."entitlement_code" IS DISTINCT FROM OLD."entitlement_code"
          OR NEW."ring_kind" IS DISTINCT FROM OLD."ring_kind"
          OR NEW."status" IS DISTINCT FROM OLD."status"
          OR NEW."visual_variant_code" IS DISTINCT FROM OLD."visual_variant_code"
          OR NEW."ruleset_version" IS DISTINCT FROM OLD."ruleset_version"
          OR NEW."generation_version" IS DISTINCT FROM OLD."generation_version"
          OR NEW."visual_set_version" IS DISTINCT FROM OLD."visual_set_version"
          OR NEW."issued_reason" IS DISTINCT FROM OLD."issued_reason"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        THEN
          RAISE EXCEPTION 'game ring identity and provenance are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_game_rings_protect_identity"
      BEFORE UPDATE ON "game_rings"
      FOR EACH ROW EXECUTE FUNCTION "protect_game_ring_identity"()
    `);

    await queryRunner.query(`
      CREATE TABLE "equipped_rings" (
        "user_id" uuid NOT NULL,
        "ring_id" uuid NOT NULL,
        "equipped_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_equipped_rings" PRIMARY KEY ("user_id"),
        CONSTRAINT "UQ_equipped_rings_ring" UNIQUE ("ring_id"),
        CONSTRAINT "FK_equipped_rings_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_equipped_rings_ring_owner" FOREIGN KEY ("ring_id", "user_id") REFERENCES "game_rings"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "ring_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ring_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "operation_key" varchar(128) NOT NULL,
        "event_type" varchar(64) NOT NULL,
        "ruleset_version" varchar(64) NOT NULL,
        "snapshot" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ring_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ring_events_operation_key" UNIQUE ("operation_key"),
        CONSTRAINT "CHK_ring_events_type" CHECK ("event_type" = 'STARTER_ISSUED'),
        CONSTRAINT "CHK_ring_events_ruleset" CHECK ("ruleset_version" = 'copper-rules-v1'),
        CONSTRAINT "CHK_ring_events_snapshot" CHECK (jsonb_typeof("snapshot") = 'object'),
        CONSTRAINT "FK_ring_events_ring_owner" FOREIGN KEY ("ring_id", "owner_user_id") REFERENCES "game_rings"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_ring_events_starter_issued" ON "ring_events" ("ring_id") WHERE "event_type" = \'STARTER_ISSUED\'',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_ring_events_ring_created" ON "ring_events" ("ring_id", "created_at")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_ring_events_owner_created" ON "ring_events" ("owner_user_id", "created_at")',
    );

    await queryRunner.query(`
      CREATE FUNCTION "reject_ring_event_mutation"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ring events are append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_ring_events_append_only"
      BEFORE UPDATE OR DELETE ON "ring_events"
      FOR EACH ROW EXECUTE FUNCTION "reject_ring_event_mutation"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER "TRG_ring_events_append_only" ON "ring_events"');
    await queryRunner.query('DROP FUNCTION "reject_ring_event_mutation"()');
    await queryRunner.query('DROP TABLE "ring_events"');
    await queryRunner.query('DROP TABLE "equipped_rings"');
    await queryRunner.query('DROP TRIGGER "TRG_game_rings_protect_identity" ON "game_rings"');
    await queryRunner.query('DROP FUNCTION "protect_game_ring_identity"()');
    await queryRunner.query('DROP TABLE "game_rings"');
  }
}
