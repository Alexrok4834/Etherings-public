import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { MobileRefreshToken, MobileRefreshTokenStatus } from '../src/auth/mobile-refresh-token.entity';
import { MobileSessionConfigService } from '../src/auth/mobile-session-config.service';
import { MobileSessionService } from '../src/auth/mobile-session.service';
import { User } from '../src/auth/user.entity';
import { StepSyncInstallation } from '../src/step-sync/step-sync-installation.entity';
import { CreateMobileRefreshTokens1786492800000 } from '../src/migrations/1786492800000-create-mobile-refresh-tokens';
import { CreateStepSyncSchema1786406400000 } from '../src/migrations/1786406400000-create-step-sync-schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, StepSyncInstallation, MobileRefreshToken],
});
const fakeAuth = {
  signUserToken: async (user: User) => `qa-access:${user.id}:${randomUUID()}`,
} as AuthService;
const config = {
  refreshTokenTtlSeconds: 30 * 86_400,
  assertSecureRefreshTransport: () => undefined,
} as MobileSessionConfigService;

function errorCode(error: unknown) {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  return response && typeof response === 'object' ? (response as { code?: string }).code : undefined;
}

function tokenHash(rawToken: string) {
  return createHash('sha256').update(rawToken).digest('hex');
}

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const stepMigration = new CreateStepSyncSchema1786406400000();
  const migration = new CreateMobileRefreshTokens1786492800000();
  const addedStepSchema = !(await runner.hasTable('step_sync_installations'));
  if (await runner.hasTable('mobile_refresh_tokens')) {
    throw new Error('Disposable QA requires mobile_refresh_tokens to be absent before the run');
  }
  if (addedStepSchema) await runMigration(runner, stepMigration, 'up');
  await runMigration(runner, migration, 'up');
  assert.equal(await runner.hasTable('mobile_refresh_tokens'), true);
  await runMigration(runner, migration, 'down');
  assert.equal(await runner.hasTable('mobile_refresh_tokens'), false);
  await runMigration(runner, migration, 'up');
  const users = dataSource.getRepository(User);
  const tokens = dataSource.getRepository(MobileRefreshToken);
  const user = await users.save(users.create({
    telegramId: `mobile-refresh-qa-${randomUUID()}`,
    username: 'mobile_refresh_qa',
    firstName: 'Mobile Refresh',
    lastName: 'QA',
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: new Date(),
  }));
  const service = new MobileSessionService(dataSource, fakeAuth, config);

  try {
    const installationId = randomUUID();
    const issued = await service.issue(user, installationId);
    const stored = await tokens.findOneByOrFail({ userId: user.id });
    assert.notEqual(stored.tokenHash, issued.refreshToken);
    assert.equal(JSON.stringify(stored).includes(issued.refreshToken), false);
    await assert.rejects(
      () => tokens.insert(tokens.create({
        familyId: randomUUID(),
        userId: user.id,
        installationRecordId: stored.installationRecordId,
        tokenHash: tokenHash(randomUUID()),
        parentTokenId: null,
        replacedByTokenId: null,
        status: MobileRefreshTokenStatus.Active,
        expiresAt: new Date(Date.now() + 86_400_000),
        consumedAt: null,
        revokedAt: null,
        revocationReason: null,
      })),
      (error) => (error as { code?: string }).code === '23505',
    );

    const rotated = await service.refresh(issued.refreshToken, installationId);
    assert.notEqual(rotated.refreshToken, issued.refreshToken);
    assert.equal(await tokens.countBy({ familyId: stored.familyId, status: MobileRefreshTokenStatus.Active }), 1);
    assert.equal(await tokens.countBy({ familyId: stored.familyId, status: MobileRefreshTokenStatus.Rotated }), 1);

    await assert.rejects(
      () => service.refresh(issued.refreshToken, installationId),
      (error) => errorCode(error) === 'REFRESH_TOKEN_REPLAYED',
    );
    assert.equal(await tokens.countBy({ familyId: stored.familyId, status: MobileRefreshTokenStatus.Active }), 0);
    assert.equal(await tokens.countBy({ familyId: stored.familyId, status: MobileRefreshTokenStatus.Revoked }), 2);

    const concurrentInstallationId = randomUUID();
    const concurrentIssued = await service.issue(user, concurrentInstallationId);
    const concurrentResults = await Promise.allSettled([
      service.refresh(concurrentIssued.refreshToken, concurrentInstallationId),
      service.refresh(concurrentIssued.refreshToken, concurrentInstallationId),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(
      concurrentResults.filter((result) => result.status === 'rejected').map((result) => errorCode(result.reason)),
      ['REFRESH_TOKEN_REPLAYED'],
    );
    const concurrentFamily = await tokens.findOneByOrFail({ tokenHash: tokenHash(concurrentIssued.refreshToken) });
    assert.equal(await tokens.countBy({ familyId: concurrentFamily.familyId, status: MobileRefreshTokenStatus.Active }), 0);

    const logoutInstallationId = randomUUID();
    const logoutIssued = await service.issue(user, logoutInstallationId);
    const logoutFamily = await tokens.findOneByOrFail({ tokenHash: tokenHash(logoutIssued.refreshToken) });
    await service.logout(logoutIssued.refreshToken);
    await service.logout(logoutIssued.refreshToken);
    assert.equal(await tokens.countBy({ familyId: logoutFamily.familyId, status: MobileRefreshTokenStatus.Revoked }), 1);

    const mismatchInstallationId = randomUUID();
    const mismatchIssued = await service.issue(user, mismatchInstallationId);
    await assert.rejects(
      () => service.refresh(mismatchIssued.refreshToken, randomUUID()),
      (error) => errorCode(error) === 'REFRESH_TOKEN_INSTALLATION_MISMATCH',
    );

    const reloginInstallationId = randomUUID();
    const firstLogin = await service.issue(user, reloginInstallationId);
    const firstLoginRow = await tokens.findOneByOrFail({ tokenHash: tokenHash(firstLogin.refreshToken) });
    await service.issue(user, reloginInstallationId);
    const reloginRows = await tokens.findBy({ installationRecordId: firstLoginRow.installationRecordId });
    assert.equal(reloginRows.filter((token) => token.status === MobileRefreshTokenStatus.Active).length, 1);
    assert.equal(reloginRows.filter((token) => token.revocationReason === 'REAUTHENTICATED').length, 1);

    console.log(JSON.stringify({
      hashOnlyStorage: true,
      oneActiveTokenPerInstallationConstraint: true,
      rotation: true,
      replayFamilyRevocation: true,
      concurrentReplayFamilyRevocation: true,
      installationBinding: true,
      reloginRevocation: true,
      logoutIdempotent: true,
    }, null, 2));
  } finally {
    await users.delete({ id: user.id });
    await runMigration(runner, migration, 'down');
    if (addedStepSchema) await runMigration(runner, stepMigration, 'down');
    await runner.release();
    await dataSource.destroy();
  }
}

async function runMigration(runner: QueryRunner, migration: MigrationInterface, direction: 'up' | 'down') {
  await runner.startTransaction();
  try {
    await migration[direction](runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

void main();
