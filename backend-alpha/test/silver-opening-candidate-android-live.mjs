import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import bs58 from 'bs58';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { findExtraAccountMetaListPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAlphaServer } from '../src/server.js';
import { createSilverChainReader } from '../src/silver-chain.js';
import { createSilverOpeningPreflight } from '../src/silver-opening.js';
import { createSilverOpeningCandidateIntent } from '../src/silver-opening-candidate.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
const rpcUrl = process.env.SILVER_LOCAL_RPC_URL;
const setupPath = process.env.SILVER_LOCAL_SETUP_LOG;
const realAuth = process.env.SILVER_CANDIDATE_REAL_AUTH === '1';
if (!databaseUrl || !/^http:\/\/172\.17\.\d+\.\d+:18999$/.test(rpcUrl ?? '') ||
    setupPath !== '/tmp/etherings-silver-candidate-android-local/setup.log') {
  throw new Error('Disposable DB, contained validator and exact setup receipt required');
}
const receipts = (await readFile(setupPath, 'utf8')).trim().split('\n')
  .map(line => { try { return JSON.parse(line); } catch { return null; } });
const setup = receipts.find(item => item?.result === 'SETUP_PASS');
const issuance = receipts.find(item => item?.label === 'issue-disposable-box' &&
  item.phase === 'finalized' && item.err === null);
assert(setup);
assert(issuance?.signature && Number.isSafeInteger(issuance.slot));
const { program: programId, mint: mintAddress, owner: walletAddress,
  token: sourceTokenAddress, escrow: escrowAddress } = setup;
const rpc = async (method, params = []) => {
  const response = await fetch(rpcUrl, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  assert(response.ok && !body.error);
  return body.result;
};
const genesisHash = await rpc('getGenesisHash');
const reader = createSilverChainReader(rpcUrl, { expectedCluster: 'local-validator',
  expectedGenesisHash: genesisHash, allowMissingSignatureHistory: true });
const enc = key => bs58.decode(key);
const text = value => new TextEncoder().encode(value);
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const stateAddress = await pda(programId, text('silver-state'), enc(mintAddress));
const stateInfo = await rpc('getAccountInfo', [stateAddress,
  { encoding: 'base64', commitment: 'finalized' }]);
assert(stateInfo.value?.owner === programId);
const state = Buffer.from(stateInfo.value.data[0], 'base64');
assert.equal(state.readBigUInt64LE(180), BigInt(issuance.slot));
const idHex = state.subarray(164, 180).toString('hex');
const accountId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`;
if (realAuth) assert.equal(accountId, process.env.SILVER_LOCAL_ACCOUNT_ID);
const issuanceId = createHash('sha256').update(
  `EtheRings:first-entry:issuance:v1\ndevnet\n${accountId}\n`).digest('hex');
const entitlementDigest = createHash('sha256').update(
  `EtheRings:first-entry:entitlement:v1\ndevnet\n${accountId}\n${walletAddress}\n${issuanceId}\n`).digest('hex');
assert.equal(state.subarray(4, 36).toString('hex'), issuanceId);
assert.equal(state.subarray(132, 164).toString('hex'), entitlementDigest);
const collectionId = await pda(programId, text('silver-collection'));

const schema = `alpha_candidate_android_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
let pool;
let server;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
    '008_alpha_silver_opening_candidate_intents.sql']) {
    await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
  }
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
    VALUES ($1,'candidate-android@example.invalid','synthetic-only',now())`, [accountId]);
  await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
    VALUES ($1,$2,'alpha-local')`, [accountId, walletAddress]);
  if (!realAuth) await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
    VALUES ($1,$2,now() + interval '1 hour')`,
  [createHash('sha256').update(token).digest('hex'), accountId]);
  const silver = { inventory: async () => {
    const asset = await reader.readFinalized({ programId, cluster: 'local-validator', issuanceId,
      expectedFinalizedSignature: issuance.signature });
    if (!asset || asset.accountId !== accountId || asset.collectionId !== collectionId ||
        asset.entitlementDigest !== entitlementDigest || asset.originalRecipient !== walletAddress ||
        asset.tokenOwner !== walletAddress || asset.lifecycle !== 'SEALED') {
      return { status: 200, body: { assets: [] } };
    }
    return { status: 200, body: { assets: [{ kind: 'SILVER_BOX', mintAddress,
      lifecycle: asset.lifecycle, cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds }] } };
  } };
  const opening = createSilverOpeningPreflight({ pool, silver, chain: reader,
    cluster: 'local-validator', programId, walletEnvironment: 'alpha-local' });
  const candidate = createSilverOpeningCandidateIntent({ pool, preflight: opening,
    chain: reader, programId, expectedGenesisHash: genesisHash });
  const snapshot = await reader.readCandidateOpeningSnapshot({ programId, mintAddress,
    walletAddress, escrowAddress });
  assert(snapshot?.finalized && snapshot.sourceTokenAddress === sourceTokenAddress);
  const inventoryCheck = await silver.inventory(token);
  const preflightCheck = realAuth ? null : await opening.preflight(token, { mintAddress });
  console.log(JSON.stringify({ result: 'CANDIDATE_PREFLIGHT_CHECK',
    inventoryCount: inventoryCheck.body?.assets?.length ?? -1,
    preflightStatus: preflightCheck?.status ?? 'awaiting-real-session' }));
  let issued;
  if (realAuth) {
    await pool.query(`INSERT INTO alpha_silver_opening_candidate_intents
      (cluster, genesis_hash, program_id, mint_address, account_id, wallet_address,
       source_token_address, escrow_address, next_operation, design_version,
       design_commitment, orao_treasury, seed_hex)
      VALUES ('local-validator',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [genesisHash, programId, mintAddress, accountId, walletAddress,
      snapshot.sourceTokenAddress, escrowAddress, snapshot.nextOperation,
      snapshot.designVersion, snapshot.designCommitment, snapshot.oraoTreasury,
      randomBytes(32).toString('hex')]);
  } else {
    issued = await candidate.issue(token, { mintAddress });
    assert.equal(issued.status, 200);
  }
  const row = (await pool.query('SELECT seed_hex FROM alpha_silver_opening_candidate_intents'))
    .rows[0];
  assert(row && (!issued || row.seed_hex === issued.body.seedHex));
  const u64 = value => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes;
  };
  const orao = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';
  const seed = Buffer.from(row.seed_hex, 'hex');
  const [extra] = await findExtraAccountMetaListPda({ mint: mintAddress },
    { programAddress: programId });
  const policy = { cluster: 'local-validator', seedHex: row.seed_hex,
    authority: walletAddress, mint: mintAddress, source: sourceTokenAddress,
    escrow: escrowAddress, escrowAuthority: await pda(programId, text('silver-escrow'),
      enc(mintAddress)), state: stateAddress,
    lifecycle: await pda(programId, text('silver-lifecycle'), enc(mintAddress)),
    extra, operation: await pda(programId, text('silver-open'), enc(mintAddress),
      u64(snapshot.nextOperation)), config: await pda(programId, text('silver-config')),
    design: await pda(programId, text('silver-design-set'), u64(snapshot.designVersion)),
    collection: collectionId,
    network: await pda(orao, text('orao-vrf-network-configuration')),
    treasury: snapshot.oraoTreasury,
    request: await pda(orao, text('orao-vrf-randomness-request'), seed),
    orao, token: TOKEN_2022_PROGRAM_ADDRESS,
    instructions: 'Sysvar1nstructions1111111111111111111111111',
    system: '11111111111111111111111111111111', silver: programId,
    compute: 'ComputeBudget111111111111111111111111111111' };
  if (issued) {
    assert.equal(policy.operation, issued.body.operation);
    assert.equal(policy.request, issued.body.request);
  }
  if (realAuth) await writeFile('/tmp/etherings-silver-candidate-android-local/policy.json',
    JSON.stringify(policy), { mode: 0o600 });
  server = createAlphaServer({}, {}, null, silver, opening, candidate);
  const handler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
      .includes(request.socket.remoteAddress);
    if (realAuth && loopback && request.method === 'GET' &&
        (path === '/auth/me' || path === '/wallet')) {
      try {
        const upstream = await fetch(`http://127.0.0.1:9081${path}`, {
          headers: { authorization: request.headers.authorization ?? '' } });
        response.writeHead(upstream.status, { 'content-type': 'application/json',
          'cache-control': 'no-store' });
        response.end(await upstream.text());
      } catch { response.writeHead(503).end(); }
    } else if (realAuth && loopback && request.method === 'POST' &&
        path === '/silver/opening/candidate-intent') {
      try {
        const authorization = request.headers.authorization ?? '';
        const bearer = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
        if (!bearer) { response.writeHead(401).end(); return; }
        const headers = { authorization };
        const [me, binding] = await Promise.all([
          fetch('http://127.0.0.1:9081/auth/me', { headers }),
          fetch('http://127.0.0.1:9081/wallet', { headers }),
        ]);
        if (me.status !== 200 || binding.status !== 200 ||
            (await me.json()).id !== accountId ||
            (await binding.json()).walletAddress !== walletAddress) {
          response.writeHead(401).end(); return;
        }
        await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
          VALUES ($1,$2,now() + interval '1 minute')
          ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [createHash('sha256').update(bearer).digest('hex'), accountId]);
        handler(request, response);
      } catch { response.writeHead(503).end(); }
    } else if (request.method === 'GET' && loopback && !realAuth &&
        (path === '/proof/bootstrap' || path === '/proof/policy')) {
      response.writeHead(200, { 'content-type': 'application/json',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(path === '/proof/bootstrap' ? { token } : policy));
    } else handler(request, response);
  });
  await new Promise(resolve => server.listen(19081, '127.0.0.1', resolve));
  console.log(JSON.stringify({ result: 'ANDROID_CANDIDATE_SERVER_READY',
    genesisHash, programId, mintAddress, walletAddress,
    operation: policy.operation, request: policy.request }));
  await new Promise(resolve => process.once('SIGTERM', resolve));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
