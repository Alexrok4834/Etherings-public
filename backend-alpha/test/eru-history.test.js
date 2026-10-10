import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { once } from 'node:events';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createEruProof } from '../src/eru.js';
import { createAlphaServer } from '../src/server.js';

const token = 'a'.repeat(64);
const owner = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
const other = '9Xe9Eq77ovjKmGm9TGoTcHuYnGisaZq8K4DUi95zrrpF';
const accountId = 'd108ef96-b90e-4a98-830e-237dc800d63a';
const address = '11111111111111111111111111111111';
const policy = {
  source: address, mint: address, destination: address, treasury: address,
  authority: owner, config: address, meta: address,
  sysvar: 'Sysvar1nstructions1111111111111111111111111',
  tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, hook: address, replay: address,
  systemProgram: address, gateway: address,
};

test('history is durable, account/wallet/cluster-scoped, read-only and preserves all four states', async () => {
  let bound = owner;
  let rows = ['pending', 'confirmed', 'failed', 'unknown'].map((status, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`, nonce: String(index + 1),
    status, transaction_signature: status === 'pending' ? null : 'signature',
    created_at: new Date(`2026-09-25T12:0${index}:00.000Z`),
    account_id: accountId, wallet_address: owner, cluster: 'devnet',
  }));
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push(sql);
    if (sql.includes('FROM alpha_sessions')) {
      assert.equal(params[0], createHash('sha256').update(token).digest('hex'));
      return { rows: [{ id: accountId, wallet_address: bound }] };
    }
    if (sql.includes('FROM alpha_eru_intents')) {
      assert.match(sql, /ORDER BY created_at DESC, id DESC LIMIT 20/);
      assert.deepEqual(params, [accountId, bound, 'devnet']);
      return { rows: rows.filter(row => row.account_id === params[0] &&
        row.wallet_address === params[1] && row.cluster === params[2]) };
    }
    throw new Error('Unexpected query');
  } };
  const eru = createEruProof({ pool, policy, cluster: 'devnet',
    rpcUrl: 'http://127.0.0.1:18889', connection: {} });
  const server = createAlphaServer({}, null, eru);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/eru/history`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const history = await response.json();
    assert.equal(history.cluster, 'devnet');
    assert.equal(history.walletAddress, owner);
    assert.deepEqual(history.operations.map(operation => operation.status),
      ['pending', 'confirmed', 'failed', 'unknown']);
    assert.deepEqual(history.operations.map(operation => operation.nonce), ['1', '2', '3', '4']);
    assert.equal(history.operations[0].createdAt, '2026-09-25T12:00:00.000Z');
    assert.ok(queries.every(sql => sql.startsWith('SELECT')));

    rows.push({ ...rows[0], id: 'foreign', wallet_address: other });
    rows.push({ ...rows[0], id: 'local', cluster: 'local-validator' });
    assert.equal((await eru.history(token)).body.operations.length, 4);
    bound = null;
    assert.equal((await eru.history(token)).status, 409);
    bound = owner;
    rows = [{ ...rows[0], status: 'unexpected' }];
    await assert.rejects(eru.history(token), /Invalid stored ERU operation state/);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
