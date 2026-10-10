import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createSilverOpeningCandidateIntent } from '../src/silver-opening-candidate.js';
import { createAlphaServer } from '../src/server.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable PostgreSQL');
const key = () => bs58.encode(randomBytes(32));
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

for (const marketAware of [false, true]) test(`signed ${marketAware ? 'market-aware' : 'legacy'} Silver opening is durable, idempotent and chain-bound`, async () => {
  const schema = 'alpha_open_submission_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const name of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '008_alpha_silver_opening_candidate_intents.sql',
      '010_alpha_silver_opening_devnet_candidates.sql',
      '011_alpha_silver_opening_submissions.sql'])
      await pool.query(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const wallet = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const programId = key(), mintAddress = key(), sourceTokenAddress = key();
    const marketProgramId = marketAware ? key() : null;
    const oraoTreasury = key(), blockhash = key(), token = randomBytes(32).toString('hex');
    const [escrowAuthority] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-escrow'),
        getAddressEncoder().encode(address(mintAddress))] });
    const [escrow] = await findAssociatedTokenPda({ mint: address(mintAddress),
      owner: escrowAuthority, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const account = randomUUID();
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'opening-submit@example.invalid','synthetic-only',now())`, [account]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [account, wallet]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash,account_id,expires_at)
      VALUES ($1,$2,now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), account]);
    let chainStatus = null, chainTx = null, operationState = false, sends = 0;
    let simulationError = null;
    const chain = {
      readCandidateOpeningSnapshot: async () => ({ finalized: true, cluster: 'devnet',
        genesisHash: genesis, programId, mintAddress, walletAddress: wallet,
        escrowAddress: escrow, sourceTokenAddress, oraoTreasury,
        boxAmount: '1', escrowAmount: '0', lifecycle: 'SEALED', nextOperation: 1,
        designFrozen: true, designVersion: 1, designCommitment: 'a'.repeat(64),
        marketProgramId }),
      isCandidateRequestAbsent: async () => true,
      getCandidateBlockhash: async () => ({ genesisHash: genesis, blockhash,
        lastValidBlockHeight: 1000 }),
      openingBlockHeight: async () => 900,
      isOpeningBlockhashValid: async () => true,
      simulateOpeningTransaction: async () => ({ err: simulationError }),
      sendOpeningTransaction: async raw => { sends++; return bs58.encode(raw.subarray(1, 65)); },
      openingSignatureStatus: async () => chainStatus,
      openingTransaction: async () => chainTx,
      readOpeningOperation: async () => operationState,
    };
    const preflight = { preflight: async () => ({ status: 200,
      body: { cluster: 'devnet', walletAddress: wallet, mintAddress, escrowAddress: escrow } }) };
    const create = () => createSilverOpeningCandidateIntent({ pool, preflight, chain,
      programId, cluster: 'devnet', expectedGenesisHash: genesis, signingEnabled: true });
    let api = create();
    server = createAlphaServer({}, {}, null, null, null, api);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = async (path, body, bearer = token) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const issued = await api.issue(token, { mintAddress });
    assert.equal(issued.status, 200);
    assert.equal((await post('/silver/opening/reconcile', { mintAddress })).status, 404);
    assert.equal((await post('/silver/opening/submit', {}, null)).status, 401);
    const message = Buffer.from(issued.body.messageBase64, 'base64');
    const signature = sign(null, message, privateKey);
    const body = { mintAddress, messageBase64: issued.body.messageBase64,
      blockhash, lastValidBlockHeight: 1000,
      signatureBase64: signature.toString('base64') };
    assert.equal((await api.submit(token, { ...body, signatureBase64:
      randomBytes(64).toString('base64') })).status, 409);
    assert.equal((await pool.query('SELECT count(*) FROM alpha_silver_opening_submissions')).rows[0].count, '0');
    simulationError = { InstructionError: [1, 'InvalidAccountData'] };
    assert.equal((await api.submit(token, body)).status, 409);
    assert.equal((await pool.query('SELECT count(*) FROM alpha_silver_opening_submissions')).rows[0].count, '0');
    simulationError = null;
    const results = await Promise.all([
      post('/silver/opening/submit', body), post('/silver/opening/submit', body)]);
    assert.deepEqual(results.map(result => result.body.status), ['unknown', 'unknown']);
    assert.equal((await pool.query('SELECT count(*) FROM alpha_silver_opening_submissions')).rows[0].count, '1');
    assert.equal((await api.submit(token, { ...body, messageBase64:
      Buffer.from('wrong').toString('base64') })).status, 409);
    assert.equal((await api.reconcile('0'.repeat(64), { mintAddress })).status, 401);
    assert(sends >= 1);
    api = create();
    await new Promise(resolve => server.close(resolve));
    server = createAlphaServer({}, {}, null, null, null, api);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal((await api.reconcile(token, { mintAddress })).body.status, 'unknown');
    chainStatus = { confirmationStatus: 'finalized', err: null };
    const raw = Buffer.concat([Buffer.from([1]), signature, message]);
    const accounts = getCompiledTransactionMessageDecoder().decode(message).staticAccounts;
    const sourceIndex = accounts.indexOf(sourceTokenAddress);
    const escrowIndex = accounts.indexOf(escrow);
    const tokenAmount = (index, amount) => ({ accountIndex: index, mint: mintAddress,
      uiTokenAmount: { amount } });
    chainTx = { transaction: [Buffer.from('wrong').toString('base64')], meta: { err: null } };
    assert.equal((await api.reconcile(token, { mintAddress })).body.status, 'unknown');
    chainTx = { transaction: [raw.toString('base64')], meta: { err: null,
      preTokenBalances: [tokenAmount(sourceIndex, '1'), tokenAmount(escrowIndex, '0')],
      postTokenBalances: [tokenAmount(sourceIndex, '0'), tokenAmount(escrowIndex, '1')] } };
    assert.equal((await api.reconcile(token, { mintAddress })).body.status, 'unknown');
    operationState = true;
    assert.equal((await api.reconcile(token, { mintAddress })).body.status, 'confirmed');
    assert.equal((await api.reconcile(token, { mintAddress })).body.status, 'confirmed');
    assert.equal((await pool.query(`SELECT status FROM alpha_silver_opening_submissions`)).rows[0].status,
      'confirmed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
