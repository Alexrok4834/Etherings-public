import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import bs58 from 'bs58';
import { address, getCompiledTransactionMessageDecoder, getProgramDerivedAddress,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createAlphaServer } from '../src/server.js';
import { createSilverChainReader } from '../src/silver-chain.js';
import { createSilverOpeningPreflight } from '../src/silver-opening.js';
import { createSilverOpeningCandidateIntent } from '../src/silver-opening-candidate.js';
import { verifySilverOpeningCandidateMessage } from '../src/silver-opening-intent.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
const rpcUrl = process.env.SILVER_LOCAL_RPC_URL;
const setupPath = process.env.SILVER_LOCAL_SETUP_LOG;
if (!databaseUrl || rpcUrl !== 'http://127.0.0.1:18999' || !setupPath) {
  throw new Error('Disposable PostgreSQL, loopback validator and setup receipt required');
}
const setupLines = (await readFile(setupPath, 'utf8')).trim().split('\n');
const setup = setupLines.map(line => { try { return JSON.parse(line); } catch { return null; } })
  .find(item => item?.result === 'SETUP_PASS');
assert(setup, 'SETUP_PASS receipt required');
const { program: programId, mint: mintAddress, owner: walletAddress,
  token: sourceTokenAddress } = setup;
const reader = createSilverChainReader(rpcUrl, { expectedCluster: 'local-validator',
  expectedGenesisHash: await (async () => {
    const response = await fetch(rpcUrl, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error('Cannot read isolated validator genesis');
    return body.result;
  })() });
const genesisHash = (await reader.getCandidateBlockhash()).genesisHash;
const stateAddress = (await getProgramDerivedAddress({ programAddress: address(programId),
  seeds: [new TextEncoder().encode('silver-state'), bs58.decode(mintAddress)] }))[0];
const stateResponse = await fetch(rpcUrl, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getAccountInfo',
    params: [stateAddress, { encoding: 'base64', commitment: 'finalized' }] }) });
const stateBody = await stateResponse.json();
assert(stateResponse.ok && !stateBody.error && stateBody.result?.value);
const state = Buffer.from(stateBody.result.value.data[0], 'base64');
const idHex = state.subarray(164, 180).toString('hex');
const accountId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`;
const issuanceId = createHash('sha256').update(
  `EtheRings:first-entry:issuance:v1\ndevnet\n${accountId}\n`).digest('hex');
const entitlementDigest = createHash('sha256').update(
  `EtheRings:first-entry:entitlement:v1\ndevnet\n${accountId}\n${walletAddress}\n${issuanceId}\n`
).digest('hex');
assert.equal(state.subarray(4, 36).toString('hex'), issuanceId);
assert.equal(state.subarray(132, 164).toString('hex'), entitlementDigest);
const [collectionId] = await getProgramDerivedAddress({ programAddress: address(programId),
  seeds: [new TextEncoder().encode('silver-collection')] });

const schema = `alpha_candidate_live_${randomUUID().replaceAll('-', '')}`;
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
    VALUES ($1,'candidate-live@example.invalid','synthetic-only',now())`, [accountId]);
  await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
    VALUES ($1,$2,'alpha-local')`, [accountId, walletAddress]);
  await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
    VALUES ($1,$2,now() + interval '1 hour')`,
  [createHash('sha256').update(token).digest('hex'), accountId]);
  const silver = { inventory: async () => {
    const asset = await reader.readFinalized({ programId, cluster: 'local-validator', issuanceId });
    if (!asset || asset.accountId !== accountId || asset.collectionId !== collectionId ||
        asset.entitlementDigest !== entitlementDigest || asset.originalRecipient !== walletAddress ||
        asset.tokenOwner !== walletAddress || asset.lifecycle !== 'SEALED') {
      return { status: 200, body: { assets: [] } };
    }
    return { status: 200, body: { assets: [{ kind: 'SILVER_BOX', mintAddress,
      lifecycle: asset.lifecycle, cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds }] } };
  } };
  const inventory = await silver.inventory(token);
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.body.assets.map(asset => asset.mintAddress), [mintAddress]);
  const opening = createSilverOpeningPreflight({ pool, silver, chain: reader,
    cluster: 'local-validator', programId, walletEnvironment: 'alpha-local' });
  const candidate = createSilverOpeningCandidateIntent({ pool, preflight: opening,
    chain: reader, programId, expectedGenesisHash: genesisHash });
  server = createAlphaServer({}, {}, null, silver, opening, candidate);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = async (body = { mintAddress }, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/silver/opening/candidate-intent`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post({ mintAddress }, null)).status, 401);
  assert.equal((await post({ mintAddress: bs58.encode(randomBytes(32)) })).status, 409);
  await pool.query('DELETE FROM alpha_wallet_bindings WHERE account_id = $1', [accountId]);
  assert.equal((await post()).status, 409);
  await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
    VALUES ($1,$2,'alpha-local')`, [accountId, walletAddress]);
  const preflight = await opening.preflight(token, { mintAddress });
  assert.equal(preflight.status, 200);
  const before = await reader.readCandidateOpeningSnapshot({ programId, mintAddress,
    walletAddress, escrowAddress: preflight.body.escrowAddress });
  assert(before?.finalized && before.sourceTokenAddress === sourceTokenAddress);
  const mutated = createSilverOpeningCandidateIntent({ pool, preflight: opening,
    chain: { ...reader, readCandidateOpeningSnapshot: async input => ({
      ...await reader.readCandidateOpeningSnapshot(input), sourceTokenAddress: 'invalid',
    }) }, programId, expectedGenesisHash: genesisHash });
  assert.equal((await mutated.issue(token, { mintAddress })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_opening_candidate_intents')).rows[0].n, 0);
  const issued = await post();
  assert.equal(issued.status, 200);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(issued.body.messageBase64, 'base64'));
  const instructions = getInstructionsFromCompiledTransactionMessage(compiled);
  assert.equal(compiled.header.numSignerAccounts, 1);
  assert.equal(compiled.staticAccounts[0], walletAddress);
  assert.deepEqual(instructions.map(ix => ix.programAddress), [
    'ComputeBudget111111111111111111111111111111', programId,
    TOKEN_2022_PROGRAM_ADDRESS, programId,
  ]);
  assert.equal(instructions[1].accounts[2].address, sourceTokenAddress);
  assert.equal(await verifySilverOpeningCandidateMessage({ cluster: 'local-validator',
    programId, walletAddress, mintAddress, userTokenAddress: sourceTokenAddress,
    escrowAddress: before.escrowAddress, nextOperation: before.nextOperation,
    designVersion: before.designVersion, oraoTreasury: before.oraoTreasury,
    seed: Buffer.from(issued.body.seedHex, 'hex'), blockhash: compiled.lifetimeToken,
    lastValidBlockHeight: issued.body.lastValidBlockHeight }, issued.body.messageBase64), true);
  const retry = await post();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.seedHex, issued.body.seedHex);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_opening_candidate_intents')).rows[0].n, 1);
  console.log(JSON.stringify({ result: 'BACKEND_CANDIDATE_LOCAL_PASS', genesisHash,
    programId, mintAddress, walletAddress, operation: issued.body.operation,
    request: issued.body.request, signerCount: compiled.header.numSignerAccounts,
    instructionCount: instructions.length, boundSource: sourceTokenAddress,
    mutationRejectedBeforeIssuance: true, signed: false, submitted: false }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
