import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlphaServer } from '../src/server.js';

const TOKEN = 'a'.repeat(64);

async function withServer(handler, verify) {
  const server = createAlphaServer({}, null, null, null, null, null, null, null,
    undefined, null, handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await verify(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Alpha step-sync route is absent by default and never adds legacy Walk', async () => {
  await withServer(null, async url => {
    for (const path of ['/step-sync/batches', '/walk/sessions/start']) {
      const response = await fetch(url + path, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 404);
    }
  });
});

test('gated Alpha step-sync route forwards only bounded JSON and bearer token', async () => {
  let calls = 0;
  const handler = { async receive(token, body) {
    calls++;
    if (!token) return { status: 401, body: { code: 'AUTH_REQUIRED' } };
    assert.equal(token, TOKEN);
    assert.deepEqual(body, { source: 'android_step_counter' });
    return { status: 200, body: { status: 'ACCEPTED' } };
  } };
  await withServer(handler, async url => {
    const post = (body, authorization = `Bearer ${TOKEN}`) => fetch(
      url + '/step-sync/batches', { method: 'POST',
        headers: { authorization, 'content-type': 'application/json' }, body });
    const accepted = await post('{"source":"android_step_counter"}');
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: 'ACCEPTED' });
    assert.equal((await post('{}', '')).status, 401);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('x'.repeat(16_385))).status, 413);
    assert.equal((await fetch(url + '/walk/sessions/start', {
      method: 'POST', body: '{}' })).status, 404);
    assert.equal(calls, 2);
  });
});
