import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { createSilverFirstEntry, firstEntryIdentity } from '../src/silver-first-entry.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const sha = value => createHash('sha256').update(value).digest('hex');

test('first-entry is durable once; only verified finalized chain ownership projects', async () => {
  const schema = 'alpha_silver_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connect = () => new pg.Pool({ connectionString: databaseUrl, max: 6,
      options: `-c search_path=${schema}` });
    pool = connect();
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '007_alpha_silver_first_entry.sql', '009_alpha_silver_state_finality.sql']) {
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    }
    const accountId = randomUUID();
    const wallet = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
    const token = randomBytes(32).toString('hex');
    const programId = bs58.encode(randomBytes(32));
    const collectionId = bs58.encode(randomBytes(32));
    await pool.query(`INSERT INTO alpha_accounts(id, email_normalized, password_hash, verified_at)
      VALUES ($1, 'silver@example.invalid', 'synthetic-only', now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id, wallet_address, environment)
      VALUES ($1, $2, 'alpha-dev')`, [accountId, wallet]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash, account_id, expires_at)
      VALUES ($1, $2, now() + interval '1 hour')`, [sha(token), accountId]);

    let observation = null;
    let ringObservation = null;
    let transferredRings = [];
    let readInput;
    const chain = { readFinalized: async (input) => { readInput = input; return observation; },
      readRingForIssuance: async () => ringObservation,
      listOwnedRings: async () => transferredRings };
    const service = () => createSilverFirstEntry({ pool, chain, cluster: 'devnet',
      programId, collectionId, walletEnvironment: 'alpha-dev' });
    const gameplay = { level: 1, shine: 100, unspentPoints: 0,
      comfort: 15, charm: 20, quality: 25, luck: 30,
      lastDirectTransferSlot: '0', cooldownUntilUnixSeconds: '0' };
    assert.equal((await service().reserve(null)).status, 401);
    await pool.query('UPDATE alpha_accounts SET verified_at = NULL WHERE id = $1', [accountId]);
    assert.equal((await service().reserve(token)).status, 401);
    await pool.query('UPDATE alpha_accounts SET verified_at = now() WHERE id = $1', [accountId]);
    await pool.query('DELETE FROM alpha_wallet_bindings WHERE account_id = $1', [accountId]);
    assert.equal((await service().reserve(token)).status, 409);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id, wallet_address, environment)
      VALUES ($1, $2, 'alpha-dev')`, [accountId, wallet]);
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    const transferredMint = bs58.encode(randomBytes(32));
    const transferred = { finalized: true, kind: 'SILVER_RING', programId,
      cluster: 'devnet', collectionId, tokenOwner: wallet, mintAddress: transferredMint,
      boxMint: bs58.encode(randomBytes(32)), designId: 26, uri: 'ipfs://test-ring',
      contentHash: 'a'.repeat(64), serial: '1', ...gameplay,
      lastDirectTransferSlot: '150', cooldownUntilUnixSeconds: '1790000000' };
    transferredRings = [transferred];
    assert.deepEqual((await service().inventory(token)).body.assets, [{
      kind: 'SILVER_RING', mintAddress: transferredMint, boxMint: transferred.boxMint,
      designId: 26, uri: 'ipfs://test-ring', contentHash: 'a'.repeat(64), serial: '1',
      ...gameplay, lastDirectTransferSlot: '150', cooldownUntilUnixSeconds: '1790000000' }]);
    transferredRings = [{ ...transferred, serial: undefined }];
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    transferredRings = [{ ...transferred, tokenOwner: bs58.encode(randomBytes(32)) }];
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    transferredRings = [];

    const reservations = await Promise.all(Array.from({ length: 8 }, () => service().reserve(token)));
    assert(reservations.every(result => result.status === 200));
    assert(reservations.every(result => result.body.issuanceId === reservations[0].body.issuanceId));
    assert(reservations.every(result => result.body.entitlementDigest === reservations[0].body.entitlementDigest));
    assert.equal(reservations[0].body.status, 'pending');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_first_entry')).rows[0].n, 1);
    const wrongCluster = createSilverFirstEntry({ pool, chain, cluster: 'local-validator',
      programId, collectionId, walletEnvironment: 'alpha-dev' });
    const localReservation = await wrongCluster.reserve(token);
    assert.equal(localReservation.status, 200);
    assert.notEqual(localReservation.body.issuanceId, reservations[0].body.issuanceId);
    assert.deepEqual((await wrongCluster.inventory(token)).body.assets, []);
    const secondAccount = randomUUID();
    const secondWallet = bs58.encode(randomBytes(32));
    const secondToken = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO alpha_accounts(id, email_normalized, password_hash, verified_at)
      VALUES ($1, 'silver-second@example.invalid', 'synthetic-only', now())`, [secondAccount]);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id, wallet_address, environment)
      VALUES ($1, $2, 'alpha-dev')`, [secondAccount, secondWallet]);
    await pool.query(`INSERT INTO alpha_sessions(token_hash, account_id, expires_at)
      VALUES ($1, $2, now() + interval '1 hour')`, [sha(secondToken), secondAccount]);
    const secondReservation = await service().reserve(secondToken);
    assert.equal(secondReservation.status, 200);
    assert.notEqual(secondReservation.body.issuanceId, reservations[0].body.issuanceId);
    assert.notEqual(secondReservation.body.entitlementDigest, reservations[0].body.entitlementDigest);
    assert.deepEqual(firstEntryIdentity(accountId, wallet, 'devnet'), {
      issuanceId: reservations[0].body.issuanceId,
      entitlementDigest: reservations[0].body.entitlementDigest });

    await pool.end();
    pool = connect();
    assert.deepEqual((await service().reserve(token)).body, reservations[0].body);
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    const [mintAddress] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-mint'),
        Buffer.from(reservations[0].body.issuanceId, 'hex')] });
    const [stateAddress] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-state'), bs58.decode(mintAddress)] });
    const [lifecycleAddress] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-lifecycle'), bs58.decode(mintAddress)] });
    const valid = { programId, cluster: 'devnet', accountId, issuanceSource: 'first-entry',
      finalized: true, stateSchemaVersion: 3, stateOwnerProgramId: programId,
      mintOwnerProgramId: TOKEN_2022_PROGRAM_ADDRESS,
      tokenAccountOwnerProgramId: TOKEN_2022_PROGRAM_ADDRESS, collectionId,
      issuanceId: reservations[0].body.issuanceId,
      entitlementDigest: reservations[0].body.entitlementDigest,
      kind: 'SILVER_BOX', lifecycle: 'SEALED',
      lifecycleAddress, lifecycleVersion: 1, lifecyclePhase: 'SEALED',
      lifecycleNextOperation: '1', lifecycleMigrationSlot: '100',
      mintAddress, stateAddress, stateMint: mintAddress, tokenMint: mintAddress,
      tokenOwner: wallet, originalRecipient: wallet, tokenAmount: '1', supply: '1', decimals: 0,
      mintAuthority: null, freezeAuthority: null, finalizedSignature: 'synthetic-finalized-signature',
      issuanceSlot: '100',
      lastDirectTransferSlot: '0', cooldownUntilUnixSeconds: '0',
      uri: 'ipfs://test-box', contentHash: 'c'.repeat(64), serial: '1' };
    const fakeMint = bs58.encode(randomBytes(32));
    for (const mutation of [
      { programId: 'fake-program' }, { stateSchemaVersion: 2 },
      { stateOwnerProgramId: 'fake-program' }, { collectionId: 'fake-collection' },
      { finalized: false }, { cluster: 'local-validator' },
      { accountId: randomUUID() }, { issuanceSource: 'cooper-breeding' },
      { issuanceId: sha('fake') }, { entitlementDigest: sha('replay') },
      { kind: 'SILVER_RING' }, { originalRecipient: 'other-wallet' },
      { lifecycleAddress: bs58.encode(randomBytes(32)) }, { lifecycleVersion: 2 },
      { lifecyclePhase: 'OPENING' }, { lifecycleNextOperation: '2' },
      { lifecycleMigrationSlot: '0' },
      { mintAddress: fakeMint, stateMint: fakeMint, tokenMint: fakeMint },
      { stateMint: 'fake-mint' }, { stateAddress: bs58.encode(randomBytes(32)) },
      { tokenMint: 'fake-mint' }, { tokenAmount: '0' },
      { issuanceSlot: '0' }
    ]) {
      observation = { ...valid, ...mutation };
      assert.equal((await service().inventory(token)).status, 409);
    }
    assert.equal((await pool.query(`SELECT status FROM alpha_silver_first_entry
      WHERE account_id = $1 AND cluster = 'devnet'`, [accountId])).rows[0].status, 'pending');
    observation = valid;
    const restartedLocal = createSilverFirstEntry({ pool, chain, cluster: 'local-validator',
      programId, collectionId, walletEnvironment: 'alpha-dev' });
    assert.equal((await restartedLocal.inventory(token)).status, 409);
    const owned = await service().inventory(token);
    assert.equal(owned.status, 200);
    assert.deepEqual(owned.body.assets, [{ kind: 'SILVER_BOX',
      mintAddress: valid.mintAddress, issuanceId: valid.issuanceId, serial: '1', lifecycle: 'SEALED',
      cooldownUntilUnixSeconds: '0', uri: valid.uri, contentHash: valid.contentHash }]);
    assert.equal((await service().reserve(token)).body.status, 'confirmed');
    const confirmation = (await pool.query(`SELECT finalized_signature, confirmation_slot
      FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = 'devnet'`,
    [accountId])).rows[0];
    assert.equal(confirmation.finalized_signature, valid.finalizedSignature);
    assert.equal(confirmation.confirmation_slot, '100');
    await assert.rejects(pool.query(`UPDATE alpha_silver_first_entry
      SET entitlement_digest = $2 WHERE account_id = $1 AND cluster = 'devnet'`,
    [accountId, sha('forged')]), { code: '23514' });
    await pool.end();
    pool = connect();
    assert.deepEqual((await service().inventory(token)).body.assets, owned.body.assets);
    assert.equal(readInput.expectedFinalizedSignature, valid.finalizedSignature);
    observation = { ...valid,
      lastDirectTransferSlot: '150', cooldownUntilUnixSeconds: '1790000000' };
    const migrated = await service().inventory(token);
    assert.deepEqual(migrated.body.assets, [{ ...owned.body.assets[0],
      cooldownUntilUnixSeconds: '1790000000' }]);
    await pool.end();
    pool = connect();
    assert.deepEqual((await service().inventory(token)).body.assets, migrated.body.assets);
    observation = { ...observation, cooldownUntilUnixSeconds: '-1' };
    assert.equal((await service().inventory(token)).status, 409);
    observation = { ...valid, stateSchemaVersion: 3,
      lastDirectTransferSlot: '150', cooldownUntilUnixSeconds: '1790000000',
      tokenOwner: 'other-wallet' };
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    const conflictingMint = bs58.encode(randomBytes(32));
    observation = { ...valid, mintAddress: conflictingMint,
      stateMint: conflictingMint, tokenMint: conflictingMint };
    assert.equal((await service().inventory(token)).status, 409);
    observation = { ...valid, tokenOwner: 'other-wallet' };
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    observation = null;
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    const ringMint = bs58.encode(randomBytes(32));
    ringObservation = { finalized: true, kind: 'SILVER_RING', programId, cluster: 'devnet',
      issuanceId: valid.issuanceId, entitlementDigest: valid.entitlementDigest,
      accountId, originalRecipient: wallet, boxMint: mintAddress,
      collectionId, tokenOwner: wallet, mintAddress: ringMint,
      designId: 26, uri: 'ipfs://synthetic-ring', contentHash: 'b'.repeat(64),
      serial: '1', ...gameplay };
    const ringAssets = [{ kind: 'SILVER_RING', mintAddress: ringMint,
      boxMint: mintAddress, designId: 26, uri: 'ipfs://synthetic-ring',
      contentHash: 'b'.repeat(64), serial: '1', ...gameplay }];
    assert.deepEqual((await service().inventory(token)).body.assets, ringAssets);
    await pool.end();
    pool = connect();
    assert.deepEqual((await service().inventory(token)).body.assets, ringAssets);
    for (const mutation of [{ accountId: secondAccount }, { boxMint: fakeMint },
      { tokenOwner: secondWallet }, { cluster: 'local-validator' },
      { entitlementDigest: sha('forged-ring') }]) {
      ringObservation = { ...ringObservation, ...mutation };
      assert.equal((await service().inventory(token)).status, 409);
    }
    ringObservation = null;
    assert.deepEqual((await service().inventory(token)).body.assets, []);
    observation = { ...valid, finalizedSignature: null };
    const secondIssued = firstEntryIdentity(secondAccount, secondWallet, 'devnet');
    const [secondMint] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-mint'), Buffer.from(secondIssued.issuanceId, 'hex')] });
    const [secondState] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-state'), bs58.decode(secondMint)] });
    const [secondLife] = await getProgramDerivedAddress({ programAddress: address(programId),
      seeds: [new TextEncoder().encode('silver-lifecycle'), bs58.decode(secondMint)] });
    observation = { ...valid, finalizedSignature: null,
      accountId: secondAccount, issuanceId: secondIssued.issuanceId,
      entitlementDigest: secondIssued.entitlementDigest, originalRecipient: secondWallet,
      tokenOwner: secondWallet, mintAddress: secondMint, stateMint: secondMint,
      tokenMint: secondMint, stateAddress: secondState, lifecycleAddress: secondLife };
    assert.equal((await service().inventory(secondToken)).status, 200);
    const secondFinal = (await pool.query(`SELECT status, finalized_signature, confirmation_slot
      FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = 'devnet'`,
    [secondAccount])).rows[0];
    assert.deepEqual(secondFinal, { status: 'confirmed', finalized_signature: null,
      confirmation_slot: '100' });
    await pool.end();
    pool = connect();
    assert.equal((await service().inventory(secondToken)).body.assets.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_first_entry')).rows[0].n, 3);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('state-finality migration preserves an already confirmed legacy issuance', async () => {
  const schema = 'alpha_silver_legacy_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
      '007_alpha_silver_first_entry.sql']) {
      await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    }
    const accountId = randomUUID();
    const wallet = bs58.encode(randomBytes(32));
    const identity = firstEntryIdentity(accountId, wallet, 'devnet');
    const mint = bs58.encode(randomBytes(32));
    const signature = bs58.encode(randomBytes(64));
    await pool.query(`INSERT INTO alpha_accounts(id, email_normalized, password_hash, verified_at)
      VALUES ($1, 'legacy-silver@example.invalid', 'synthetic-only', now())`, [accountId]);
    await pool.query(`INSERT INTO alpha_silver_first_entry
      (account_id, wallet_address, cluster, issuance_id, entitlement_digest,
       status, mint_address, finalized_signature, confirmed_at)
      VALUES ($1, $2, 'devnet', $3, $4, 'confirmed', $5, $6, now())`,
    [accountId, wallet, identity.issuanceId, identity.entitlementDigest, mint, signature]);
    await pool.query(await readFile(new URL('../schema/009_alpha_silver_state_finality.sql',
      import.meta.url), 'utf8'));
    const row = (await pool.query(`SELECT status, mint_address, finalized_signature,
      confirmation_slot FROM alpha_silver_first_entry WHERE account_id = $1`, [accountId])).rows[0];
    assert.deepEqual(row, { status: 'confirmed', mint_address: mint,
      finalized_signature: signature, confirmation_slot: null });
    await assert.rejects(pool.query(`UPDATE alpha_silver_first_entry SET confirmation_slot = 100
      WHERE account_id = $1`, [accountId]), { code: '23514' });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
