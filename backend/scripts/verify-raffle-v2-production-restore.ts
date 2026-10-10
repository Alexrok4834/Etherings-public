import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  discoverRaffleV2LegacySource,
  fingerprintRaffleV2LegacySource,
} from '../src/raffle/raffle-v2-consolidation';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^raffle_v2_prod_restore(?:_[a-z0-9]+)*_qa$/.test(databaseName)) {
  throw new Error('Refusing to inspect a database outside the approved Raffle v2 restore name');
}
const backupSha256 = process.env.RAFFLE_V2_BACKUP_SHA256;
if (!backupSha256 || !/^[A-F0-9]{64}$/.test(backupSha256)) {
  throw new Error('RAFFLE_V2_BACKUP_SHA256 must be an uppercase SHA-256');
}

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl, synchronize: false });

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const [{ transactionReadOnly }] = await runner.query(
      `SELECT current_setting('transaction_read_only') AS "transactionReadOnly"`,
    );
    assert.equal(transactionReadOnly, 'on', 'restore must default to read-only');
    await runner.startTransaction();
    try {
      const source = await discoverRaffleV2LegacySource(runner.manager);
      const { migrations, mappings, counts } = source;
      const publicMappings = mappings.map((mapping: Record<string, unknown>) => ({
        poolCode: mapping.poolCode,
        poolTitle: mapping.poolTitle,
        costErt: mapping.costErt,
        dailyUserAttemptLimit: mapping.dailyUserAttemptLimit,
        rewardCode: mapping.rewardCode,
        rewardTitle: mapping.rewardTitle,
        rewardType: mapping.rewardType,
        amount: mapping.amount,
        amountExact: mapping.amountExact,
        weight: mapping.weight,
        mappingActive: mapping.mappingActive,
      }));
      console.log(JSON.stringify({
        database: databaseName,
        backupSha256,
        transactionReadOnly: true,
        migrationCount: migrations.length,
        migrationFingerprint: sha256(migrations),
        activeLegacyPoolCount: new Set(mappings.map((mapping: Record<string, unknown>) => mapping.poolId)).size,
        activeMappings: publicMappings,
        counts,
        sourceFingerprint: fingerprintRaffleV2LegacySource(source),
      }, null, 2));
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

void main();
