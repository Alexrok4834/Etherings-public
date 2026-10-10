import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStepSyncSchema1786406400000 implements MigrationInterface {
  name = 'CreateStepSyncSchema1786406400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(
      'CREATE TYPE "step_sync_installations_status_enum" AS ENUM (\'ACTIVE\', \'REVOKED\')',
    );
    await queryRunner.query(
      'CREATE TYPE "step_sync_batches_source_enum" AS ENUM (\'android_step_counter\')',
    );
    await queryRunner.query(
      'CREATE TYPE "step_sync_batches_status_enum" AS ENUM (\'RECEIVED\', \'ACCEPTED\', \'PARTIALLY_ACCEPTED\', \'REJECTED\')',
    );

    await queryRunner.query(`
      CREATE TABLE "step_sync_installations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "installation_id" uuid NOT NULL,
        "status" "step_sync_installations_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_step_sync_installations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_step_sync_installation_status" CHECK (("status" = 'ACTIVE' AND "revoked_at" IS NULL) OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)),
        CONSTRAINT "FK_step_sync_installations_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_step_sync_installation_owner_client" ON "step_sync_installations" ("user_id", "installation_id")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_step_sync_installation_id_owner" ON "step_sync_installations" ("id", "user_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_step_sync_installation_owner_status" ON "step_sync_installations" ("user_id", "status")',
    );

    await queryRunner.query(`
      CREATE TABLE "step_sync_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "installation_record_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "sequence" bigint NOT NULL,
        "payload_hash" char(64) NOT NULL,
        "local_date" date NOT NULL,
        "timezone_offset_minutes" smallint NOT NULL,
        "observed_started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "observed_ended_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "claimed_step_count" integer NOT NULL,
        "sensor_event_count" integer NOT NULL,
        "source" "step_sync_batches_source_enum" NOT NULL,
        "algorithm_version" varchar(64) NOT NULL,
        "status" "step_sync_batches_status_enum" NOT NULL DEFAULT 'RECEIVED',
        "accepted_step_delta" integer,
        "earned_ert_delta" numeric(24,0),
        "accounting_date" date,
        "result_code" varchar(128),
        "client_metadata" jsonb,
        "result_snapshot" jsonb,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_step_sync_batches" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_step_sync_batch_sequence" CHECK ("sequence" >= 0),
        CONSTRAINT "CHK_step_sync_batch_claimed_steps" CHECK ("claimed_step_count" > 0),
        CONSTRAINT "CHK_step_sync_batch_sensor_events" CHECK ("sensor_event_count" > 0),
        CONSTRAINT "CHK_step_sync_batch_timezone" CHECK ("timezone_offset_minutes" BETWEEN -1080 AND 1080),
        CONSTRAINT "CHK_step_sync_batch_interval" CHECK ("observed_ended_at" >= "observed_started_at"),
        CONSTRAINT "CHK_step_sync_batch_accepted_steps" CHECK ("accepted_step_delta" IS NULL OR ("accepted_step_delta" >= 0 AND "accepted_step_delta" <= "claimed_step_count")),
        CONSTRAINT "CHK_step_sync_batch_earned_ert" CHECK ("earned_ert_delta" IS NULL OR "earned_ert_delta" >= 0),
        CONSTRAINT "CHK_step_sync_batch_processing_state" CHECK (("status" = 'RECEIVED' AND "accepted_step_delta" IS NULL AND "earned_ert_delta" IS NULL AND "result_code" IS NULL AND "result_snapshot" IS NULL AND "processed_at" IS NULL) OR ("status" <> 'RECEIVED' AND "accepted_step_delta" IS NOT NULL AND "earned_ert_delta" IS NOT NULL AND "result_code" IS NOT NULL AND "result_snapshot" IS NOT NULL AND "processed_at" IS NOT NULL)),
        CONSTRAINT "CHK_step_sync_batch_result_semantics" CHECK ("status" = 'RECEIVED' OR ("status" = 'ACCEPTED' AND "accepted_step_delta" = "claimed_step_count" AND "accounting_date" IS NOT NULL) OR ("status" = 'PARTIALLY_ACCEPTED' AND "accepted_step_delta" > 0 AND "accepted_step_delta" < "claimed_step_count" AND "accounting_date" IS NOT NULL) OR ("status" = 'REJECTED' AND "accepted_step_delta" = 0 AND "earned_ert_delta" = 0)),
        CONSTRAINT "FK_step_sync_batch_installation_owner" FOREIGN KEY ("installation_record_id", "user_id") REFERENCES "step_sync_installations"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_step_sync_batch_identity" ON "step_sync_batches" ("user_id", "installation_record_id", "batch_id")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_step_sync_batch_sequence" ON "step_sync_batches" ("installation_record_id", "sequence")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_step_sync_batch_owner_created" ON "step_sync_batches" ("user_id", "created_at")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_step_sync_batch_owner_date" ON "step_sync_batches" ("user_id", "local_date")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "step_sync_batches"');
    await queryRunner.query('DROP TABLE "step_sync_installations"');
    await queryRunner.query('DROP TYPE "step_sync_batches_status_enum"');
    await queryRunner.query('DROP TYPE "step_sync_batches_source_enum"');
    await queryRunner.query('DROP TYPE "step_sync_installations_status_enum"');
  }
}
