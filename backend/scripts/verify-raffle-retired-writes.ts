import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.slice(1).toLowerCase().includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}
if (process.env.RAFFLE_RETIRED_WRITE_QA_CONFIRM !== 'disposable') {
  throw new Error('RAFFLE_RETIRED_WRITE_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'raffle-retired-write-qa-secret-not-production';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

const adminRetiredCode = 'LEGACY_RAFFLE_ADMIN_WRITE_RETIRED';
const playerRetiredCode = 'LEGACY_RAFFLE_PLAYER_DRAW_RETIRED';

type Session = { accessToken: string; user: { id: string } };
type ApiResponse<T> = { status: number; body: T };
type RetiredCommand = { method: string; path: string; code: string; session: 'admin' | 'player' };

let app: INestApplication | undefined;
let dataSource: DataSource | undefined;

async function main() {
  try {
    const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
      import('../dist/app.module.js'),
      import('../dist/common/http-exception.filter.js'),
    ]);
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    dataSource = app.get(DataSource);

    const address = app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const player = await register(baseUrl, 'retired_write_player');
    const admin = await register(baseUrl, 'retired_write_admin');
    await dataSource.query('UPDATE users SET is_admin = true WHERE id = $1', [admin.user.id]);

    const fixtureId = randomUUID();
    const commands: RetiredCommand[] = [
      { method: 'POST', path: '/admin/rewards', code: adminRetiredCode, session: 'admin' },
      { method: 'PATCH', path: `/admin/rewards/${fixtureId}`, code: adminRetiredCode, session: 'admin' },
      { method: 'DELETE', path: `/admin/rewards/${fixtureId}`, code: adminRetiredCode, session: 'admin' },
      { method: 'POST', path: '/admin/raffle-pools', code: adminRetiredCode, session: 'admin' },
      { method: 'PATCH', path: `/admin/raffle-pools/${fixtureId}`, code: adminRetiredCode, session: 'admin' },
      { method: 'POST', path: `/admin/raffle-pools/${fixtureId}/rewards`, code: adminRetiredCode, session: 'admin' },
      { method: 'PATCH', path: `/admin/raffle-pools/${fixtureId}/rewards/${randomUUID()}`, code: adminRetiredCode, session: 'admin' },
      { method: 'POST', path: `/raffle/pools/${fixtureId}/draw`, code: playerRetiredCode, session: 'player' },
    ];

    const before = await databaseFingerprint();
    for (const command of commands) {
      await assertRetired(baseUrl, command, command.session === 'admin' ? admin : player);
    }
    const after = await databaseFingerprint();

    assert.equal(after.tableCount, before.tableCount);
    assert.equal(after.digest, before.digest);
    console.log(JSON.stringify({
      authenticatedRetiredCommands: commands.length,
      adminRetiredCommands: commands.filter((command) => command.session === 'admin').length,
      playerRetiredCommands: commands.filter((command) => command.session === 'player').length,
      stableGoneContracts: true,
      protectedTableCount: before.tableCount,
      databaseFingerprintUnchanged: true,
    }, null, 2));
  } finally {
    if (dataSource?.isInitialized) await dataSource.dropDatabase();
    if (app) await app.close();
  }
}

async function register(baseUrl: string, username: string) {
  const response = await api<Session>(baseUrl, '/auth/mobile-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `Qa-${randomUUID()}`,
      displayName: username,
      installationId: randomUUID(),
    }),
  });
  assert.equal(response.status, 201);
  assert.ok(response.body.accessToken);
  return response.body;
}

async function assertRetired(baseUrl: string, command: RetiredCommand, session: Session) {
  const response = await api<{ code?: string }>(baseUrl, command.path, {
    method: command.method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: command.method === 'DELETE' ? undefined : '{}',
  });
  assert.deepEqual(
    { status: response.status, code: response.body.code },
    { status: 410, code: command.code },
  );
}

async function databaseFingerprint() {
  const tables = await dataSource!.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  const tableDigests: string[] = [];
  for (const { table_name: tableName } of tables) {
    const identifier = `"${tableName.replaceAll('"', '""')}"`;
    const [row] = await dataSource!.query(`
      SELECT count(*)::text AS count,
        coalesce(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM ${identifier} t
    `) as Array<{ count: string; digest: string }>;
    tableDigests.push(`${tableName}:${row.count}:${row.digest}`);
  }
  return {
    tableCount: tables.length,
    digest: createHash('sha256').update(tableDigests.join('\n')).digest('hex'),
  };
}

async function api<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

void main();
