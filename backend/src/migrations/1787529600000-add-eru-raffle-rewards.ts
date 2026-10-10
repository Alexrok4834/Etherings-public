import { MigrationInterface, QueryRunner } from 'typeorm';

const legacyRewardTypes = "'ERT', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER'";
const eruRewardTypes = "'ERT', 'ERU', 'BADGE', 'ITEM', 'NFT_PLACEHOLDER'";

export class AddEruRaffleRewards1787529600000 implements MigrationInterface {
  name = 'AddEruRaffleRewards1787529600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.replaceEnum(queryRunner, 'rewards', 'rewards_type_enum', eruRewardTypes);
    await this.replaceEnum(queryRunner, 'user_rewards', 'user_rewards_type_enum', eruRewardTypes);
    await queryRunner.query(`ALTER TABLE "rewards" ADD COLUMN "amount_exact" numeric(30,0)`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD COLUMN "amount_exact" numeric(30,0)`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD COLUMN "eru_balance_after" numeric(48,0)`);
    await queryRunner.query(`UPDATE "rewards" SET "amount_exact" = "amount" WHERE "amount" IS NOT NULL`);
    await queryRunner.query(`UPDATE "user_rewards" SET "amount_exact" = "amount" WHERE "amount" IS NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "rewards" ADD CONSTRAINT "CHK_rewards_eru_amount_exact"
      CHECK ("type" <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0 AND trunc("amount_exact") = "amount_exact"))
    `);
    await queryRunner.query(`
      ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_amount_exact"
      CHECK ("type" <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0 AND trunc("amount_exact") = "amount_exact"))
    `);
    await queryRunner.query(`
      ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_balance_after"
      CHECK ("eru_balance_after" IS NULL OR ("eru_balance_after" >= 0 AND trunc("eru_balance_after") = "eru_balance_after"))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(`
      SELECT (
        (SELECT count(*) FROM "rewards" WHERE "type" = 'ERU') +
        (SELECT count(*) FROM "user_rewards" WHERE "type" = 'ERU')
      )::text AS count
    `) as Array<{ count: string }>;
    if (count !== '0') throw new Error('Cannot remove ERU raffle schema while ERU rewards exist');

    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_balance_after"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "rewards" DROP CONSTRAINT "CHK_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP COLUMN "eru_balance_after"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP COLUMN "amount_exact"`);
    await queryRunner.query(`ALTER TABLE "rewards" DROP COLUMN "amount_exact"`);
    await this.replaceEnum(queryRunner, 'rewards', 'rewards_type_enum', legacyRewardTypes);
    await this.replaceEnum(queryRunner, 'user_rewards', 'user_rewards_type_enum', legacyRewardTypes);
  }

  private async replaceEnum(queryRunner: QueryRunner, table: string, enumName: string, values: string) {
    await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "type" TYPE varchar USING "type"::text`);
    await queryRunner.query(`DROP TYPE "public"."${enumName}"`);
    await queryRunner.query(`CREATE TYPE "public"."${enumName}" AS ENUM (${values})`);
    await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "type" TYPE "public"."${enumName}" USING "type"::"public"."${enumName}"`);
  }
}
