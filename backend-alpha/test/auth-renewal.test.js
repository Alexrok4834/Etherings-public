import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createAuth } from '../src/auth.js';
import { CaptureMailTransport } from '../src/mail.js';
import { createAlphaServer } from '../src/server.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/alpha_42_disposable')
  throw new Error('ALPHA_TEST_DATABASE_URL must target alpha_42_disposable');

test('Alpha renewal preserves login across access expiry and revokes replay/logout/password change', async () => {
  const schema = `alpha_renew_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const number of ['001_alpha_auth', '017_alpha_m2e_step_batches',
      '036_alpha_refresh_sessions']) {
      await pool.query(await readFile(new URL(`../schema/${number}.sql`, import.meta.url), 'utf8'));
    }
    let clock = Date.now();
    const mailer = new CaptureMailTransport();
    server = createAlphaServer(createAuth({ pool, mailer,
      codeSecret: 'disposable-alpha-renewal-only-secret-2026', now: () => clock }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body, accessToken) => {
      const response = await fetch(origin + path, { method: 'POST',
        headers: { 'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(body) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    const me = async accessToken => (await fetch(origin + '/auth/me', {
      headers: { authorization: `Bearer ${accessToken}` }
    })).status;
    const email = 'renewal@alpha.test';
    const password = 'disposable password for renewal';
    const installationId = randomUUID();
    assert.equal((await post('/auth/register', { email, password })).status, 202);
    const code = mailer.messages.at(-1).code;
    const verified = await post('/auth/verify', { email, code, installationId });
    assert.equal(verified.status, 200);
    assert.match(verified.body.refreshToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await me(verified.body.accessToken), 200);
    clock += 24 * 60 * 60_000 + 1;
    assert.equal(await me(verified.body.accessToken), 401);
    const rotated = await post('/auth/refresh', {
      refreshToken: verified.body.refreshToken, installationId });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.accessToken, verified.body.accessToken);
    assert.equal(await me(rotated.body.accessToken), 200);
    assert.equal((await post('/auth/refresh', {
      refreshToken: verified.body.refreshToken, installationId })).status, 401);
    assert.equal(await me(rotated.body.accessToken), 401);
    assert.equal((await post('/auth/refresh', {
      refreshToken: rotated.body.refreshToken, installationId })).status, 401);

    const loggedIn = await post('/auth/login', { email, password, installationId });
    assert.equal(loggedIn.status, 200);
    assert.equal((await post('/auth/refresh-logout', {
      refreshToken: loggedIn.body.refreshToken })).status, 204);
    assert.equal(await me(loggedIn.body.accessToken), 401);
    assert.equal((await post('/auth/refresh', {
      refreshToken: loggedIn.body.refreshToken, installationId })).status, 401);

    const mismatch = await post('/auth/login', { email, password, installationId });
    assert.equal(mismatch.status, 200);
    assert.equal((await post('/auth/refresh', {
      refreshToken: mismatch.body.refreshToken, installationId: randomUUID() })).status, 401);
    assert.equal((await post('/auth/refresh', {
      refreshToken: mismatch.body.refreshToken, installationId })).status, 401);

    const changed = await post('/auth/login', { email, password, installationId });
    assert.equal(changed.status, 200);
    assert.equal((await post('/auth/change-password', {
      currentPassword: password, newPassword: 'new disposable password for renewal'
    }, changed.body.accessToken)).status, 204);
    assert.equal(await me(changed.body.accessToken), 200);
    assert.equal((await post('/auth/refresh', {
      refreshToken: changed.body.refreshToken, installationId })).status, 401);
    assert.equal(await me(changed.body.accessToken), 401);

    const legacy = await post('/auth/login', {
      email, password: 'new disposable password for renewal' });
    assert.equal(legacy.status, 200);
    assert.equal('refreshToken' in legacy.body, false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
