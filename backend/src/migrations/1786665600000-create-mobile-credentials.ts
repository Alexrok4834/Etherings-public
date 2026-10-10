import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMobileCredentials1786665600000 implements MigrationInterface {
  name = 'CreateMobileCredentials1786665600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mobile_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "username" varchar(64) NOT NULL,
        "password_hash" varchar(255) NOT NULL,
        "password_changed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mobile_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mobile_credentials_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_mobile_credentials_user" ON "mobile_credentials" ("user_id")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_mobile_credentials_username" ON "mobile_credentials" (LOWER("username"))');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "mobile_credentials"');
  }
}
