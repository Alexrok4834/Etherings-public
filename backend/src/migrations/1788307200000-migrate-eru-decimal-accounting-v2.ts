import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateEruDecimalAccountingV21788307200000 implements MigrationInterface {
  name = 'MigrateEruDecimalAccountingV21788307200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "balances"
          WHERE length(trunc("eru_balance")::text) > 30
             OR length(trunc("lifetime_earned_eru")::text) > 30
             OR length(trunc("lifetime_spent_eru")::text) > 30
        ) OR EXISTS (
          SELECT 1 FROM "rewards" WHERE "amount_exact" IS NOT NULL
            AND length(trunc("amount_exact")::text) > 30
        ) OR EXISTS (
          SELECT 1 FROM "user_rewards" WHERE "amount_exact" IS NOT NULL
            AND length(trunc("amount_exact")::text) > 30
        ) OR EXISTS (
          SELECT 1 FROM "user_rewards" WHERE "eru_balance_after" IS NOT NULL
            AND length(trunc("eru_balance_after")::text) > 30
        ) THEN
          RAISE EXCEPTION 'ERU decimal migration preflight failed: value exceeds numeric(48,18)'
            USING ERRCODE = '22003';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`ALTER TABLE "ledger_transactions" DROP CONSTRAINT "CHK_ledger_eru_integer_values"`);
    await queryRunner.query(`ALTER TABLE "rewards" DROP CONSTRAINT "CHK_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_balance_after"`);

    await queryRunner.query(`
      ALTER TABLE "balances"
        ALTER COLUMN "eru_balance" TYPE numeric(48,18) USING "eru_balance"::numeric(48,18),
        ALTER COLUMN "lifetime_earned_eru" TYPE numeric(48,18) USING "lifetime_earned_eru"::numeric(48,18),
        ALTER COLUMN "lifetime_spent_eru" TYPE numeric(48,18) USING "lifetime_spent_eru"::numeric(48,18)
    `);
    await queryRunner.query(`
      ALTER TABLE "rewards"
        ALTER COLUMN "amount_exact" TYPE numeric(48,18) USING "amount_exact"::numeric(48,18)
    `);
    await queryRunner.query(`
      ALTER TABLE "user_rewards"
        ALTER COLUMN "amount_exact" TYPE numeric(48,18) USING "amount_exact"::numeric(48,18),
        ALTER COLUMN "eru_balance_after" TYPE numeric(48,18) USING "eru_balance_after"::numeric(48,18)
    `);

    await queryRunner.query(`ALTER TABLE "ledger_transactions" ADD CONSTRAINT "CHK_ledger_eru_decimal_values"
      CHECK ("currency" <> 'ERU' OR ("amount" <> 0 AND "balance_after" >= 0))`);
    await queryRunner.query(`ALTER TABLE "rewards" ADD CONSTRAINT "CHK_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0))`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0))`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_balance_after"
      CHECK ("eru_balance_after" IS NULL OR "eru_balance_after" >= 0)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "balances" WHERE
          "eru_balance" <> trunc("eru_balance") OR
          "lifetime_earned_eru" <> trunc("lifetime_earned_eru") OR
          "lifetime_spent_eru" <> trunc("lifetime_spent_eru"))
        OR EXISTS (SELECT 1 FROM "rewards" WHERE "amount_exact" IS NOT NULL
          AND "amount_exact" <> trunc("amount_exact"))
        OR EXISTS (SELECT 1 FROM "user_rewards" WHERE
          ("amount_exact" IS NOT NULL AND "amount_exact" <> trunc("amount_exact")) OR
          ("eru_balance_after" IS NOT NULL AND "eru_balance_after" <> trunc("eru_balance_after")))
        OR EXISTS (SELECT 1 FROM "ledger_transactions" WHERE "currency" = 'ERU'
          AND ("amount" <> trunc("amount") OR "balance_after" <> trunc("balance_after")))
        OR EXISTS (SELECT 1 FROM "copper_level_up_operations" WHERE
          ("response_snapshot" #>> '{cost,eruExact}') ~ '^[0-9]+\\.[0-9]*[1-9]$'
          OR ("response_snapshot" #>> '{balances,eruBeforeExact}') ~ '^[0-9]+\\.[0-9]*[1-9]$'
          OR ("response_snapshot" #>> '{balances,eruAfterExact}') ~ '^[0-9]+\\.[0-9]*[1-9]$')
        OR EXISTS (SELECT 1 FROM "raffle_draws" WHERE
          jsonb_path_exists("reward_snapshot", '$.** ? (@.type == "ERU" && @.amountExact like_regex "^[0-9]+\\.[0-9]*[1-9]$")'))
        OR EXISTS (SELECT 1 FROM "raffle_configuration_rewards" WHERE
          jsonb_path_exists("reward_snapshot", '$.** ? (@.type == "ERU" && @.amountExact like_regex "^[0-9]+\\.[0-9]*[1-9]$")'))
        OR EXISTS (SELECT 1 FROM "raffle_draw_operations" WHERE
          jsonb_path_exists("response_snapshot", '$.** ? (@.type == "ERU" && @.amountExact like_regex "^[0-9]+\\.[0-9]*[1-9]$")')
          OR jsonb_path_exists("response_snapshot", '$.** ? (@.type == "ERU_CREDIT" && @.balanceAfterExact like_regex "^[0-9]+\\.[0-9]*[1-9]$")'))
        THEN
          RAISE EXCEPTION 'cannot downgrade ERU decimal accounting after fractional evidence exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`ALTER TABLE "ledger_transactions" DROP CONSTRAINT "CHK_ledger_eru_decimal_values"`);
    await queryRunner.query(`ALTER TABLE "rewards" DROP CONSTRAINT "CHK_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_amount_exact"`);
    await queryRunner.query(`ALTER TABLE "user_rewards" DROP CONSTRAINT "CHK_user_rewards_eru_balance_after"`);

    await queryRunner.query(`
      ALTER TABLE "balances"
        ALTER COLUMN "eru_balance" TYPE numeric(48,0) USING "eru_balance"::numeric(48,0),
        ALTER COLUMN "lifetime_earned_eru" TYPE numeric(48,0) USING "lifetime_earned_eru"::numeric(48,0),
        ALTER COLUMN "lifetime_spent_eru" TYPE numeric(48,0) USING "lifetime_spent_eru"::numeric(48,0)
    `);
    await queryRunner.query(`ALTER TABLE "rewards"
      ALTER COLUMN "amount_exact" TYPE numeric(30,0) USING "amount_exact"::numeric(30,0)`);
    await queryRunner.query(`
      ALTER TABLE "user_rewards"
        ALTER COLUMN "amount_exact" TYPE numeric(30,0) USING "amount_exact"::numeric(30,0),
        ALTER COLUMN "eru_balance_after" TYPE numeric(48,0) USING "eru_balance_after"::numeric(48,0)
    `);

    await queryRunner.query(`ALTER TABLE "ledger_transactions" ADD CONSTRAINT "CHK_ledger_eru_integer_values"
      CHECK ("currency" <> 'ERU' OR ("amount" = trunc("amount") AND "balance_after" = trunc("balance_after") AND "balance_after" >= 0))`);
    await queryRunner.query(`ALTER TABLE "rewards" ADD CONSTRAINT "CHK_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0 AND trunc("amount_exact") = "amount_exact"))`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_amount_exact"
      CHECK ("type"::text <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0 AND trunc("amount_exact") = "amount_exact"))`);
    await queryRunner.query(`ALTER TABLE "user_rewards" ADD CONSTRAINT "CHK_user_rewards_eru_balance_after"
      CHECK ("eru_balance_after" IS NULL OR ("eru_balance_after" >= 0 AND trunc("eru_balance_after") = "eru_balance_after"))`);
  }
}
