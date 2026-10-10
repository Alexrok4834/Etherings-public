import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlphaServer } from '../src/server.js';

const TOKEN = 'a'.repeat(64);

test('starter route reserves Silver only after Cooper claim succeeds', async () => {
  let cooperStatus = 409;
  let walletBound = false;
  let reservations = 0;
  const starterCooper = {
    async claim(token) {
      assert.equal(token, TOKEN);
      return cooperStatus === 200
        ? { status: 200, body: { ring: { id: 'starter-cooper' }, walletBound } }
        : { status: 409, body: { message: 'Verified wallet binding required.' } };
    },
  };
  const silver = { async reserve(token) {
    assert.equal(token, TOKEN);
    reservations++;
    return { status: 200, body: { status: 'pending', issuanceId: 'issuance' } };
  } };
  const server = createAlphaServer({}, null, null, silver, null, null, null, starterCooper);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/starter/claim`;
    const claim = () => fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}' });
    assert.equal((await claim()).status, 409);
    assert.equal(reservations, 0);
    cooperStatus = 200;
    const beforeWallet = await claim();
    assert.equal(beforeWallet.status, 200);
    assert.deepEqual(await beforeWallet.json(), {
      ring: { id: 'starter-cooper' }, silver: { status: 'awaiting_wallet' },
    });
    assert.equal(reservations, 0);
    walletBound = true;
    const response = await claim();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ring: { id: 'starter-cooper' },
      silver: { status: 'pending', issuanceId: 'issuance' },
    });
    assert.equal(reservations, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
