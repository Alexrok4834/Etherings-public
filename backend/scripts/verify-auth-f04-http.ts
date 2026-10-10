import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const target = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (!target || target.hostname !== '127.0.0.1' || target.pathname !== '/etherings_f04_qa'
  || process.env.AUTH_F04_QA_CONFIRM !== 'disposable') {
  throw new Error('A confirmed loopback etherings_f04_qa database is required');
}
process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = randomUUID();
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Tokens = { accessToken: string; refreshToken: string; user: { id: string } };
type Response = { status: number; body: Record<string, unknown> };

async function main() {
  const [{ AppModule }, { HttpExceptionFilter }] = await Promise.all([
    import('../dist/app.module.js'),
    import('../dist/common/http-exception.filter.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  let database: DataSource | undefined;
  let restoreQuery: (() => void) | undefined;
  const outagePhase = process.env.AUTH_F04_OUTAGE_PHASE === 'true';
  try {
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    if (outagePhase) {
      const installationId = randomUUID();
      const session = await register(base, `f04_${randomUUID().slice(0, 8)}`, `Qa-${randomUUID()}`, installationId);
      console.log('F04_DATABASE_OUTAGE_READY');
      process.stdin.resume();
      await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
      process.stdin.pause();
      const access = await getMe(base, session.accessToken);
      const renewable = await refresh(base, session.refreshToken, installationId);
      assert.notEqual(access.status, 200, 'access succeeded while revocation database was unavailable');
      assert.notEqual(renewable.status, 200, 'refresh succeeded while database was unavailable');
      console.log(JSON.stringify({ databaseUnavailable: { accessStatus: access.status, refreshStatus: renewable.status } }));
      return;
    }
    const observations: Record<string, unknown> = {};

    const a = randomUUID();
    const username = `f04_${a.slice(0, 8)}`;
    const oldPassword = `Old-${randomUUID()}`;
    const newPassword = `New-${randomUUID()}`;
    const first = await register(base, username, oldPassword, a);
    const payload = JSON.parse(Buffer.from(first.accessToken.split('.')[1], 'base64url').toString()) as { exp: number; iat: number };
    observations.accessTtlSeconds = payload.exp - payload.iat;
    assert.equal(observations.accessTtlSeconds, 86_400);
    assert.equal((await getMe(base, first.accessToken)).status, 200);
    const logout = await api(base, '/auth/mobile-logout', { refreshToken: first.refreshToken });
    const oldAccessAfterLogout = await getMe(base, first.accessToken);
    const oldRefreshAfterLogout = await refresh(base, first.refreshToken, a);
    observations.logout = { status: logout.status, oldAccess: oldAccessAfterLogout.status, refresh: oldRefreshAfterLogout.status };
    assert.equal(logout.status, 204);
    assert.equal(oldAccessAfterLogout.status, 200);
    assert.equal(oldRefreshAfterLogout.status, 401);

    const loginA = await login(base, username, oldPassword, a);
    const b = randomUUID();
    const loginB = await login(base, username, oldPassword, b);
    const familyA = await family(database, loginA.refreshToken);
    const familyB = await family(database, loginB.refreshToken);
    assert.notEqual(familyA, familyB);
    const logoutA = await api(base, '/auth/mobile-logout', { refreshToken: loginA.refreshToken });
    const refreshA = await refresh(base, loginA.refreshToken, a);
    const refreshB = await refresh(base, loginB.refreshToken, b);
    observations.twoDevices = {
      distinctFamilies: familyA !== familyB,
      logoutA: logoutA.status,
      refreshA: refreshA.status,
      refreshB: refreshB.status,
      familyAActive: await active(database, familyA),
      familyBActive: await active(database, familyB),
    };
    assert.equal(logoutA.status, 204);
    assert.equal(refreshA.status, 401);
    assert.equal(refreshB.status, 200);
    assert.equal((observations.twoDevices as { familyAActive: number }).familyAActive, 0);
    assert.equal(observations.twoDevices && (observations.twoDevices as { familyBActive: number }).familyBActive, 1);

    const changed = await api(base, '/me/password', { currentPassword: oldPassword, newPassword }, loginB.accessToken);
    const accessAfterPassword = await getMe(base, loginB.accessToken);
    const refreshAfterPassword = await refresh(base, String(refreshB.body.refreshToken), b);
    const oldLogin = await api(base, '/auth/mobile-password', { username, password: oldPassword, installationId: b });
    const newLogin = await login(base, username, newPassword, b);
    observations.passwordChange = {
      status: changed.status,
      reauthenticationRequired: changed.body.reauthenticationRequired,
      oldAccess: accessAfterPassword.status,
      oldRefresh: refreshAfterPassword.status,
      oldPasswordLogin: oldLogin.status,
      newPasswordLogin: 200,
    };
    assert.equal(changed.status, 200);
    assert.equal(changed.body.reauthenticationRequired, true);
    assert.equal(accessAfterPassword.status, 200);
    assert.equal(refreshAfterPassword.status, 401);
    assert.equal(oldLogin.status, 401);
    assert.ok(newLogin.refreshToken);

    const raceDevice = randomUUID();
    const raceOld = `Old-${randomUUID()}`;
    const raceNew = `New-${randomUUID()}`;
    const raceUser = await register(base, `f04_${randomUUID().slice(0, 8)}`, raceOld, raceDevice);
    const targetHash = createHash('sha256').update(raceUser.refreshToken).digest('hex');
    let signalReady = () => {};
    let signalRelease = () => {};
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    restoreQuery = gateRefreshSelect(database, targetHash, signalReady, release);
    const rotating = refresh(base, raceUser.refreshToken, raceDevice);
    await bounded(ready, 'refresh did not lock the original token');
    const changing = api(base, '/me/password', { currentPassword: raceOld, newPassword: raceNew }, raceUser.accessToken);
    await waitForPasswordChange(database, raceUser.user.id);
    signalRelease();
    const [rotated, passwordResult] = await Promise.all([rotating, changing]);
    restoreQuery();
    restoreQuery = undefined;
    const activeRows = await database.query('SELECT count(*)::int AS count FROM mobile_refresh_tokens WHERE user_id = $1 AND status = $2', [raceUser.user.id, 'ACTIVE']);
    const refreshAfterRace = rotated.status === 200
      ? await refresh(base, String(rotated.body.refreshToken), raceDevice)
      : null;
    observations.refreshVsPasswordChange = {
      refreshStatus: rotated.status,
      passwordStatus: passwordResult.status,
      activeAfterPassword: activeRows[0].count,
      rotatedRefreshAfterPassword: refreshAfterRace?.status ?? null,
    };
    assert.equal(passwordResult.status, 200);
    assert.equal(activeRows[0].count, 0, 'password change left an active refresh token');
    if (refreshAfterRace) assert.equal(refreshAfterRace.status, 401);
    console.log(JSON.stringify(observations, null, 2));
  } finally {
    restoreQuery?.();
    if (database?.isInitialized && !outagePhase) await database.dropDatabase();
    await app.close();
  }
}

function gateRefreshSelect(database: DataSource, hash: string, signalReady: () => void, release: Promise<void>) {
  const runner = database.createQueryRunner();
  const prototype = Object.getPrototypeOf(runner) as { query: (query: string, parameters?: unknown[], structured?: boolean) => Promise<unknown> };
  const original = prototype.query;
  let seen = false;
  prototype.query = async function (query, parameters, structured) {
    const result = await original.call(this, query, parameters, structured);
    if (!seen && query.includes('mobile_refresh_tokens') && query.includes('FOR UPDATE') && parameters?.includes(hash)) {
      seen = true;
      signalReady();
      await release;
    }
    return result;
  };
  return () => { prototype.query = original; void runner.release(); };
}

async function waitForPasswordChange(database: DataSource, userId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await database.query('SELECT password_changed_at FROM mobile_credentials WHERE user_id = $1', [userId]);
    if (row?.password_changed_at) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Password change did not reach credential save while refresh held the token lock');
}

async function bounded(promise: Promise<void>, message: string) {
  await Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 10_000))]);
}

async function family(database: DataSource, raw: string): Promise<string> {
  const [row] = await database.query('SELECT family_id FROM mobile_refresh_tokens WHERE token_hash = $1', [createHash('sha256').update(raw).digest('hex')]);
  assert.ok(row);
  return row.family_id;
}

async function active(database: DataSource, familyId: string): Promise<number> {
  const [row] = await database.query('SELECT count(*)::int AS count FROM mobile_refresh_tokens WHERE family_id = $1 AND status = $2', [familyId, 'ACTIVE']);
  return row.count;
}

async function register(base: string, username: string, password: string, installationId: string): Promise<Tokens> {
  const result = await api(base, '/auth/mobile-register', { username, password, installationId, displayName: 'F04 Synthetic' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body as Tokens;
}

async function login(base: string, username: string, password: string, installationId: string): Promise<Tokens> {
  const result = await api(base, '/auth/mobile-password', { username, password, installationId });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as Tokens;
}

function getMe(base: string, accessToken: string) { return api(base, '/me', undefined, accessToken, 'GET'); }
function refresh(base: string, refreshToken: string, installationId: string) {
  return api(base, '/auth/mobile-refresh', { refreshToken, installationId });
}
async function api(base: string, path: string, body?: object, token?: string, method = 'POST'): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: response.status === 204 ? {} : await response.json() as Record<string, unknown> };
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
