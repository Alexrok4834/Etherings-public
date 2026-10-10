import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createSolanaRpc, address, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import pg from 'pg';
import { createEruProof } from '../src/eru.js';
import { createAlphaServer } from '../src/server.js';

const root = process.env.ERU_PROOF_DIR;
const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (root !== '/tmp/etherings-alpha-eru-http-proof' ||
    databaseUrl !== 'postgres://postgres@127.0.0.1:15432/postgres') {
  throw new Error('Exact disposable validator and database required');
}

const policy = JSON.parse(await readFile(`${root}/evidence/wallet-policy.json`, 'utf8'));
const secret = Uint8Array.from(JSON.parse(await readFile(`${root}/program-keys/synthetic-wallet.json`, 'utf8')));
assert.equal(secret.length, 64);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(secret.subarray(0, 32))]),
  format: 'der', type: 'pkcs8',
});
secret.fill(0);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
let server;
try {
  for (const name of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
    '003_alpha_eru_intents.sql']) {
    await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
  }
  const accountId = randomUUID();
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO alpha_accounts (id, email_normalized, password_hash, verified_at)
     VALUES ($1, $2, 'synthetic-proof-only', now())`,
    [accountId, `${accountId}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO alpha_sessions (token_hash, account_id, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), accountId],
  );
  await pool.query(
    `INSERT INTO alpha_wallet_bindings (account_id, wallet_address, environment)
     VALUES ($1, $2, 'alpha-local')`,
    [accountId, policy.authority],
  );

  const rpcUrl = 'http://127.0.0.1:18889';
  const rpc = createSolanaRpc(rpcUrl);
  const eru = createEruProof({ pool, policy, rpcUrl });
  server = createAlphaServer({}, {}, eru);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const balances = async () => Promise.all(['source', 'destination', 'treasury'].map(async field => {
    const { value } = await rpc.getTokenAccountBalance(address(policy[field]),
      { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
  }));

  const before = await balances();
  const issued = await post('/eru/intent', {});
  assert.equal(issued.status, 200);
  const message = Buffer.from(issued.body.message, 'base64');
  const decoded = getCompiledTransactionMessageDecoder().decode(message);
  const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
  assert.equal(decoded.version, 'legacy');
  assert.equal(instructions.length, 2);
  assert.equal(instructions[1].programAddress, policy.gateway);
  assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(1), 30_000_000_000n);
  assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(9), 1n);
  assert.equal(instructions[1].accounts[2].address, policy.destination);
  assert.equal(instructions[1].accounts[3].address, policy.treasury);

  const signatureBase64 = sign(null, message, privateKey).toString('base64');
  const submitted = await post('/eru/submit', { id: issued.body.id, signatureBase64 });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'confirmed');
  const { value: statuses } = await rpc.getSignatureStatuses(
    [submitted.body.transactionSignature]).send();
  assert.equal(statuses[0]?.err, null);
  assert.ok(['confirmed', 'finalized'].includes(statuses[0]?.confirmationStatus));
  const after = await balances();
  assert.deepEqual(after.map((value, i) => value - before[i]),
    [-30_600_000_000n, 30_000_000_000n, 600_000_000n]);
  const { value: replay } = await rpc.getAccountInfo(address(policy.replay),
    { encoding: 'base64', commitment: 'confirmed' }).send();
  assert.equal(Buffer.from(replay.data[0], 'base64').readBigUInt64LE(0), 1n);
  assert.equal((await post('/eru/submit', { id: issued.body.id, signatureBase64 })).status, 409);
  assert.equal((await post('/eru/intent', {})).status, 409);
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents')).rows[0].status,
    'confirmed');
  console.log('PASS backend-alpha Kit real RPC, Gateway settlement, confirmation and replay');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
