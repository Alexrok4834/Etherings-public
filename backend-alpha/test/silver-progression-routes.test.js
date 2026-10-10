import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlphaServer } from '../src/server.js';
import { createSilverProgressionHttp } from '../src/silver-progression-http.js';

const TOKEN = 'a'.repeat(64);
const MINT = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const auth = { me: async () => ({ status: 200, body: { id: 'account' } }) };

async function request(server, path, body) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('Silver routes are absent until explicitly mounted, then stay narrow', async () => {
  const disabled = createAlphaServer(auth, null);
  assert.equal((await request(disabled,
    `/me/silver/${MINT}/progression/prepare`, {})).status, 404);
  const progression = { prepare: async () => ({ status: 200, body: { code: 'prepare' } }),
    review: async () => ({ status: 200, body: { code: 'review' } }) };
  const allocation = { review: async () => ({ status: 200, body: { code: 'points' } }) };
  const mounted = (...rest) => createAlphaServer(auth, null,
    null, null, null, null, null, null, undefined, null, null, null,
    null, null, null, null, progression, allocation, ...rest);
  assert.equal((await request(mounted(),
    `/me/silver/${MINT}/progression/prepare`, {})).body.code, 'prepare');
  assert.equal((await request(mounted(),
    '/me/silver/progression/review', {})).body.code, 'review');
  assert.equal((await request(mounted(),
    '/me/silver/points/review', {})).body.code, 'points');
  assert.equal((await request(mounted(), '/me/silver/points/arbitrary', {})).status, 404);
});

test('Silver review reports insufficient Devnet SOL before wallet signing', async () => {
  const insufficient = Object.assign(new Error('insufficient SOL'),
    { code: 'SILVER_SOL_INSUFFICIENT' });
  const http = createSilverProgressionHttp({ auth,
    progression: { prepare: async () => ({ status: 200 }) },
    flow: { review: async () => { throw insufficient; },
      refresh: async () => { throw insufficient; },
      submit: async () => ({}), status: async () => ({}) } });
  const operationId = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(await http.review(TOKEN, { operationId }),
    { status: 409, body: { code: 'SILVER_SOL_INSUFFICIENT' } });
  assert.deepEqual(await http.refresh(TOKEN, { operationId, approved: {} }),
    { status: 409, body: { code: 'SILVER_SOL_INSUFFICIENT' } });
});
