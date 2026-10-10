import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import bs58 from 'bs58';

const DOMAIN = 'EtheRings Alpha wallet binding';
const TTL_MS = 10 * 60_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const INVALID = { status: 400, body: { message: 'Invalid wallet binding request.' } };
const UNAVAILABLE = { status: 409, body: { message: 'Wallet binding unavailable.' } };

function accountTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicKeyBytes(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null;
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32 && bs58.encode(decoded) === address ? decoded : null;
  } catch { return null; }
}

function strictBase64(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === size && decoded.toString('base64') === value ? decoded : null;
}

// ASCII v1: fixed field order, fixed key names, validated values, final LF.
export function bindingMessage({ accountId, walletAddress, environment, nonce, issuedAtMs, expiresAtMs }) {
  return Buffer.from(
    `${DOMAIN}\nversion=1\naccount=${accountId}\nwallet=${walletAddress}\nenvironment=${environment}\nnonce=${nonce}\nissued_at_ms=${issuedAtMs}\nexpires_at_ms=${expiresAtMs}\n`,
    'ascii'
  );
}

export function createWalletBinding({ pool, environment, now = () => Date.now() }) {
  if (!pool || typeof environment !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(environment)) {
    throw new Error('Alpha wallet binding requires PostgreSQL and a configured environment');
  }

  async function account(client, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (await client.query(
      `SELECT a.id FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL FOR SHARE OF s`,
      [accountTokenHash(token), new Date(now())]
    )).rows[0] ?? null;
  }

  return {
    async issue(token, { walletAddress } = {}) {
      if (!publicKeyBytes(walletAddress)) return INVALID;
      const user = await account(pool, token);
      if (!user) return UNAUTHORIZED;
      const existing = await pool.query('SELECT 1 FROM alpha_wallet_bindings WHERE account_id = $1', [user.id]);
      if (existing.rowCount) return UNAVAILABLE;
      const issuedAtMs = now();
      const expiresAtMs = issuedAtMs + TTL_MS;
      const nonce = randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO alpha_wallet_binding_challenges
         (nonce, account_id, wallet_address, environment, issued_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [nonce, user.id, walletAddress, environment, issuedAtMs, expiresAtMs]
      );
      const message = bindingMessage({ accountId: user.id, walletAddress, environment, nonce, issuedAtMs, expiresAtMs });
      return { status: 200, body: { nonce, messageBase64: message.toString('base64'), expiresAtMs } };
    },

    async bind(token, { nonce, walletAddress, messageBase64, signatureBase64 } = {}) {
      const publicBytes = publicKeyBytes(walletAddress);
      const signature = strictBase64(signatureBase64, 64);
      if (!/^[a-f0-9]{64}$/.test(nonce ?? '') || !publicBytes || !signature ||
          typeof messageBase64 !== 'string' || messageBase64.length > 1024) return INVALID;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const user = await account(client, token);
        if (!user) { await client.query('ROLLBACK'); return UNAUTHORIZED; }
        await client.query('SELECT id FROM alpha_accounts WHERE id = $1 FOR UPDATE', [user.id]);
        const challenge = (await client.query(
          'SELECT * FROM alpha_wallet_binding_challenges WHERE nonce = $1 FOR UPDATE', [nonce]
        )).rows[0];
        if (!challenge || challenge.account_id !== user.id || challenge.wallet_address !== walletAddress ||
            challenge.environment !== environment || challenge.consumed_at_ms !== null ||
            Number(challenge.expires_at_ms) <= now()) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        const message = bindingMessage({
          accountId: challenge.account_id, walletAddress: challenge.wallet_address,
          environment: challenge.environment, nonce: challenge.nonce,
          issuedAtMs: challenge.issued_at_ms, expiresAtMs: challenge.expires_at_ms
        });
        if (message.toString('base64') !== messageBase64) {
          await client.query('ROLLBACK'); return INVALID;
        }
        const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicBytes]), format: 'der', type: 'spki' });
        if (!verify(null, message, key, signature)) {
          await client.query('ROLLBACK'); return INVALID;
        }
        const inserted = await client.query(
          `INSERT INTO alpha_wallet_bindings (account_id, wallet_address, environment)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING account_id`,
          [user.id, walletAddress, environment]
        );
        if (!inserted.rowCount) { await client.query('ROLLBACK'); return UNAVAILABLE; }
        await client.query(
          'UPDATE alpha_wallet_binding_challenges SET consumed_at_ms = $2 WHERE nonce = $1', [nonce, now()]
        );
        await client.query('COMMIT');
        return { status: 200, body: { walletAddress, environment } };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async current(token) {
      const user = await account(pool, token);
      if (!user) return UNAUTHORIZED;
      const binding = (await pool.query(
        'SELECT wallet_address, environment FROM alpha_wallet_bindings WHERE account_id = $1', [user.id]
      )).rows[0];
      return { status: 200, body: binding ? { walletAddress: binding.wallet_address, environment: binding.environment } : { walletAddress: null } };
    }
  };
}
