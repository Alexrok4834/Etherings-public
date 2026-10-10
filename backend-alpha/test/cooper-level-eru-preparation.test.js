import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import bs58 from 'bs58';
import { getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createCooperLevelUp } from '../src/cooper-level-up.js';
import { createCooperPointAllocation } from '../src/cooper-point-allocation.js';
import { cooperEruStaticConfigSha256,
  createCooperEruCandidateReader } from '../src/cooper-eru-candidate-reader.js';
import { createCooperEruUnsignedIssuance } from '../src/cooper-eru-issuance.js';
import { createCooperEruAttestation, createCooperEruDevnetAttestation } from
  '../src/cooper-eru-attestation.js';
import { createCooperEruFinalityReader } from '../src/cooper-eru-finality.js';
import { createCooperEruReconciliation } from '../src/cooper-eru-reconciliation.js';
import { createCooperEruUserFlow } from '../src/cooper-eru-user-flow.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must be disposable PostgreSQL');

test('Cooper ERU preparation binds one exclusive transition and exact ERT hold atomically', async () => {
  const schema = 'alpha_eru_level_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema}` });
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '006_alpha_hybrid_ert_foundation.sql', '013_alpha_starter_cooper.sql',
      '015_alpha_ring_equipment.sql', '019_alpha_cooper_current_state.sql',
      '020_alpha_cooper_point_allocation.sql', '021_alpha_cooper_level_up.sql',
      '022_alpha_cooper_level_eru_preparation.sql'])
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    const up = await readFile(new URL('../schema/022_alpha_cooper_level_eru_preparation.sql',
      import.meta.url), 'utf8');
    const down = await readFile(new URL('../schema/rollback/022_alpha_cooper_level_eru_preparation.sql',
      import.meta.url), 'utf8');
    await pool.query(down);
    await pool.query(up);
    const ownerId = randomUUID();
    const foreignId = randomUUID();
    const ringId = randomUUID();
    const userKeys = generateKeyPairSync('ed25519');
    const walletAddress = bs58.encode(userKeys.publicKey.export({
      format: 'der', type: 'spki' }).subarray(-32));
    await pool.query(`INSERT INTO alpha_accounts(id,email_normalized,password_hash,verified_at)
      VALUES ($1,'eru-level@example.invalid','synthetic',now()),
             ($2,'other-eru-level@example.invalid','synthetic',now())`, [ownerId, foreignId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [ownerId, walletAddress]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',20,10,8,6)`, [ownerId, ringId, randomUUID()]);
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 4, unspent_attribute_points = 12 WHERE account_id = $1`, [ownerId]);
    await pool.query('INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)', [ownerId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'eru-level-credit',100)`, [randomUUID(), ownerId]);
    const auth = { async me(token) {
      return token === 'owner' ? { status: 200, body: { id: ownerId } } :
        token === 'foreign' ? { status: 200, body: { id: foreignId } } :
          { status: 401, body: { code: 'AUTH_REQUIRED' } };
    } };
    const service = createCooperLevelUp({ pool, auth });
    const input = (key = randomUUID()) => ({ expectedCurrentLevel: 4,
      targetLevel: 5, idempotencyKey: key });
    const firstInput = input();
    assert.equal((await service.prepareEru('foreign', ringId, firstInput)).status, 404);
    assert.equal((await service.prepareEru('owner', ringId,
      { ...firstInput, targetLevel: 6 })).body.code, 'RING_ERU_TRANSITION_INVALID');
    await pool.query(`CREATE FUNCTION reject_eru_prepare() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected preparation failure'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_eru_prepare
      BEFORE INSERT ON alpha_cooper_level_eru_preparations
      FOR EACH ROW EXECUTE FUNCTION reject_eru_prepare()`);
    await assert.rejects(() => service.prepareEru('owner', ringId, firstInput),
      /injected preparation failure/);
    for (const table of ['alpha_cooper_level_up_operations', 'alpha_hybrid_operations',
      'alpha_ert_reservations', 'alpha_hybrid_outbox'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    await pool.query('DROP TRIGGER reject_eru_prepare ON alpha_cooper_level_eru_preparations');
    await pool.query('DROP FUNCTION reject_eru_prepare()');
    const first = await service.prepareEru('owner', ringId, firstInput);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.cost, { ertExact: '24',
      eruPrincipalExact: '30', eruFeeExact: '0.6' });
    assert.equal(first.body.walletAddress, walletAddress);
    assert.equal(first.body.reservationState, 'held');
    assert.deepEqual((await service.prepareEru('owner', ringId, firstInput)).body, first.body);
    const replayRace = await Promise.all([service.prepareEru('owner', ringId, firstInput),
      service.prepareEru('owner', ringId, firstInput)]);
    assert(replayRace.every(result => result.status === 200 &&
      result.body.hybridOperationId === first.body.hybridOperationId));
    assert.equal((await service.prepareEru('owner', ringId,
      { ...firstInput, expectedCurrentLevel: 19 })).body.code,
    'RING_LEVEL_IDEMPOTENCY_CONFLICT');
    const contenders = await Promise.all([service.prepareEru('owner', ringId, input()),
      service.prepareEru('owner', ringId, input())]);
    assert(contenders.every(result => result.status === 409 &&
      result.body.code === 'RING_ERU_TRANSITION_PENDING'));
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_eru_preparations`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_hybrid_outbox`))
      .rows[0].n, 1);
    assert.equal((await pool.query(`SELECT available::text AS available
      FROM alpha_ert_available WHERE account_id = $1`, [ownerId])).rows[0].available,
    '76.000000000000000000');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 0);
    assert.deepEqual((await pool.query(`SELECT level, unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [ownerId])).rows[0],
    { level: 4, unspent_attribute_points: 12 });
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_current_state
      SET level = 5 WHERE account_id = $1`, [ownerId]), /unresolved ERU operation/);
    const allocation = createCooperPointAllocation({ pool, auth });
    await assert.rejects(() => allocation.allocate('owner', ringId, {
      expectedUnspentPoints: 12, allocation: { comfort: 1, charm: 0, quality: 0, luck: 0 },
      idempotencyKey: randomUUID(),
    }), /unresolved ERU operation/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_cooper_point_allocations'))
      .rows[0].n, 0);
    await assert.rejects(() => pool.query(down), /rollback would discard it/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_preparations
      SET eru_fee = 0.7 WHERE operation_id = $1`, [first.body.operationId]), /immutable|check constraint/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_preparations
      SET status = 'confirmed' WHERE operation_id = $1`, [first.body.operationId]), /immutable/);

    const secondRing = randomUUID();
    const secondWallet = 'EdXT16XWGS5vf1X2ezwaL5TB6ZLb5XqsMxBF439FmHmi';
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id,wallet_address,environment)
      VALUES ($1,$2,'alpha-local')`, [foreignId, secondWallet]);
    await pool.query(`INSERT INTO alpha_starter_cooper
      (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
      VALUES ($1,$2,$3,'copper_signet',20,10,8,6)`,
    [foreignId, secondRing, randomUUID()]);
    await pool.query(`UPDATE alpha_cooper_current_state
      SET level = 19, unspent_attribute_points = 72 WHERE account_id = $1`, [foreignId]);
    await pool.query('INSERT INTO alpha_ert_accounts(account_id) VALUES ($1)', [foreignId]);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'eru-level-credit-19',83)`, [randomUUID(), foreignId]);
    const lastInput = { expectedCurrentLevel: 19, targetLevel: 20,
      idempotencyKey: randomUUID() };
    assert.equal((await service.prepareEru('foreign', secondRing, lastInput)).body.code,
      'INSUFFICIENT_ERT');
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_eru_preparations`)).rows[0].n, 1);
    await pool.query(`INSERT INTO alpha_ert_ledger(id,account_id,event_key,amount)
      VALUES ($1,$2,'eru-level-credit-20',1)`, [randomUUID(), foreignId]);
    const initialRace = await Promise.all([service.prepareEru('foreign', secondRing, lastInput),
      service.prepareEru('foreign', secondRing, { ...lastInput, idempotencyKey: randomUUID() })]);
    assert.deepEqual(initialRace.map(result => result.status).sort(), [200, 409]);
    const last = initialRace.find(result => result.status === 200);
    assert.equal(initialRace.find(result => result.status === 409).body.code,
      'RING_ERU_TRANSITION_PENDING');
    assert.deepEqual(last.body.cost, { ertExact: '84',
      eruPrincipalExact: '60', eruFeeExact: '1.2' });
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_ert_reservations WHERE state = 'held'`)).rows[0].n, 2);
    const address = byte => bs58.encode(Buffer.alloc(32, byte));
    const gateway = address(11);
    const config = (await getProgramDerivedAddress({ programAddress: gateway,
      seeds: [new TextEncoder().encode('eru-config')] }))[0];
    const replay = (await getProgramDerivedAddress({ programAddress: gateway,
      seeds: [new TextEncoder().encode('nonce'), getAddressEncoder().encode(config),
        getAddressEncoder().encode(walletAddress)] }))[0];
    let replayNonce = 0n;
    let currentSlot = 30;
    let currentBlockhash = address(18);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const attestorAddress = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const testSigner = { address: attestorAddress, sign: bytes => sign(null, bytes, privateKey) };
    const configData = Buffer.alloc(330);
    configData[0] = 1;
    for (const [offset, value] of [[33, address(12)], [65, address(13)],
      [97, address(14)], [290, attestorAddress]])
      configData.set(getAddressEncoder().encode(value), offset);
    configData.writeBigUInt64LE(1n, 322);
    const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const chain = {
      async getGenesisHash() { return genesis; },
      async getAccountInfo(key) {
        if (key === gateway) return { executable: true };
        if (key === config) return { owner: gateway, data: configData };
        if (key === replay && replayNonce > 0n) {
          const data = Buffer.alloc(8);
          data.writeBigUInt64LE(replayNonce);
          return { owner: gateway, data };
        }
        return null;
      },
      async getSlot() { return currentSlot; },
      async getBlockHeight() { return 100; },
      async getLatestBlockhash() { return { blockhash: currentBlockhash,
        lastValidBlockHeight: 120 }; },
      async isBlockhashValid() { return true; },
    };
    const resolver = createCooperEruCandidateReader({ pool, chain,
      cluster: 'devnet', expectedGenesisHash: genesis, gatewayProgramId: gateway,
      expectedConfigStaticSha256: cooperEruStaticConfigSha256(configData) });
    assert.equal((await resolver.read(ownerId, first.body.operationId)).sizeBytes, 780);
    assert.equal((await resolver.read(foreignId, last.body.operationId)).sizeBytes, 780);
    configData[97] ^= 1;
    await assert.rejects(() => resolver.read(ownerId, first.body.operationId), /unavailable/);
    configData[97] ^= 1;
    await assert.rejects(() => resolver.read(foreignId, first.body.operationId));
    const issuanceUp = await readFile(new URL('../schema/023_alpha_cooper_level_eru_issuance.sql',
      import.meta.url), 'utf8');
    const issuanceDown = await readFile(new URL(
      '../schema/rollback/023_alpha_cooper_level_eru_issuance.sql', import.meta.url), 'utf8');
    await pool.query(issuanceUp);
    await pool.query(issuanceDown);
    await pool.query(issuanceUp);
    const issuer = createCooperEruUnsignedIssuance({ pool, candidateReader: resolver,
      cluster: 'devnet' });
    const [firstIssued, concurrentReplay] = await Promise.all([
      issuer.issue(ownerId, first.body.operationId),
      issuer.issue(ownerId, first.body.operationId),
    ]);
    assert.equal(firstIssued.candidate.sizeBytes, 780);
    assert.equal(firstIssued.intentDigest, concurrentReplay.intentDigest);
    currentSlot = 40;
    currentBlockhash = address(19);
    assert.equal((await issuer.issue(ownerId, first.body.operationId)).intentDigest,
      firstIssued.intentDigest);
    const attestation = createCooperEruAttestation({ pool, issuance: issuer,
      candidateReader: resolver, signer: testSigner, cluster: 'devnet' });
    const attested = await attestation.attest(ownerId, first.body.operationId);
    const keyDirectory = mkdtempSync(join(tmpdir(), 'alpha-cooper-attestor-'));
    try {
      const keyPath = join(keyDirectory, 'attestor.json');
      const secret = Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' })
        .subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
      writeFileSync(keyPath, JSON.stringify([...secret]), { mode: 0o600 });
      secret.fill(0);
      const fileAttestation = createCooperEruDevnetAttestation({ pool,
        issuance: issuer, candidateReader: resolver, attestorKeyPath: keyPath,
        expectedAttestorAddress: attestorAddress });
      const fileAttested = await fileAttestation.attest(ownerId, first.body.operationId);
      assert(verify(null, Buffer.from(fileAttested.candidate.messageBase64, 'base64'),
        publicKey, Buffer.from(fileAttested.attestorSignatureBase64, 'base64')));
      assert.throws(() => createCooperEruDevnetAttestation({ pool,
        issuance: issuer, candidateReader: resolver, attestorKeyPath: keyPath,
        expectedAttestorAddress: address(15) }), /unavailable/);
      if (process.platform !== 'win32') {
        chmodSync(keyPath, 0o644);
        assert.throws(() => createCooperEruDevnetAttestation({ pool,
          issuance: issuer, candidateReader: resolver, attestorKeyPath: keyPath,
          expectedAttestorAddress: attestorAddress }), /unavailable/);
      }
    } finally { rmSync(keyDirectory, { recursive: true, force: true }); }
    assert.equal(attested.candidate.intentDigest, firstIssued.intentDigest);
    assert.equal(attested.candidate.messageBase64, (await issuer.issue(
      ownerId, first.body.operationId)).candidate.messageBase64);
    assert(verify(null, Buffer.from(attested.candidate.messageBase64, 'base64'), publicKey,
      Buffer.from(attested.attestorSignatureBase64, 'base64')));
    const message = Buffer.from(attested.candidate.messageBase64, 'base64');
    const userSignature = sign(null, message, userKeys.privateKey);
    const transaction = Buffer.concat([Buffer.from([2]), userSignature,
      Buffer.from(attested.attestorSignatureBase64, 'base64'), message]);
    const transactionSignature = bs58.encode(userSignature);
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[1];
    const operationReplay = (await getProgramDerivedAddress({ programAddress: gateway,
      seeds: [new TextEncoder().encode('cooper-level-up'), getAddressEncoder().encode(config),
        getAddressEncoder().encode(walletAddress),
        Buffer.from(first.body.operationId.replaceAll('-', ''), 'hex')] }))[0];
    const token = (key, amount) => ({ accountIndex: compiled.staticAccounts.indexOf(key),
      mint: instruction.accounts[1].address, programId: TOKEN_2022_PROGRAM_ADDRESS,
      uiTokenAmount: { amount } });
    const source = instruction.accounts[0].address;
    const treasury = instruction.accounts[2].address;
    const finalTx = { slot: 50, transaction: [transaction.toString('base64'), 'base64'],
      meta: { err: null, preTokenBalances: [token(source, '100000000000'),
        token(treasury, '0')], postTokenBalances: [token(source, '69400000000'),
        token(treasury, '600000000')] } };
    let finalized = true;
    const finalityChain = { ...chain,
      async getSignatureStatus() { return finalized ?
        { confirmationStatus: 'finalized', err: null } : null; },
      async getTransaction() { return finalTx; },
      async getAccountInfo(key) {
        if (key === replay) {
          const data = Buffer.alloc(8); data.writeBigUInt64LE(1n);
          return { owner: gateway, data };
        }
        if (key === operationReplay) return { owner: gateway,
          data: createHash('sha256').update(instruction.data.subarray(1)).digest() };
        return chain.getAccountInfo(key);
      },
    };
    const finality = createCooperEruFinalityReader({ pool, chain: finalityChain,
      cluster: 'devnet', expectedGenesisHash: genesis });
    assert.equal((await finality.verify(ownerId, first.body.operationId,
      transactionSignature)).status, 'verified');
    finalized = false;
    assert.equal((await finality.verify(ownerId, first.body.operationId,
      transactionSignature)).status, 'unknown');
    finalized = true;
    await assert.rejects(() => finality.verify(foreignId, first.body.operationId,
      transactionSignature), /unavailable/);
    const originalTx = finalTx.transaction[0];
    const forged = Buffer.from(transaction); forged[80] ^= 1;
    finalTx.transaction[0] = forged.toString('base64');
    await assert.rejects(() => finality.verify(ownerId, first.body.operationId,
      transactionSignature), /unavailable/);
    finalTx.transaction[0] = originalTx;
    finalTx.meta.postTokenBalances[1].uiTokenAmount.amount = '599999999';
    await assert.rejects(() => finality.verify(ownerId, first.body.operationId,
      transactionSignature), /unavailable/);
    finalTx.meta.postTokenBalances[1].uiTokenAmount.amount = '600000000';
    const originalRead = finalityChain.getAccountInfo;
    finalityChain.getAccountInfo = async key => key === operationReplay ?
      { owner: gateway, data: Buffer.alloc(32) } : originalRead(key);
    await assert.rejects(() => finality.verify(ownerId, first.body.operationId,
      transactionSignature), /unavailable/);
    finalityChain.getAccountInfo = originalRead;
    await assert.rejects(() => createCooperEruAttestation({ pool, issuance: issuer,
      candidateReader: resolver, signer: { address: address(15), sign: () => {
        throw new Error('wrong attestor was called');
      } }, cluster: 'devnet' }).attest(ownerId, first.body.operationId), /unavailable/);
    await assert.rejects(() => createCooperEruAttestation({ pool, issuance: issuer,
      candidateReader: resolver, signer: { address: attestorAddress,
        sign: () => Buffer.alloc(64) }, cluster: 'devnet' })
      .attest(ownerId, first.body.operationId), /unavailable/);
    await assert.rejects(() => createCooperEruAttestation({ pool, issuance: issuer,
      candidateReader: resolver, signer: { address: attestorAddress,
        sign: bytes => { bytes[0] ^= 1; return sign(null, bytes, privateKey); } },
      cluster: 'devnet' }).attest(ownerId, first.body.operationId), /unavailable/);
    await assert.rejects(() => attestation.attest(foreignId, first.body.operationId),
      /unavailable/);
    await assert.rejects(() => issuer.issue(foreignId, first.body.operationId));
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_eru_issuances`)).rows[0].n, 1);
    replayNonce = 1n;
    await assert.rejects(() => attestation.attest(ownerId, first.body.operationId),
      /unavailable/);
    replayNonce = 0n;
    assert.equal((await issuer.issue(foreignId, last.body.operationId)).candidate.sizeBytes, 780);
    const lastAttested = await attestation.attest(foreignId, last.body.operationId);
    assert(verify(null, Buffer.from(lastAttested.candidate.messageBase64, 'base64'), publicKey,
      Buffer.from(lastAttested.attestorSignatureBase64, 'base64')));
    currentSlot = 631;
    await assert.rejects(() => attestation.attest(ownerId, first.body.operationId),
      /unavailable/);
    currentSlot = 40;
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM alpha_cooper_level_eru_issuances`)).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_reservations
      WHERE state = 'held'`)).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT level FROM alpha_cooper_current_state
      WHERE account_id = $1`, [ownerId])).rows[0].level, 4);
    const settlementUp = await readFile(new URL(
      '../schema/024_alpha_cooper_level_eru_settlement.sql', import.meta.url), 'utf8');
    const settlementDown = await readFile(new URL(
      '../schema/rollback/024_alpha_cooper_level_eru_settlement.sql', import.meta.url), 'utf8');
    await pool.query(settlementUp);
    await pool.query(settlementDown);
    await pool.query(settlementUp);
    const reconciler = createCooperEruReconciliation({ pool,
      finalityReader: finality, cluster: 'devnet' });
    assert.equal((await reconciler.reconcile(ownerId, first.body.operationId)).status,
      'unknown');
    finalized = false;
    let broadcasts = 0;
    const flow = createCooperEruUserFlow({ attestation, reconciliation: reconciler,
      chain: { ...chain, async sendRawTransaction(raw) {
        broadcasts++;
        assert(Buffer.from(raw).equals(transaction));
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
          alpha_cooper_level_eru_submissions WHERE signature = $1`,
        [transactionSignature])).rows[0].n, 1);
        return transactionSignature;
      } } });
    const reviewed = await flow.review(ownerId, first.body.operationId);
    assert.deepEqual([reviewed.terms.currentLevel, reviewed.terms.targetLevel,
      reviewed.terms.ertExact, reviewed.terms.eruPrincipalExact,
      reviewed.terms.eruFeeExact], [4, 5, '24', '30.000000000', '0.600000000']);
    currentBlockhash = address(20);
    const refreshed = await flow.refresh(ownerId, first.body.operationId, reviewed);
    assert.notEqual(refreshed.candidate.messageBase64, reviewed.candidate.messageBase64);
    await assert.rejects(() => flow.refresh(ownerId, first.body.operationId,
      { ...reviewed, terms: { ...reviewed.terms, ertExact: '23' } }), /unavailable/);
    currentBlockhash = address(19);
    const toSign = await flow.refresh(ownerId, first.body.operationId, reviewed);
    const userApproval = sign(null, Buffer.from(toSign.candidate.messageBase64, 'base64'),
      userKeys.privateKey).toString('base64');
    await assert.rejects(() => flow.submit(ownerId, first.body.operationId, toSign,
      Buffer.alloc(64).toString('base64')), /unavailable/);
    assert.equal((await flow.submit(ownerId, first.body.operationId, toSign,
      userApproval)).status, 'unknown');
    assert.equal(broadcasts, 1);
    assert.equal((await flow.submit(ownerId, first.body.operationId, toSign,
      userApproval)).status, 'unknown');
    assert.equal(broadcasts, 2);
    assert.equal((await flow.status(ownerId, first.body.operationId)).status, 'unknown');
    assert.equal((await reconciler.recordSubmission(ownerId, first.body.operationId,
      transactionSignature)).status, 'unknown');
    await reconciler.recordSubmission(ownerId, first.body.operationId, transactionSignature);
    await assert.rejects(() => pool.query(`INSERT INTO alpha_cooper_level_eru_settlements
      (operation_id,account_id,hybrid_operation_id,reservation_id,signature,
       finalized_slot,intent_digest,transaction_digest,operation_replay_digest,ledger_id)
      VALUES ($1,$2,$3,$4,$5,50,$6,$7,$8,$9)`,
    [first.body.operationId, ownerId, first.body.hybridOperationId,
      last.body.reservationId, transactionSignature, firstIssued.intentDigest,
      'a'.repeat(64), 'b'.repeat(64), randomUUID()]), /binding mismatch/);
    await assert.rejects(() => reconciler.recordSubmission(foreignId,
      first.body.operationId, transactionSignature), /unavailable/);
    finalized = false;
    assert.equal((await reconciler.reconcile(ownerId, first.body.operationId)).status,
      'unknown');
    assert.equal((await pool.query(`SELECT state FROM alpha_ert_reservations
      WHERE id = $1`, [first.body.reservationId])).rows[0].state, 'held');
    finalized = true;
    await pool.query(`CREATE FUNCTION reject_eru_settlement_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected settlement failure'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_eru_settlement_event
      BEFORE INSERT ON alpha_cooper_level_up_events
      FOR EACH ROW EXECUTE FUNCTION reject_eru_settlement_event()`);
    await assert.rejects(() => reconciler.reconcile(ownerId, first.body.operationId),
      /injected settlement failure/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
      alpha_cooper_level_eru_settlements`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT state FROM alpha_ert_reservations
      WHERE id = $1`, [first.body.reservationId])).rows[0].state, 'held');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ert_ledger
      WHERE event_key LIKE 'cooper-level-up:%'`)).rows[0].n, 0);
    await pool.query('DROP TRIGGER reject_eru_settlement_event ON alpha_cooper_level_up_events');
    await pool.query('DROP FUNCTION reject_eru_settlement_event()');
    const resumedReconciler = createCooperEruReconciliation({ pool,
      finalityReader: finality, cluster: 'devnet' });
    const results = await Promise.all([
      resumedReconciler.reconcile(ownerId, first.body.operationId),
      reconciler.reconcile(ownerId, first.body.operationId),
    ]);
    assert(results.every(result => result.status === 'confirmed'));
    assert.deepEqual(results[0].snapshot, results[1].snapshot);
    assert.equal((await reconciler.reconcile(ownerId, first.body.operationId)).status,
      'confirmed');
    assert.equal((await flow.status(ownerId, first.body.operationId)).status, 'confirmed');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
      alpha_cooper_level_eru_settlements`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT amount::text FROM alpha_ert_ledger
      WHERE event_key = $1`, [`cooper-level-up:${first.body.operationId}`])).rows[0].amount,
    '-24.000000000000000000');
    assert.equal((await pool.query(`SELECT level, unspent_attribute_points
      FROM alpha_cooper_current_state WHERE account_id = $1`, [ownerId])).rows[0].level, 5);
    assert.equal((await pool.query(`SELECT state FROM alpha_ert_reservations
      WHERE id = $1`, [first.body.reservationId])).rows[0].state, 'consumed');
    assert.deepEqual((await pool.query(`SELECT balance::text, reserved::text,
      available::text FROM alpha_ert_available WHERE account_id = $1`,
    [ownerId])).rows[0], { balance: '76.000000000000000000',
      reserved: '0', available: '76.000000000000000000' });
    const secondSignature = bs58.encode(Buffer.alloc(64, 3));
    const missingSignature = bs58.encode(Buffer.alloc(64, 4));
    const secondIntent = (await pool.query(`SELECT intent_digest FROM
      alpha_cooper_level_eru_issuances WHERE operation_id = $1`,
    [last.body.operationId])).rows[0].intent_digest;
    const secondReconciler = createCooperEruReconciliation({ pool, cluster: 'devnet',
      finalityReader: { async verify(accountId, operationId, signature) {
        if (signature === missingSignature) return { status: 'unknown' };
        assert.deepEqual([accountId, operationId, signature],
          [foreignId, last.body.operationId, secondSignature]);
        return { status: 'verified', accountId, operationId, signature,
          slot: 60, intentDigest: secondIntent,
          transactionDigest: 'a'.repeat(64), operationReplayDigest: 'b'.repeat(64) };
      } } });
    await secondReconciler.recordSubmission(foreignId, last.body.operationId,
      missingSignature);
    assert.equal((await secondReconciler.reconcile(foreignId, last.body.operationId)).status,
      'unknown');
    await secondReconciler.recordSubmission(foreignId, last.body.operationId,
      secondSignature);
    const secondSettled = await secondReconciler.reconcile(foreignId, last.body.operationId);
    assert.equal(secondSettled.status, 'confirmed');
    assert.deepEqual(secondSettled.snapshot.level, { previous: 19, current: 20 });
    assert.deepEqual(secondSettled.snapshot.unspentAttributePoints,
      { previous: 72, granted: 4, current: 76 });
    assert.equal((await pool.query(`SELECT amount::text FROM alpha_ert_ledger
      WHERE event_key = $1`, [`cooper-level-up:${last.body.operationId}`])).rows[0].amount,
    '-84.000000000000000000');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM
      alpha_cooper_level_eru_settlements`)).rows[0].n, 2);
    assert.deepEqual((await pool.query(`SELECT balance::text, reserved::text,
      available::text FROM alpha_ert_available WHERE account_id = $1`,
    [foreignId])).rows[0], { balance: '0.000000000000000000',
      reserved: '0', available: '0.000000000000000000' });
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_settlements
      SET finalized_slot = 51 WHERE operation_id = $1`, [first.body.operationId]), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_submissions
      SET account_id = $2 WHERE signature = $1`, [transactionSignature, foreignId]), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_preparations
      SET status = 'unknown' WHERE operation_id = $1`, [first.body.operationId]), /immutable/);
    await assert.rejects(() => pool.query(settlementDown), /rollback would discard/);
    await assert.rejects(() => pool.query(`UPDATE alpha_cooper_level_eru_issuances
      SET nonce = 2 WHERE operation_id = $1`, [first.body.operationId]), /immutable/);
    await assert.rejects(() => pool.query(issuanceDown), /rollback would discard/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
