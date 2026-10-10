import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEruAccountingSchema1787443200000 implements MigrationInterface {
  name = 'CreateEruAccountingSchema1787443200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "balances"
        ADD COLUMN "eru_balance" numeric(48,0) NOT NULL DEFAULT 0,
        ADD COLUMN "lifetime_earned_eru" numeric(48,0) NOT NULL DEFAULT 0,
        ADD COLUMN "lifetime_spent_eru" numeric(48,0) NOT NULL DEFAULT 0,
        ADD CONSTRAINT "CHK_balances_eru_balance" CHECK ("eru_balance" >= 0),
        ADD CONSTRAINT "CHK_balances_lifetime_earned_eru" CHECK ("lifetime_earned_eru" >= 0),
        ADD CONSTRAINT "CHK_balances_lifetime_spent_eru" CHECK ("lifetime_spent_eru" >= 0)
    `);

    await queryRunner.query(`CREATE TYPE "public"."ledger_currency_enum" AS ENUM ('ERT', 'ERU')`);
    await queryRunner.query(`
      ALTER TABLE "ledger_transactions"
        ADD COLUMN "currency" "public"."ledger_currency_enum" NOT NULL DEFAULT 'ERT'
    `);
    await queryRunner.query(`
      ALTER TABLE "ledger_transactions"
        ADD CONSTRAINT "CHK_ledger_currency_purpose" CHECK (
          "currency" = 'ERT'
          OR ("type" = 'RAFFLE_REWARD' AND "amount" > 0)
          OR ("type" = 'COPPER_LEVEL_UP_SPEND' AND "amount" < 0)
        ),
        ADD CONSTRAINT "CHK_ledger_eru_integer_values" CHECK (
          "currency" <> 'ERU'
          OR (
            "amount" = trunc("amount")
            AND "balance_after" = trunc("balance_after")
            AND "balance_after" >= 0
          )
        )
    `);

    await queryRunner.query('DROP INDEX "UQ_ledger_copper_level_up_reference"');
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ledger_copper_level_up_reference"
      ON "ledger_transactions" ("currency", "reference_type", "reference_id")
      WHERE "type" = 'COPPER_LEVEL_UP_SPEND' AND "reference_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ledger_eru_raffle_reward_reference"
      ON "ledger_transactions" ("currency", "reference_type", "reference_id")
      WHERE "currency" = 'ERU'
        AND "type" = 'RAFFLE_REWARD'
        AND "reference_type" = 'raffle_draw'
        AND "reference_id" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "balances"
          WHERE "eru_balance" <> 0
            OR "lifetime_earned_eru" <> 0
            OR "lifetime_spent_eru" <> 0
        ) OR EXISTS (
          SELECT 1 FROM "ledger_transactions" WHERE "currency" = 'ERU'
        ) THEN
          RAISE EXCEPTION 'cannot remove ERU accounting schema after ERU state exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);

    await queryRunner.query('DROP INDEX "UQ_ledger_eru_raffle_reward_reference"');
    await queryRunner.query('DROP INDEX "UQ_ledger_copper_level_up_reference"');
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ledger_copper_level_up_reference"
      ON "ledger_transactions" ("reference_type", "reference_id")
      WHERE "type" = 'COPPER_LEVEL_UP_SPEND' AND "reference_id" IS NOT NULL
    `);

    await queryRunner.query(
      'ALTER TABLE "ledger_transactions" DROP CONSTRAINT "CHK_ledger_eru_integer_values"',
    );
    await queryRunner.query(
      'ALTER TABLE "ledger_transactions" DROP CONSTRAINT "CHK_ledger_currency_purpose"',
    );
    await queryRunner.query('ALTER TABLE "ledger_transactions" DROP COLUMN "currency"');
    await queryRunner.query('DROP TYPE "public"."ledger_currency_enum"');

    await queryRunner.query(`
      ALTER TABLE "balances"
        DROP CONSTRAINT "CHK_balances_lifetime_spent_eru",
        DROP CONSTRAINT "CHK_balances_lifetime_earned_eru",
        DROP CONSTRAINT "CHK_balances_eru_balance",
        DROP COLUMN "lifetime_spent_eru",
        DROP COLUMN "lifetime_earned_eru",
        DROP COLUMN "eru_balance"
    `);
  }
}
