import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { MobileRegistrationService } from '../src/auth/mobile-registration.service';
import { MobileCredential } from '../src/auth/mobile-credential.entity';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { User } from '../src/auth/user.entity';
import { Balance } from '../src/balance/balance.entity';
import { CreateMobileCredentials1786665600000 } from '../src/migrations/1786665600000-create-mobile-credentials';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!databaseName.includes('qa')) throw new Error('Refusing to use a database whose name does not contain qa');

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, MobileCredential, Balance],
});

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const migration = new CreateMobileCredentials1786665600000();

  if (await runner.hasTable('mobile_credentials')) {
    throw new Error('Disposable QA requires mobile_credentials to be absent before the run');
  }

  await runMigration(runner, migration, 'up');
  assert.equal(await runner.hasTable('mobile_credentials'), true);
  await runMigration(runner, migration, 'down');
  assert.equal(await runner.hasTable('mobile_credentials'), false);
  await runMigration(runner, migration, 'up');

  const users = dataSource.getRepository(User);
  const credentials = dataSource.getRepository(MobileCredential);
  const passwordHasher = new PasswordHasherService();
  const user = await users.save(users.create({
    telegramId: `mobile-credential-qa-${randomUUID()}`,
    username: 'credential_qa',
    firstName: 'Credential QA',
    lastName: null,
    photoUrl: null,
    isAdmin: false,
    lastLoginAt: new Date(),
  }));

  try {
    const passwordHash = await passwordHasher.hash('qa-password-value');
    const stored = await credentials.save(credentials.create({
      userId: user.id,
      username: 'credential_qa',
      passwordHash,
      passwordChangedAt: null,
    }));
    assert.equal(stored.passwordHash.includes('qa-password-value'), false);
    assert.equal(await passwordHasher.verify('qa-password-value', stored.passwordHash), true);

    await assert.rejects(
      () => credentials.insert(credentials.create({
        userId: user.id,
        username: 'different_username',
        passwordHash,
        passwordChangedAt: null,
      })),
      (error) => (error as { code?: string }).code === '23505',
    );

    const secondUser = await users.save(users.create({
      telegramId: `mobile-credential-qa-${randomUUID()}`,
      username: 'credential_qa_2',
      firstName: 'Credential QA 2',
      lastName: null,
      photoUrl: null,
      isAdmin: false,
      lastLoginAt: new Date(),
    }));
    await assert.rejects(
      () => credentials.insert(credentials.create({
        userId: secondUser.id,
        username: stored.username.toUpperCase(),
        passwordHash,
        passwordChangedAt: null,
      })),
      (error) => (error as { code?: string }).code === '23505',
    );
    await users.delete({ id: secondUser.id });

    const registeredUsername = `qa_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const registrationService = new MobileRegistrationService(dataSource, passwordHasher);
    const registeredUser = await registrationService.register({
      username: registeredUsername,
      password: 'qa-registration-password',
      displayName: 'QA Registered Player',
    });
    const registeredCredential = await credentials.findOneByOrFail({ userId: registeredUser.id });
    const registeredBalance = await dataSource.getRepository(Balance).findOneByOrFail({ userId: registeredUser.id });
    assert.equal(registeredCredential.username, registeredUsername);
    assert.equal(await passwordHasher.verify('qa-registration-password', registeredCredential.passwordHash), true);
    assert.equal(registeredBalance.ertBalance, 0);
    assert.equal(registeredBalance.lifetimeEarnedErt, 0);
    assert.equal(registeredBalance.lifetimeSpentErt, 0);
    await users.delete({ id: registeredUser.id });

    await users.delete({ id: user.id });
    assert.equal(await credentials.countBy({ userId: user.id }), 0);

    console.log(JSON.stringify({
      migrationUpDown: true,
      saltedHashStorage: true,
      oneCredentialPerUser: true,
      caseInsensitiveUniqueUsername: true,
      atomicRegistration: true,
      userDeleteCascade: true,
    }, null, 2));
  } finally {
    await users.delete({ id: user.id });
    await runMigration(runner, migration, 'down');
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
