import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalkRewardIdempotency1788393600000 implements MigrationInterface {
  name = 'AddWalkRewardIdempotency1788393600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "ledger_transactions"
          WHERE "currency" = 'ERT' AND "type" = 'WALK_REWARD'
            AND "reference_type" = 'walk_session' AND "reference_id" IS NOT NULL
          GROUP BY "currency", "reference_type", "reference_id"
          HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'duplicate Walk reward references require reconciliation before migration'
            USING ERRCODE = '23505';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ledger_walk_reward_reference"
      ON "ledger_transactions" ("currency", "reference_type", "reference_id")
      WHERE "currency" = 'ERT' AND "type" = 'WALK_REWARD'
        AND "reference_type" = 'walk_session' AND "reference_id" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "ledger_transactions"
          WHERE "currency" = 'ERT' AND "type" = 'WALK_REWARD'
            AND "reference_type" = 'walk_session' AND "reference_id" IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'cannot remove Walk reward uniqueness while reward evidence exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);
    await queryRunner.query('DROP INDEX "UQ_ledger_walk_reward_reference"');
  }
}
