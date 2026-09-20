import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import bs58 from 'bs58';
import pg from 'pg';
import { AccountRole, getCompiledTransactionMessageDecoder, getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAuth } from '../src/auth.js';
import { createEruProof } from '../src/eru.js';
import { CaptureMailTransport } from '../src/mail.js';
import { createAlphaServer } from '../src/server.js';
import { bindingMessage, createWalletBinding } from '../src/wallet.js';

const url = process.env.ALPHA_TEST_DATABASE_URL;
if (!url) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const mailer = new CaptureMailTransport();
const mail = mailer.messages;
let clock = Date.now();
let server;
let origin;
const options = {
  pool,
  mailer,
  codeSecret: 'disposable-proof-only-secret-with-32-chars',
  now: () => clock
};

async function start(wallet, eru = null) {
  server = createAlphaServer(createAuth(options), wallet, eru);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
}
async function stop() { if (server) await new Promise(resolve => server.close(resolve)); }
async function post(path, body) {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
async function me(token) {
  const response = await fetch(origin + '/auth/me', { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
}
async function walletPost(path, token, body) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
function keypair() {
  const pair = generateKeyPairSync('ed25519');
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: bs58.encode(publicBytes), privateKey: pair.privateKey };
}
function signed(challenge, key, address = key.address) {
  return {
    nonce: challenge.nonce, walletAddress: address, messageBase64: challenge.messageBase64,
    signatureBase64: sign(null, Buffer.from(challenge.messageBase64, 'base64'), key.privateKey).toString('base64')
  };
}
const password = 'correct horse battery Alpha 2026';
const codeFor = email => mail.findLast(item => item.email === email)?.code;
const countMail = email => mail.filter(item => item.email === email).length;

after(async () => { await stop(); await pool.end(); });

test('Alpha-only verified-email HTTP/PostgreSQL contract', async () => {
  const schema = await readFile(new URL('../schema/001_alpha_auth.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  await start();

  const email = 'first@alpha.test';
  const registered = await post('/auth/register', { email: ' First@Alpha.Test ', password });
  assert.equal(registered.status, 202);
  assert.deepEqual(await post('/auth/register', { email, password }), registered);
  assert.equal(countMail(email), 1);
  const challenge = (await pool.query('SELECT code_hash FROM alpha_email_challenges')).rows[0];
  assert.match(challenge.code_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(challenge.code_hash, codeFor(email));
  assert.equal((await post('/auth/login', { email, password })).status, 401);
  assert.equal((await me()).status, 401);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_sessions')).rows[0].n, 0);
  assert.equal((await post('/auth/verify', { email, code: codeFor(email) === '00000000' ? '00000001' : '00000000' })).status, 400);

  await stop();
  await start();
  const verified = await post('/auth/verify', { email, code: codeFor(email) });
  assert.equal(verified.status, 200);
  assert.match(verified.body.accessToken, /^[a-f0-9]{64}$/);
  assert.equal((await me(verified.body.accessToken)).body.email, email);
  assert.equal((await post('/auth/verify', { email, code: codeFor(email) })).status, 400);
  assert.equal((await post('/auth/login', { email, password })).status, 200);
  assert.equal((await post('/auth/login', { email, password: 'wrong password' })).status, 401);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_email_challenges')).rows[0].n, 0);

  const expired = 'expired@alpha.test';
  assert.equal((await post('/auth/register', { email: expired, password })).status, 202);
  const oldCode = codeFor(expired);
  clock += 11 * 60_000;
  assert.equal((await post('/auth/verify', { email: expired, code: oldCode })).status, 400);
  assert.equal((await post('/auth/login', { email: expired, password })).status, 401);

  const attempt = 'attempt@alpha.test';
  await post('/auth/register', { email: attempt, password });
  const attemptCode = codeFor(attempt);
  const wrongCode = attemptCode === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 5; i++) assert.equal((await post('/auth/verify', { email: attempt, code: wrongCode })).status, 400);
  assert.equal((await post('/auth/verify', { email: attempt, code: attemptCode })).status, 400);
  assert.equal((await pool.query('SELECT attempts FROM alpha_email_challenges c JOIN alpha_accounts a ON a.id = c.account_id WHERE a.email_normalized = $1', [attempt])).rows[0].attempts, 5);

  const limited = 'limited@alpha.test';
  await post('/auth/register', { email: limited, password });
  for (let i = 0; i < 5; i++) {
    clock += 61_000;
    assert.deepEqual(await post('/auth/resend', { email: limited }), registered);
  }
  const sent = countMail(limited);
  clock += 61_000;
  assert.equal((await post('/auth/resend', { email: limited })).status, 429);
  assert.equal(countMail(limited), sent);

  const hourly = 'hourly@alpha.test';
  for (let i = 0; i < 10; i++) assert.equal((await post('/auth/verify', { email: hourly, code: '12345678' })).status, 400);
  assert.equal((await post('/auth/verify', { email: hourly, code: '12345678' })).status, 429);
  const keyRows = await pool.query('SELECT count FROM alpha_rate_limits WHERE key = $1', [
    (await import('node:crypto')).createHash('sha256').update(`verify:${hourly}`).digest('hex')
  ]);
  assert.equal(keyRows.rows[0].count, 11);

  const unknown = 'missing@alpha.test';
  assert.deepEqual(await post('/auth/resend', { email: unknown }), registered);
  assert.deepEqual(await post('/auth/register', { email, password }), registered);
  assert.deepEqual(await post('/auth/register', { email: unknown, password }), registered);
  assert.equal((await post('/auth/login', { email: 'nobody@alpha.test', password })).status, 401);
  assert.deepEqual(await post('/auth/login', { email: 'nobody@alpha.test', password }),
    await post('/auth/login', { email: expired, password }));
  assert.equal((await post('/auth/verify', { email: 'nobody@alpha.test', code: '12345678' })).status, 400);

  const concurrent = 'concurrent@alpha.test';
  await post('/auth/register', { email: concurrent, password });
  const results = await Promise.all([
    post('/auth/verify', { email: concurrent, code: codeFor(concurrent) }),
    post('/auth/verify', { email: concurrent, code: codeFor(concurrent) })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  const rows = await pool.query('SELECT email_normalized, password_hash FROM alpha_accounts WHERE email_normalized = $1', [email]);
  assert.equal(rows.rowCount, 1);
  assert.match(rows.rows[0].password_hash, /^scrypt:/);
  assert.ok(!rows.rows[0].password_hash.includes(password));
  const constraints = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'alpha_accounts' AND indexdef LIKE '%UNIQUE%'");
  assert.ok(constraints.rows.some(row => row.indexname === 'alpha_accounts_email_normalized_key'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_sessions')).rows[0].n, 3);
  assert.equal((await fetch(origin + '/wallet')).status, 404);
  clock += 24 * 60 * 60_000;
  assert.equal((await me(verified.body.accessToken)).status, 401);
  const active = await post('/auth/login', { email, password });
  assert.equal(active.status, 200);
  const loggedOut = await fetch(origin + '/auth/logout', {
    method: 'POST', headers: { authorization: `Bearer ${active.body.accessToken}` }
  });
  assert.equal(loggedOut.status, 204);
  assert.equal((await me(active.body.accessToken)).status, 401);
});

const proveEruIntent = async () => {
  await pool.query(await readFile(new URL('../schema/003_alpha_eru_intents.sql', import.meta.url), 'utf8'));
  const proof = keypair();
  const other = keypair();
  const randomAddress = () => bs58.encode(randomBytes(32));
  const policy = {
    authority: proof.address, source: randomAddress(),
    destination: randomAddress(), treasury: randomAddress(), config: randomAddress(),
    replay: randomAddress(), mint: randomAddress(), meta: randomAddress(),
    sysvar: 'Sysvar1nstructions1111111111111111111111111',
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, hook: randomAddress(),
    systemProgram: '11111111111111111111111111111111', gateway: randomAddress()
  };
  const legacy = keypair();
  const legacyAccount = randomUUID();
  const legacyIntent = randomUUID();
  const legacyToken = randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO alpha_accounts (id, email_normalized, password_hash, verified_at) VALUES ($1,$2,$3,now())',
    [legacyAccount, `${legacyAccount}@example.invalid`, 'synthetic-test-only']
  );
  await pool.query(
    'INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,now() + interval \'1 hour\')',
    [createHash('sha256').update(legacyToken).digest('hex'), legacyAccount]
  );
  await pool.query(
    'INSERT INTO alpha_wallet_bindings (account_id, wallet_address, environment) VALUES ($1,$2,$3)',
    [legacyAccount, legacy.address, 'alpha-local']
  );
  await pool.query(
    `INSERT INTO alpha_eru_intents
      (id, account_id, wallet_address, nonce, message_base64, blockhash,
       last_valid_block_height, status, transaction_signature)
     VALUES ($1,$2,$3,1,$4,$5,100,'confirmed',$6)`,
    [legacyIntent, legacyAccount, legacy.address, Buffer.from('historical').toString('base64'),
      randomAddress(), 'historical-local-signature']
  );
  await pool.query(await readFile(new URL('../schema/004_alpha_eru_intent_cluster.sql', import.meta.url), 'utf8'));
  const historicalDevnet = randomUUID();
  const historicalDevnetAccount = randomUUID();
  await pool.query(
    'INSERT INTO alpha_accounts (id, email_normalized, password_hash, verified_at) VALUES ($1,$2,$3,now())',
    [historicalDevnetAccount, `${historicalDevnetAccount}@example.invalid`, 'synthetic-test-only']
  );
  await pool.query(
    `INSERT INTO alpha_eru_intents
      (id, account_id, cluster, wallet_address, nonce, message_base64, blockhash,
       last_valid_block_height, status, transaction_signature)
     VALUES ($1,$2,'devnet',$3,1,$4,$5,100,'confirmed',$6)`,
    [historicalDevnet, historicalDevnetAccount, legacy.address,
      Buffer.from('historical-devnet').toString('base64'), randomAddress(),
      'historical-devnet-signature']
  );
  await pool.query(await readFile(new URL('../schema/005_alpha_eru_reconciliation.sql', import.meta.url), 'utf8'));
  const preserved = (await pool.query(
    'SELECT cluster, status, transaction_signature FROM alpha_eru_intents WHERE id = $1',
    [legacyIntent]
  )).rows[0];
  assert.deepEqual(preserved, {
    cluster: 'local-validator', status: 'confirmed', transaction_signature: 'historical-local-signature'
  });
  assert.deepEqual((await pool.query(
    'SELECT cluster, status, transaction_signature FROM alpha_eru_intents WHERE id = $1',
    [historicalDevnet]
  )).rows[0], { cluster: 'devnet', status: 'confirmed',
    transaction_signature: 'historical-devnet-signature' });
  await assert.rejects(pool.query(
    "UPDATE alpha_eru_intents SET cluster = 'devnet' WHERE id = $1", [legacyIntent]
  ), { code: '23514' });
  let settled = false;
  let sent = 0;
  let submittedRaw;
  let slot = 1;
  let blockhashValid = true;
  const before = { source: 100_000_000_000n, destination: 0n, treasury: 0n };
  const after = { source: 69_400_000_000n, destination: 30_000_000_000n, treasury: 600_000_000n };
  function settlementMeta(raw) {
    const accounts = getCompiledTransactionMessageDecoder().decode(raw.subarray(65)).staticAccounts;
    const balances = values => ['source', 'destination', 'treasury'].map(field => ({
      accountIndex: accounts.indexOf(policy[field]), mint: policy.mint,
      uiTokenAmount: { amount: values[field].toString() }
    }));
    return { preTokenBalances: balances(before), postTokenBalances: balances(after) };
  }
  const connection = {
    getAccountInfo: async () => null,
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getSlot: async () => slot,
    getBlockHeight: async () => 1,
    isBlockhashValid: async () => blockhashValid,
    getLatestBlockhash: async () => ({ blockhash: randomAddress(), lastValidBlockHeight: 100 }),
    getTokenAccountBalance: async (key) => {
      const field = ['source', 'destination', 'treasury'].find(name => policy[name] === key);
      assert.ok(field);
      return { value: { amount: (settled ? after : before)[field].toString() } };
    },
    sendRawTransaction: async (raw) => {
      sent++; settled = true; submittedRaw = Buffer.from(raw);
      return bs58.encode(submittedRaw.subarray(1, 65));
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatus: async (signature) =>
      signature === bs58.encode(submittedRaw.subarray(1, 65))
        ? { confirmationStatus: 'finalized', err: null } : null,
    getTransaction: async () => ({ transaction: [submittedRaw.toString('base64'), 'base64'],
      meta: { err: null, ...settlementMeta(submittedRaw) } })
  };
  const wallet = createWalletBinding({ pool, environment: 'alpha-local', now: () => clock });
  const eru = createEruProof({ pool, policy, rpcUrl: 'http://127.0.0.1:18889', connection });
  await stop();
  await start(wallet, eru);

  async function account(address) {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO alpha_accounts (id, email_normalized, password_hash, verified_at) VALUES ($1,$2,$3,now())',
      [id, `${id}@example.invalid`, 'synthetic-test-only']
    );
    await pool.query(
      'INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,now() + interval \'1 hour\')',
      [createHash('sha256').update(token).digest('hex'), id]
    );
    if (address) await pool.query(
      'INSERT INTO alpha_wallet_bindings (account_id, wallet_address, environment) VALUES ($1,$2,$3)',
      [id, address, 'alpha-local']
    );
    return token;
  }
  const owner = await account(policy.authority);
  const unbound = await account(null);
  const foreign = await account(other.address);
  assert.equal((await walletPost('/eru/intent', '', {})).status, 401);
  assert.equal((await walletPost('/eru/intent', unbound, {})).status, 409);
  assert.equal((await walletPost('/eru/intent', foreign, {})).status, 409);
  const issued = await walletPost('/eru/intent', owner, {});
  assert.equal(issued.status, 200);
  const decoded = getCompiledTransactionMessageDecoder().decode(Buffer.from(issued.body.message, 'base64'));
  const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
  assert.equal(decoded.version, 'legacy');
  assert.equal(decoded.staticAccounts[0], policy.authority);
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0].programAddress, 'ComputeBudget111111111111111111111111111111');
  assert.equal(Buffer.from(instructions[0].data).toString('hex'), '02c0270900');
  assert.equal(instructions[1].programAddress, policy.gateway);
  assert.deepEqual(instructions[1].accounts.map(({ address, role }) => [address, role]), [
    [policy.source, AccountRole.WRITABLE], [policy.mint, AccountRole.READONLY],
    [policy.destination, AccountRole.WRITABLE], [policy.treasury, AccountRole.WRITABLE],
    [policy.authority, AccountRole.WRITABLE_SIGNER], [policy.config, AccountRole.WRITABLE],
    [policy.meta, AccountRole.READONLY], [policy.sysvar, AccountRole.READONLY],
    [policy.tokenProgram, AccountRole.READONLY], [policy.hook, AccountRole.READONLY],
    [policy.replay, AccountRole.WRITABLE], [policy.authority, AccountRole.WRITABLE_SIGNER],
    [policy.systemProgram, AccountRole.READONLY],
  ]);
  assert.equal(instructions[1].data[0], 1);
  assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(1), 30_000_000_000n);
  assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(9), 1n);
  assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(17), 9_999_999n);
  assert.equal((await walletPost('/eru/intent', owner, {})).body.id, issued.body.id);
  const wrong = sign(null, Buffer.from(issued.body.message, 'base64'), other.privateKey);
  assert.equal((await walletPost('/eru/submit', owner, {
    id: issued.body.id, signatureBase64: wrong.toString('base64')
  })).status, 400);
  const message = Buffer.from(issued.body.message, 'base64');
  const detached = sign(null, message, proof.privateKey);
  assert.equal((await walletPost('/eru/submit', foreign, {
    id: issued.body.id, signatureBase64: detached.toString('base64')
  })).status, 409);
  assert.equal((await walletPost('/eru/submit', owner, {
    id: issued.body.id, signatureBase64: detached.toString('base64')
  })).status, 200);
  assert.equal(sent, 1);
  assert.equal((await walletPost('/eru/submit', owner, {
    id: issued.body.id, signatureBase64: detached.toString('base64')
  })).status, 409);
  assert.equal((await walletPost('/eru/intent', owner, {})).status, 409);
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1', [issued.body.id])).rows[0].status, 'confirmed');

  const legacyPolicy = { ...policy, authority: legacy.address };
  const localLegacy = createEruProof({ pool, policy: legacyPolicy,
    rpcUrl: 'http://127.0.0.1:18889', connection });
  const devnet = createEruProof({ pool, policy: legacyPolicy,
    rpcUrl: 'http://127.0.0.1:18889', connection, cluster: 'devnet' });
  assert.equal((await localLegacy.issue(legacyToken)).status, 409);
  slot = 500_000_000;
  const devnetIssued = await devnet.issue(legacyToken);
  assert.equal(devnetIssued.status, 200);
  assert.equal(devnetIssued.body.cluster, 'devnet');
  const devnetInstruction = getInstructionsFromCompiledTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(Buffer.from(devnetIssued.body.message, 'base64')))[1];
  assert.equal(Buffer.from(devnetInstruction.data).readBigUInt64LE(17), 500_000_600n);
  assert.equal((await devnet.issue(legacyToken)).body.id, devnetIssued.body.id);
  blockhashValid = false;
  assert.equal((await devnet.issue(legacyToken)).status, 409);
  assert.equal((await devnet.submit(legacyToken, {
    id: devnetIssued.body.id, signatureBase64: Buffer.alloc(64).toString('base64')
  })).status, 409);
  blockhashValid = true;
  await assert.rejects(pool.query(
    `INSERT INTO alpha_eru_intents
      (id, account_id, cluster, wallet_address, nonce, message_base64, blockhash,
       last_valid_block_height, status)
     VALUES ($1, $2, 'devnet', $3, 1, $4, $5, 100, 'pending')`,
    [randomUUID(), legacyAccount, legacy.address,
      Buffer.from('duplicate').toString('base64'), randomAddress()]
  ), { code: '23505', constraint: 'alpha_eru_intents_account_cluster_nonce_key' });
  const dummySignature = Buffer.alloc(64).toString('base64');
  assert.equal((await devnet.submit(legacyToken, {
    id: legacyIntent, signatureBase64: dummySignature
  })).status, 409);
  assert.equal((await localLegacy.submit(legacyToken, {
    id: devnetIssued.body.id, signatureBase64: dummySignature
  })).status, 409);
  slot = 500_000_601;
  assert.equal((await devnet.submit(legacyToken, {
    id: devnetIssued.body.id, signatureBase64: dummySignature
  })).status, 409);
  const renewed = await devnet.issue(legacyToken);
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.body.id, devnetIssued.body.id);
  const renewedInstruction = getInstructionsFromCompiledTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(Buffer.from(renewed.body.message, 'base64')))[1];
  assert.equal(Buffer.from(renewedInstruction.data).readBigUInt64LE(9), 2n);
  assert.equal(Buffer.from(renewedInstruction.data).readBigUInt64LE(17), 500_001_201n);
  assert.equal((await devnet.issue(legacyToken)).body.id, renewed.body.id);
  const wrongCluster = createEruProof({ pool, policy: legacyPolicy,
    rpcUrl: 'http://127.0.0.1:18889', cluster: 'devnet',
    connection: { ...connection, getGenesisHash: async () => 'wrong-cluster' } });
  assert.equal((await wrongCluster.issue(legacyToken)).status, 409);
  assert.deepEqual((await pool.query(
    'SELECT cluster, status FROM alpha_eru_intents WHERE account_id = $1 ORDER BY cluster, status',
    [legacyAccount]
  )).rows, [
    { cluster: 'devnet', status: 'pending' },
    { cluster: 'devnet', status: 'pending' },
    { cluster: 'local-validator', status: 'confirmed' }
  ]);
  await stop();
  await start(wallet, devnet);
  assert.equal((await walletPost('/eru/intent', legacyToken, {})).body.id, renewed.body.id);
  assert.equal((await walletPost('/eru/submit', legacyToken, {
    id: legacyIntent, signatureBase64: dummySignature
  })).status, 409);

  async function lifecycleCase(initialMode) {
    const signer = keypair();
    const session = await account(signer.address);
    const activePolicy = { ...policy, authority: signer.address };
    const chain = { mode: initialMode, raw: null, sends: 0,
      mismatchedBytes: false, mismatchedBalance: false };
    const rpc = {
      ...connection,
      sendRawTransaction: async raw => {
        chain.raw = Buffer.from(raw);
        chain.sends++;
        if (chain.mode === 'absent') throw new Error('HTTP response lost after send');
        return bs58.encode(chain.raw.subarray(1, 65));
      },
      getSignatureStatus: async signature =>
        chain.raw && signature === bs58.encode(chain.raw.subarray(1, 65)) &&
        chain.mode !== 'absent' ? {
            confirmationStatus: 'finalized',
            err: chain.mode === 'failed' ? { InstructionError: [0, 'Custom'] } : null
          } : null,
      getTransaction: async () => chain.raw && chain.mode !== 'absent' ? {
        transaction: [(chain.mismatchedBytes
          ? Buffer.concat([chain.raw, Buffer.from([0])]) : chain.raw).toString('base64'), 'base64'],
        meta: { err: chain.mode === 'failed' ? { InstructionError: [0, 'Custom'] } : null,
          ...settlementMeta(chain.raw),
          ...(chain.mismatchedBalance ? { postTokenBalances: [] } : {}) }
      } : null
    };
    const service = () => createEruProof({ pool, policy: activePolicy,
      rpcUrl: 'http://127.0.0.1:18889', connection: rpc, cluster: 'devnet' });
    await stop();
    await start(wallet, service());
    const intent = await walletPost('/eru/intent', session, {});
    assert.equal(intent.status, 200);
    assert.deepEqual(await walletPost('/eru/reconcile', session, { id: intent.body.id }), {
      status: 200, body: { status: 'pending' }
    });
    const signature = sign(null, Buffer.from(intent.body.message, 'base64'), signer.privateKey);
    return { session, signer, intent, signature, chain, service };
  }

  const normal = await lifecycleCase('confirmed');
  const normalResult = await walletPost('/eru/submit', normal.session, {
    id: normal.intent.body.id, signatureBase64: normal.signature.toString('base64')
  });
  assert.equal(normalResult.status, 200);
  assert.equal(normalResult.body.status, 'confirmed');
  assert.equal(normalResult.body.transactionSignature, bs58.encode(normal.signature));
  assert.deepEqual((await pool.query(
    'SELECT status, transaction_signature FROM alpha_eru_intents WHERE id = $1',
    [normal.intent.body.id]
  )).rows[0], { status: 'confirmed', transaction_signature: bs58.encode(normal.signature) });
  assert.equal((await walletPost('/eru/reconcile', normal.session,
    { id: normal.intent.body.id })).body.status, 'confirmed');

  const lost = await lifecycleCase('absent');
  const lostSubmit = await walletPost('/eru/submit', lost.session, {
    id: lost.intent.body.id, signatureBase64: lost.signature.toString('base64')
  });
  assert.equal(lostSubmit.status, 503);
  assert.equal(lostSubmit.body.status, 'unknown');
  assert.deepEqual((await pool.query(
    'SELECT status, transaction_signature FROM alpha_eru_intents WHERE id = $1',
    [lost.intent.body.id]
  )).rows[0], { status: 'unknown', transaction_signature: bs58.encode(lost.signature) });
  assert.equal((await walletPost('/eru/reconcile', lost.session,
    { id: lost.intent.body.id })).body.status, 'unknown');
  assert.equal((await walletPost('/eru/reconcile', normal.session,
    { id: lost.intent.body.id })).status, 409);
  await stop();
  await start(wallet, lost.service());
  lost.chain.mode = 'confirmed';
  lost.chain.mismatchedBytes = true;
  assert.equal((await walletPost('/eru/reconcile', lost.session,
    { id: lost.intent.body.id })).body.status, 'unknown');
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1',
    [lost.intent.body.id])).rows[0].status, 'unknown');
  lost.chain.mismatchedBytes = false;
  lost.chain.mismatchedBalance = true;
  assert.equal((await walletPost('/eru/reconcile', lost.session,
    { id: lost.intent.body.id })).body.status, 'unknown');
  lost.chain.mismatchedBalance = false;
  const [recovered, duplicate] = await Promise.all([
    walletPost('/eru/reconcile', lost.session, { id: lost.intent.body.id }),
    walletPost('/eru/reconcile', lost.session, { id: lost.intent.body.id })
  ]);
  assert.equal(recovered.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(lost.chain.sends, 1);
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1',
    [lost.intent.body.id])).rows[0].status, 'confirmed');
  await stop();
  await start(wallet, lost.service());
  assert.equal((await walletPost('/eru/reconcile', lost.session,
    { id: lost.intent.body.id })).body.status, 'confirmed');

  const failed = await lifecycleCase('absent');
  const wrongLifecycleSignature = sign(null, Buffer.from(failed.intent.body.message, 'base64'),
    normal.signer.privateKey);
  assert.equal((await walletPost('/eru/submit', failed.session, {
    id: failed.intent.body.id, signatureBase64: wrongLifecycleSignature.toString('base64')
  })).status, 400);
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1',
    [failed.intent.body.id])).rows[0].status, 'pending');
  assert.equal((await walletPost('/eru/submit', failed.session, {
    id: failed.intent.body.id, signatureBase64: failed.signature.toString('base64')
  })).body.status, 'unknown');
  const wrongReconcileCluster = createEruProof({ pool, policy: { ...policy, authority: failed.signer.address },
    rpcUrl: 'http://127.0.0.1:18889', cluster: 'devnet',
    connection: { ...connection, getGenesisHash: async () => 'wrong-cluster' } });
  await stop();
  await start(wallet, wrongReconcileCluster);
  assert.equal((await walletPost('/eru/reconcile', failed.session,
    { id: failed.intent.body.id })).status, 409);
  await stop();
  await start(wallet, failed.service());
  failed.chain.mode = 'failed';
  assert.equal((await walletPost('/eru/reconcile', failed.session,
    { id: failed.intent.body.id })).body.status, 'failed');
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1',
    [failed.intent.body.id])).rows[0].status, 'failed');
  assert.equal((await walletPost('/eru/reconcile', failed.session,
    { id: failed.intent.body.id })).body.status, 'failed');

  const missing = await lifecycleCase('absent');
  assert.equal((await walletPost('/eru/submit', missing.session, {
    id: missing.intent.body.id, signatureBase64: missing.signature.toString('base64')
  })).body.status, 'unknown');
  await stop();
  await start(wallet, missing.service());
  assert.equal((await walletPost('/eru/reconcile', missing.session,
    { id: missing.intent.body.id })).body.status, 'unknown');
  assert.equal((await pool.query('SELECT status FROM alpha_eru_intents WHERE id = $1',
    [missing.intent.body.id])).rows[0].status, 'unknown');
};

test('Alpha wallet binding challenge and proof-of-possession over HTTP/PostgreSQL', async () => {
  await pool.query(await readFile(new URL('../schema/002_alpha_wallet_binding.sql', import.meta.url), 'utf8'));
  const wallet = createWalletBinding({ pool, environment: 'alpha-local', now: () => clock });
  await stop();
  await start(wallet);

  async function verified(email) {
    assert.equal((await post('/auth/register', { email, password })).status, 202);
    const response = await post('/auth/verify', { email, code: codeFor(email) });
    assert.equal(response.status, 200);
    return response.body.accessToken;
  }
  const tokenA = await verified('wallet-a@alpha.test');
  const tokenB = await verified('wallet-b@alpha.test');
  const a = keypair();
  const b = keypair();
  assert.equal((await walletPost('/wallet/challenge', '', { walletAddress: a.address })).status, 401);
  assert.equal((await walletPost('/wallet/challenge', tokenA, { walletAddress: 'not-a-key' })).status, 400);
  const challenge = (await walletPost('/wallet/challenge', tokenA, { walletAddress: a.address })).body;
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
  const accountA = (await me(tokenA)).body.id;
  assert.equal(challenge.messageBase64, bindingMessage({
    accountId: accountA, walletAddress: a.address, environment: 'alpha-local',
    nonce: challenge.nonce, issuedAtMs: clock, expiresAtMs: challenge.expiresAtMs
  }).toString('base64'));
  assert.equal((await walletPost('/wallet/bind', tokenA, signed(challenge, b, a.address))).status, 400);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), messageBase64: Buffer.from('modified').toString('base64') })).status, 400);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), walletAddress: b.address })).status, 409);
  assert.equal((await walletPost('/wallet/bind', tokenB, signed(challenge, a))).status, 409);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), nonce: randomBytes(32).toString('hex') })).status, 409);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), messageBase64: Buffer.from(
    Buffer.from(challenge.messageBase64, 'base64').toString('ascii').replace('alpha-local', 'alpha-other'), 'ascii'
  ).toString('base64') })).status, 400);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), signatureBase64: 'invalid' })).status, 400);
  assert.equal((await walletPost('/wallet/bind', tokenA, { ...signed(challenge, a), walletAddress: 'invalid' })).status, 400);

  const unverifiedEmail = 'wallet-unverified@alpha.test';
  await post('/auth/register', { email: unverifiedEmail, password });
  const unverifiedId = (await pool.query('SELECT id FROM alpha_accounts WHERE email_normalized = $1', [unverifiedEmail])).rows[0].id;
  const syntheticToken = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
    [createHash('sha256').update(syntheticToken).digest('hex'), unverifiedId, new Date(clock + 60_000)]);
  assert.equal((await walletPost('/wallet/challenge', syntheticToken, { walletAddress: a.address })).status, 401);

  clock += 11 * 60_000;
  assert.equal((await walletPost('/wallet/bind', tokenA, signed(challenge, a))).status, 409);
  const fresh = (await walletPost('/wallet/challenge', tokenA, { walletAddress: a.address })).body;
  await stop();
  await start(wallet);
  assert.equal((await walletPost('/wallet/bind', tokenA, signed(fresh, a))).status, 200);
  assert.equal((await walletPost('/wallet/bind', tokenA, signed(fresh, a))).status, 409);
  assert.equal((await walletPost('/wallet/challenge', tokenA, { walletAddress: a.address })).status, 409);
  const bound = await fetch(origin + '/wallet', { headers: { authorization: `Bearer ${tokenA}` } });
  assert.deepEqual(await bound.json(), { walletAddress: a.address, environment: 'alpha-local' });
  assert.equal((await walletPost('/wallet/challenge', tokenB, { walletAddress: a.address })).status, 200);
  const conflicting = (await walletPost('/wallet/challenge', tokenB, { walletAddress: a.address })).body;
  assert.equal((await walletPost('/wallet/bind', tokenB, signed(conflicting, a))).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_wallet_bindings')).rows[0].n, 1);
  assert.equal((await walletPost('/wallet/challenge', tokenB, { walletAddress: b.address })).status, 200);

  const tokenC = await verified('wallet-c@alpha.test');
  const c = keypair();
  const d = keypair();
  const first = (await walletPost('/wallet/challenge', tokenC, { walletAddress: c.address })).body;
  const second = (await walletPost('/wallet/challenge', tokenC, { walletAddress: d.address })).body;
  const simultaneous = await Promise.all([
    walletPost('/wallet/bind', tokenC, signed(first, c)),
    walletPost('/wallet/bind', tokenC, signed(second, d))
  ]);
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_wallet_bindings')).rows[0].n, 2);

  const tokenD = await verified('wallet-d@alpha.test');
  const alternate = createWalletBinding({ pool, environment: 'alpha-other', now: () => clock });
  await stop();
  await start(alternate);
  const otherChallenge = (await walletPost('/wallet/challenge', tokenD, { walletAddress: d.address })).body;
  await stop();
  await start(wallet);
  assert.equal((await walletPost('/wallet/bind', tokenD, signed(otherChallenge, d))).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_wallet_bindings')).rows[0].n, 2);
});

test('Alpha ERU intent requires bound wallet, exact signature and one-time HTTP/PostgreSQL settlement', proveEruIntent);
