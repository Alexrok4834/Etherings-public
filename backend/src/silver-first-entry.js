import { createHash } from 'node:crypto';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';

const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const UNBOUND = { status: 409, body: { message: 'Verified wallet binding required.' } };
const hash = (value) => createHash('sha256').update(value, 'ascii').digest('hex');
const tokenHash = (value) => hash(value);
function solanaAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch { return false; }
}

export function firstEntryIdentity(accountId, walletAddress, cluster) {
  const issuanceId = hash(`EtheRings:first-entry:issuance:v1\n${cluster}\n${accountId}\n`);
  const entitlementDigest = hash(
    `EtheRings:first-entry:entitlement:v1\n${cluster}\n${accountId}\n${walletAddress}\n${issuanceId}\n`
  );
  return { issuanceId, entitlementDigest };
}

export function createSilverFirstEntry({ pool, chain, cluster, programId, collectionId,
  walletEnvironment, now = () => new Date() }) {
  if (!pool || typeof chain?.readFinalized !== 'function' ||
      !['local-validator', 'devnet'].includes(cluster) || !solanaAddress(programId) ||
      !solanaAddress(collectionId) || !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? '')) {
    throw new Error('Silver first-entry requires isolated PostgreSQL, chain reader and exact environment');
  }

  async function binding(client, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (await client.query(
      `SELECT a.id AS account_id, b.wallet_address, b.environment
       FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
       LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
      [tokenHash(token), now()]
    )).rows[0] ?? null;
  }

  async function entitlement(token) {
    const user = await binding(pool, token);
    if (!user) return { error: UNAUTHORIZED };
    if (!user.wallet_address || user.environment !== walletEnvironment) return { error: UNBOUND };
    const expected = firstEntryIdentity(user.account_id, user.wallet_address, cluster);
    return { user, expected };
  }

  return {
    async reserve(token) {
      const context = await entitlement(token);
      if (context.error) return context.error;
      const { user, expected } = context;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO alpha_silver_first_entry
           (account_id, wallet_address, cluster, issuance_id, entitlement_digest)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id, cluster) DO NOTHING`,
          [user.account_id, user.wallet_address, cluster, expected.issuanceId, expected.entitlementDigest]
        );
        const row = (await client.query(
          'SELECT * FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = $2 FOR UPDATE',
          [user.account_id, cluster]
        )).rows[0];
        if (row.wallet_address !== user.wallet_address || row.cluster !== cluster ||
            row.issuance_source !== 'first-entry' || row.issuance_id !== expected.issuanceId ||
            row.entitlement_digest !== expected.entitlementDigest) {
          await client.query('ROLLBACK');
          return { status: 409, body: { message: 'Entitlement binding conflict.' } };
        }
        await client.query('COMMIT');
        return { status: 200, body: { issuanceId: row.issuance_id,
          entitlementDigest: row.entitlement_digest, status: row.status } };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async inventory(token) {
      const context = await entitlement(token);
      if (context.error) return context.error;
      const { user, expected } = context;
      const row = (await pool.query(
        'SELECT * FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = $2',
        [user.account_id, cluster]
      )).rows[0];
      if (!row) return { status: 200, body: { assets: [] } };
      if (row.wallet_address !== user.wallet_address || row.cluster !== cluster ||
          row.issuance_source !== 'first-entry' ||
          row.issuance_id !== expected.issuanceId ||
          row.entitlement_digest !== expected.entitlementDigest) {
        return { status: 409, body: { message: 'Entitlement binding conflict.' } };
      }
      const asset = await chain.readFinalized({ programId, cluster, issuanceId: row.issuance_id,
        expectedFinalizedSignature: row.finalized_signature });
      if (!asset) return { status: 200, body: { assets: [] } };
      const [expectedMint] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [new TextEncoder().encode('silver-mint'), Buffer.from(row.issuance_id, 'hex')]
      });
      const [expectedState] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [new TextEncoder().encode('silver-state'), bs58.decode(expectedMint)]
      });
      if (asset.finalized !== true || ![2, 3].includes(asset.stateSchemaVersion) ||
          asset.programId !== programId || asset.stateOwnerProgramId !== programId ||
          asset.mintOwnerProgramId !== TOKEN_2022_PROGRAM_ADDRESS ||
          asset.tokenAccountOwnerProgramId !== TOKEN_2022_PROGRAM_ADDRESS ||
          asset.collectionId !== collectionId || asset.cluster !== cluster ||
          asset.issuanceId !== row.issuance_id || asset.entitlementDigest !== row.entitlement_digest ||
          asset.issuanceSource !== 'first-entry' || asset.accountId !== user.account_id ||
          asset.kind !== 'SILVER_BOX' || asset.lifecycle !== 'SEALED' ||
          asset.originalRecipient !== user.wallet_address ||
          asset.mintAddress !== expectedMint || asset.stateAddress !== expectedState ||
          asset.stateMint !== asset.mintAddress || asset.tokenMint !== asset.mintAddress ||
          asset.supply !== '1' || asset.decimals !== 0 || asset.tokenAmount !== '1' ||
          asset.mintAuthority !== null || asset.freezeAuthority !== null ||
          !asset.mintAddress || !asset.finalizedSignature) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (asset.stateSchemaVersion === 3 &&
          (!/^(0|[1-9][0-9]*)$/.test(asset.lastDirectTransferSlot) ||
           !/^(0|[1-9][0-9]*)$/.test(asset.cooldownUntilUnixSeconds) ||
           (asset.lastDirectTransferSlot === '0') !==
             (asset.cooldownUntilUnixSeconds === '0'))) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (row.status !== 'confirmed') {
        await pool.query(
          `UPDATE alpha_silver_first_entry SET status = 'confirmed', mint_address = $2,
           finalized_signature = $3, confirmed_at = $4
           WHERE account_id = $1 AND cluster = $5 AND status IN ('pending', 'unknown')`,
          [user.account_id, asset.mintAddress, asset.finalizedSignature, now(), cluster]
        );
      }
      const finalized = (await pool.query(
        `SELECT status, mint_address, finalized_signature FROM alpha_silver_first_entry
         WHERE account_id = $1 AND cluster = $2`, [user.account_id, cluster]
      )).rows[0];
      if (finalized?.status !== 'confirmed' || finalized.mint_address !== asset.mintAddress ||
          finalized.finalized_signature !== asset.finalizedSignature) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (asset.tokenOwner !== user.wallet_address) return { status: 200, body: { assets: [] } };
      return { status: 200, body: { assets: [{ kind: 'SILVER_BOX', mintAddress: asset.mintAddress,
        issuanceId: row.issuance_id, lifecycle: 'SEALED',
        ...(asset.stateSchemaVersion === 3 ? {
          cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
        } : {}) }] } };
    }
  };
}
