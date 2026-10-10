import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMobileRefreshTokens1786492800000 implements MigrationInterface {
  name = 'CreateMobileRefreshTokens1786492800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TYPE "mobile_refresh_tokens_status_enum" AS ENUM (\'ACTIVE\', \'ROTATED\', \'REVOKED\')');
    await queryRunner.query(`
      CREATE TABLE "mobile_refresh_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "family_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "installation_record_id" uuid NOT NULL,
        "token_hash" char(64) NOT NULL,
        "parent_token_id" uuid,
        "replaced_by_token_id" uuid,
        "status" "mobile_refresh_tokens_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revocation_reason" varchar(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mobile_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_mobile_refresh_token_expiry" CHECK ("expires_at" > "created_at"),
        CONSTRAINT "CHK_mobile_refresh_token_state" CHECK (("status" = 'ACTIVE' AND "consumed_at" IS NULL AND "revoked_at" IS NULL AND "replaced_by_token_id" IS NULL) OR ("status" = 'ROTATED' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL AND "replaced_by_token_id" IS NOT NULL) OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)),
        CONSTRAINT "FK_mobile_refresh_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_mobile_refresh_token_installation_owner" FOREIGN KEY ("installation_record_id", "user_id") REFERENCES "step_sync_installations"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_mobile_refresh_token_hash" ON "mobile_refresh_tokens" ("token_hash")');
    await queryRunner.query('CREATE INDEX "IDX_mobile_refresh_token_family" ON "mobile_refresh_tokens" ("family_id")');
    await queryRunner.query('CREATE INDEX "IDX_mobile_refresh_token_owner_installation" ON "mobile_refresh_tokens" ("user_id", "installation_record_id")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_mobile_refresh_token_active_family" ON "mobile_refresh_tokens" ("family_id") WHERE "status" = \'ACTIVE\'');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_mobile_refresh_token_active_installation" ON "mobile_refresh_tokens" ("user_id", "installation_record_id") WHERE "status" = \'ACTIVE\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "mobile_refresh_tokens"');
    await queryRunner.query('DROP TYPE "mobile_refresh_tokens_status_enum"');
  }
}
