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
      '007_alpha_silver_first_entry.sql']) {
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
    let readInput;
    const chain = { readFinalized: async (input) => { readInput = input; return observation; } };
    const service = () => createSilverFirstEntry({ pool, chain, cluster: 'devnet',
      programId, collectionId, walletEnvironment: 'alpha-dev' });
    assert.equal((await service().reserve(null)).status, 401);
    await pool.query('UPDATE alpha_accounts SET verified_at = NULL WHERE id = $1', [accountId]);
    assert.equal((await service().reserve(token)).status, 401);
    await pool.query('UPDATE alpha_accounts SET verified_at = now() WHERE id = $1', [accountId]);
    await pool.query('DELETE FROM alpha_wallet_bindings WHERE account_id = $1', [accountId]);
    assert.equal((await service().reserve(token)).status, 409);
    await pool.query(`INSERT INTO alpha_wallet_bindings(account_id, wallet_address, environment)
      VALUES ($1, $2, 'alpha-dev')`, [accountId, wallet]);
    assert.deepEqual((await service().inventory(token)).body.assets, []);

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
    const valid = { programId, cluster: 'devnet', accountId, issuanceSource: 'first-entry',
      finalized: true, stateSchemaVersion: 2, stateOwnerProgramId: programId,
      mintOwnerProgramId: TOKEN_2022_PROGRAM_ADDRESS,
      tokenAccountOwnerProgramId: TOKEN_2022_PROGRAM_ADDRESS, collectionId,
      issuanceId: reservations[0].body.issuanceId,
      entitlementDigest: reservations[0].body.entitlementDigest,
      kind: 'SILVER_BOX', lifecycle: 'SEALED',
      mintAddress, stateAddress, stateMint: mintAddress, tokenMint: mintAddress,
      tokenOwner: wallet, originalRecipient: wallet, tokenAmount: '1', supply: '1', decimals: 0,
      mintAuthority: null, freezeAuthority: null, finalizedSignature: 'synthetic-finalized-signature' };
    const fakeMint = bs58.encode(randomBytes(32));
    for (const mutation of [
      { programId: 'fake-program' }, { stateSchemaVersion: 1 },
      { stateOwnerProgramId: 'fake-program' }, { collectionId: 'fake-collection' },
      { finalized: false }, { cluster: 'local-validator' },
      { accountId: randomUUID() }, { issuanceSource: 'cooper-breeding' },
      { issuanceId: sha('fake') }, { entitlementDigest: sha('replay') },
      { kind: 'SILVER_RING' }, { originalRecipient: 'other-wallet' },
      { mintAddress: fakeMint, stateMint: fakeMint, tokenMint: fakeMint },
      { stateMint: 'fake-mint' }, { stateAddress: bs58.encode(randomBytes(32)) },
      { tokenMint: 'fake-mint' }, { tokenAmount: '0' },
      { finalizedSignature: null }
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
      mintAddress: valid.mintAddress, issuanceId: valid.issuanceId, lifecycle: 'SEALED' }]);
    assert.equal((await service().reserve(token)).body.status, 'confirmed');
    await assert.rejects(pool.query(`UPDATE alpha_silver_first_entry
      SET entitlement_digest = $2 WHERE account_id = $1 AND cluster = 'devnet'`,
    [accountId, sha('forged')]), { code: '23514' });
    await pool.end();
    pool = connect();
    assert.deepEqual((await service().inventory(token)).body.assets, owned.body.assets);
    assert.equal(readInput.expectedFinalizedSignature, valid.finalizedSignature);
    observation = { ...valid, stateSchemaVersion: 3,
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
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM alpha_silver_first_entry')).rows[0].n, 3);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
