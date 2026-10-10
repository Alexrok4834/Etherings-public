import { MigrationInterface, QueryRunner } from 'typeorm';

const ERT_COLUMNS = [
  ['balances', 'ert_balance'],
  ['balances', 'lifetime_earned_ert'],
  ['balances', 'lifetime_spent_ert'],
  ['ledger_transactions', 'amount'],
  ['ledger_transactions', 'balance_after'],
  ['daily_user_stats', 'earned_ert'],
  ['step_sync_batches', 'earned_ert_delta'],
  ['walk_sessions', 'earned_ert'],
] as const;

export class CreateM2eAccountingSchema1787356800000 implements MigrationInterface {
  name = 'CreateM2eAccountingSchema1787356800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of ERT_COLUMNS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE numeric(48,18)
        USING "${column}"::numeric(48,18)
      `);
    }

    await queryRunner.query(`
      CREATE TABLE "m2e_daily_economic_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "accounting_date" date NOT NULL,
        "selected_ring_id" uuid NOT NULL,
        "ring_count" integer NOT NULL,
        "selected_ring_comfort" integer NOT NULL,
        "step_cap" integer NOT NULL,
        "rules_version" varchar(64) NOT NULL,
        "balance_config_version" varchar(64) NOT NULL,
        "base_steps" integer NOT NULL,
        "extra_steps_per_ring" integer NOT NULL,
        "base_ert_per_1000_steps" numeric(48,18) NOT NULL,
        "comfort_curve_k" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_m2e_daily_economic_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_m2e_daily_snapshot_owner_date" UNIQUE ("user_id", "accounting_date"),
        CONSTRAINT "UQ_m2e_daily_snapshot_id_owner" UNIQUE ("id", "user_id"),
        CONSTRAINT "CHK_m2e_daily_snapshot_ring_count" CHECK ("ring_count" > 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_step_cap" CHECK ("step_cap" > 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_base_steps" CHECK ("base_steps" > 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_extra_steps" CHECK ("extra_steps_per_ring" > 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_base_rate" CHECK ("base_ert_per_1000_steps" >= 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_comfort_curve" CHECK ("comfort_curve_k" > 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_comfort" CHECK ("selected_ring_comfort" >= 0),
        CONSTRAINT "CHK_m2e_daily_snapshot_rules" CHECK ("rules_version" = 'move-to-earn-earning-v1'),
        CONSTRAINT "CHK_m2e_daily_snapshot_balance_config" CHECK ("balance_config_version" = 'move-to-earn-balance-v1'),
        CONSTRAINT "FK_m2e_daily_snapshot_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_m2e_daily_snapshot_ring_owner" FOREIGN KEY ("selected_ring_id", "user_id")
          REFERENCES "game_rings"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "reject_m2e_daily_snapshot_mutation"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'M2E daily economic snapshots are immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_m2e_daily_snapshot_immutable"
      BEFORE UPDATE OR DELETE ON "m2e_daily_economic_snapshots"
      FOR EACH ROW EXECUTE FUNCTION "reject_m2e_daily_snapshot_mutation"()
    `);

    await queryRunner.query('ALTER TABLE "step_sync_batches" ADD COLUMN "m2e_daily_snapshot_id" uuid');
    await queryRunner.query(`
      ALTER TABLE "step_sync_batches"
      ADD CONSTRAINT "FK_step_sync_batch_m2e_snapshot_owner"
      FOREIGN KEY ("m2e_daily_snapshot_id", "user_id")
      REFERENCES "m2e_daily_economic_snapshots"("id", "user_id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const unsafeValuePredicates = ERT_COLUMNS.map(([table, column]) => `
      EXISTS (
        SELECT 1 FROM "${table}"
        WHERE "${column}" <> trunc("${column}")
          OR abs("${column}") >= 1000000000000000000000000
      )
    `).join(' OR ');

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "m2e_daily_economic_snapshots")
          OR EXISTS (
            SELECT 1 FROM "step_sync_batches"
            WHERE "result_snapshot" ->> 'rulesVersion' = 'move-to-earn-earning-v1'
          )
          OR ${unsafeValuePredicates}
        THEN
          RAISE EXCEPTION 'cannot remove M2E accounting schema after fractional or v1 economic state exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);

    await queryRunner.query(
      'ALTER TABLE "step_sync_batches" DROP CONSTRAINT "FK_step_sync_batch_m2e_snapshot_owner"',
    );
    await queryRunner.query('ALTER TABLE "step_sync_batches" DROP COLUMN "m2e_daily_snapshot_id"');
    await queryRunner.query(
      'DROP TRIGGER "TRG_m2e_daily_snapshot_immutable" ON "m2e_daily_economic_snapshots"',
    );
    await queryRunner.query('DROP FUNCTION "reject_m2e_daily_snapshot_mutation"()');
    await queryRunner.query('DROP TABLE "m2e_daily_economic_snapshots"');

    for (const [table, column] of ERT_COLUMNS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE numeric(24,0)
        USING "${column}"::numeric(24,0)
      `);
    }
  }
}
