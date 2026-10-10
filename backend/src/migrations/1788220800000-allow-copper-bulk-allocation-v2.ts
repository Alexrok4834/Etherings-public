import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowCopperBulkAllocationV21788220800000 implements MigrationInterface {
  name = 'AllowCopperBulkAllocationV21788220800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "copper_attribute_allocation_operations"
      DROP CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"
    `);
    await queryRunner.query(`
      ALTER TABLE "copper_attribute_allocation_operations"
      ADD CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"
      CHECK ("rules_version" IN (
        'copper-attribute-allocation-v1',
        'copper-attribute-allocation-v2'
      ))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "copper_attribute_allocation_operations"
          WHERE "rules_version" = 'copper-attribute-allocation-v2'
        ) THEN
          RAISE EXCEPTION 'cannot remove bulk allocation v2 after operation evidence exists'
            USING ERRCODE = '23514';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "copper_attribute_allocation_operations"
      DROP CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"
    `);
    await queryRunner.query(`
      ALTER TABLE "copper_attribute_allocation_operations"
      ADD CONSTRAINT "CHK_copper_attribute_allocation_operation_rules"
      CHECK ("rules_version" = 'copper-attribute-allocation-v1')
    `);
  }
}
