import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_N = 1 << 17;
const PASSWORD_MAXMEM = 256 * 1024 * 1024;
const CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACCEPTED = { status: 202, body: { message: 'If eligible, a verification email will be sent.' } };
const INVALID = { status: 400, body: { message: 'Invalid or expired verification code.' } };
const UNAUTHORIZED = { status: 401, body: { message: 'Invalid credentials.' } };
const LIMITED = { status: 429, body: { message: 'Too many requests. Please try again later.' } };

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function codeDigest(secret, accountId, code) {
  return createHmac('sha256', secret).update(`${accountId}:${code}`).digest('hex');
}
function equalHex(a, b) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
async function passwordHash(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: PASSWORD_N, r: 8, p: 1, maxmem: PASSWORD_MAXMEM });
  return `scrypt:${PASSWORD_N}:8:1:${salt.toString('hex')}:${derived.toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [name, n, r, p, salt, expected] = stored.split(':');
  if (name !== 'scrypt') return false;
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: PASSWORD_MAXMEM });
  return equalHex(actual.toString('hex'), expected);
}

export function createAuth({ pool, mailer, codeSecret, now = () => Date.now(), onVerified = null }) {
  if (!pool || typeof mailer?.sendVerification !== 'function' || !codeSecret || codeSecret.length < 32) {
    throw new Error('Alpha auth requires PostgreSQL, mail transport and a 32+ character code secret');
  }
  const date = () => new Date(now());
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function limit(client, kind, email, max, windowMs) {
    const key = digest(`${kind}:${email}`);
    const current = date();
    const row = (await client.query(
      `INSERT INTO alpha_rate_limits (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET
         window_start = CASE WHEN alpha_rate_limits.window_start <= $3 THEN $2 ELSE alpha_rate_limits.window_start END,
         count = CASE WHEN alpha_rate_limits.window_start <= $3 THEN 1 ELSE alpha_rate_limits.count + 1 END
       RETURNING count`, [key, current, new Date(now() - windowMs)]
    )).rows[0];
    return row.count <= max;
  }
  async function sendCode(client, account, email) {
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    await client.query(
      `INSERT INTO alpha_email_challenges (account_id, code_hash, expires_at, attempts, sent_at)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (account_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
      [account.id, codeDigest(codeSecret, account.id, code), new Date(now() + CODE_TTL_MS), date()]
    );
    await mailer.sendVerification(email, code);
  }
  async function revokeFamily(client, familyId, reason) {
    await client.query(
      `UPDATE alpha_refresh_tokens SET status = 'REVOKED', revoked_at = $2,
       revocation_reason = $3 WHERE family_id = $1 AND status <> 'REVOKED'`,
      [familyId, date(), reason]);
    await client.query('DELETE FROM alpha_sessions WHERE family_id = $1', [familyId]);
  }
  async function issueSession(client, accountId, installationId) {
    const accessToken = randomBytes(32).toString('hex');
    if (installationId === undefined) {
      await client.query('INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
        [digest(accessToken), accountId, new Date(now() + SESSION_TTL_MS)]);
      return { accessToken, expiresIn: SESSION_TTL_MS / 1000 };
    }
    const installation = (await client.query(
      `INSERT INTO alpha_m2e_installations (id, account_id, installation_id, status, last_seen_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4)
       ON CONFLICT (account_id, installation_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
       RETURNING id, status`, [randomUUID(), accountId, installationId, date()])).rows[0];
    if (installation.status !== 'ACTIVE') return null;
    const previous = await client.query(
      `SELECT DISTINCT family_id FROM alpha_refresh_tokens WHERE account_id = $1
       AND installation_record_id = $2 AND status = 'ACTIVE'`, [accountId, installation.id]);
    for (const row of previous.rows) await revokeFamily(client, row.family_id, 'REAUTHENTICATED');
    const familyId = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(now() + REFRESH_TTL_MS);
    await client.query(
      `INSERT INTO alpha_refresh_tokens
       (id, family_id, account_id, installation_record_id, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
      [randomUUID(), familyId, accountId, installation.id, digest(refreshToken), refreshTokenExpiresAt]);
    await client.query(
      `INSERT INTO alpha_sessions (token_hash, account_id, expires_at, family_id)
       VALUES ($1, $2, $3, $4)`,
      [digest(accessToken), accountId, new Date(now() + SESSION_TTL_MS), familyId]);
    return { accessToken, expiresIn: SESSION_TTL_MS / 1000,
      refreshToken, refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString() };
  }
  return {
    async register({ email: input, password }) {
      const email = normalizeEmail(input);
      if (!email || typeof password !== 'string' || password.length < 8 || password.length > 256) {
        return { status: 400, body: { message: 'Invalid registration request.' } };
      }
      const hash = await passwordHash(password);
      const accepted = await transaction(async client => {
        if (!await limit(client, 'register', email, 5, 60 * 60_000)) return false;
        const account = (await client.query(
          `INSERT INTO alpha_accounts (id, email_normalized, password_hash)
           VALUES ($1, $2, $3) ON CONFLICT (email_normalized) DO NOTHING RETURNING id`,
          [randomUUID(), email, hash]
        )).rows[0];
        if (account) await sendCode(client, account, email);
        return true;
      });
      return accepted ? ACCEPTED : LIMITED;
    },
    async resend({ email: input }) {
      const email = normalizeEmail(input);
      if (!email) return ACCEPTED;
      const accepted = await transaction(async client => {
        if (!await limit(client, 'resend-hour', email, 5, 60 * 60_000)) return false;
        if (!await limit(client, 'resend-minute', email, 1, 60_000)) return false;
        const account = (await client.query(
          'SELECT id FROM alpha_accounts WHERE email_normalized = $1 AND verified_at IS NULL FOR UPDATE', [email]
        )).rows[0];
        if (account) await sendCode(client, account, email);
        return true;
      });
      return accepted ? ACCEPTED : LIMITED;
    },
    async verify({ email: input, code, installationId }) {
      const email = normalizeEmail(input);
      if (!email || typeof code !== 'string' || !/^\d{4}$/.test(code)) return INVALID;
      if (installationId !== undefined && !INSTALLATION_ID.test(installationId))
        return { status: 400, body: { message: 'Invalid installation ID.' } };
      return transaction(async client => {
        if (!await limit(client, 'verify', email, 10, 60 * 60_000)) return LIMITED;
        const account = (await client.query(
          'SELECT id FROM alpha_accounts WHERE email_normalized = $1 AND verified_at IS NULL FOR UPDATE', [email]
        )).rows[0];
        if (!account) return INVALID;
        const challenge = (await client.query(
          'SELECT * FROM alpha_email_challenges WHERE account_id = $1 FOR UPDATE', [account.id]
        )).rows[0];
        if (!challenge || challenge.attempts >= 5 || challenge.expires_at.getTime() <= now()) return INVALID;
        if (!equalHex(codeDigest(codeSecret, account.id, code), challenge.code_hash)) {
          await client.query('UPDATE alpha_email_challenges SET attempts = attempts + 1 WHERE account_id = $1', [account.id]);
          return INVALID;
        }
        await client.query('UPDATE alpha_accounts SET verified_at = $2 WHERE id = $1', [account.id, date()]);
        await client.query('DELETE FROM alpha_email_challenges WHERE account_id = $1', [account.id]);
        if (onVerified) await onVerified(client, account.id);
        const session = await issueSession(client, account.id, installationId);
        return session ? { status: 200, body: session } : { status: 409, body: { message: 'Installation is revoked.' } };
      });
    },
    async login({ email: input, password, installationId }) {
      const email = normalizeEmail(input);
      if (!email || typeof password !== 'string') return UNAUTHORIZED;
      if (installationId !== undefined && !INSTALLATION_ID.test(installationId))
        return { status: 400, body: { message: 'Invalid installation ID.' } };
      return transaction(async client => {
        const account = (await client.query(
          'SELECT id, password_hash, verified_at FROM alpha_accounts WHERE email_normalized = $1 FOR UPDATE',
          [email])).rows[0];
        const dummy = 'scrypt:131072:8:1:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
        const matches = await passwordMatches(password, account?.password_hash ?? dummy);
        if (!account?.verified_at || !matches) return UNAUTHORIZED;
        const session = await issueSession(client, account.id, installationId);
        return session ? { status: 200, body: session } : { status: 409, body: { message: 'Installation is revoked.' } };
      });
    },
    async refresh({ refreshToken, installationId } = {}) {
      if (typeof refreshToken !== 'string' || !REFRESH_TOKEN.test(refreshToken) ||
          typeof installationId !== 'string' || !INSTALLATION_ID.test(installationId)) return UNAUTHORIZED;
      return transaction(async client => {
        const candidate = (await client.query(
          'SELECT account_id FROM alpha_refresh_tokens WHERE token_hash = $1', [digest(refreshToken)])).rows[0];
        if (!candidate) return UNAUTHORIZED;
        const account = (await client.query(
          'SELECT id, verified_at FROM alpha_accounts WHERE id = $1 FOR UPDATE', [candidate.account_id])).rows[0];
        if (!account?.verified_at) return UNAUTHORIZED;
        const token = (await client.query(
          'SELECT * FROM alpha_refresh_tokens WHERE token_hash = $1 FOR UPDATE', [digest(refreshToken)])).rows[0];
        if (!token) return UNAUTHORIZED;
        if (token.status !== 'ACTIVE') {
          await revokeFamily(client, token.family_id, 'REPLAY_DETECTED');
          return UNAUTHORIZED;
        }
        const installation = (await client.query(
          'SELECT installation_id, status FROM alpha_m2e_installations WHERE id = $1 AND account_id = $2',
          [token.installation_record_id, account.id])).rows[0];
        if (!installation || installation.installation_id !== installationId || installation.status !== 'ACTIVE') {
          await revokeFamily(client, token.family_id, 'INSTALLATION_MISMATCH');
          return UNAUTHORIZED;
        }
        if (token.expires_at.getTime() <= now()) {
          await revokeFamily(client, token.family_id, 'EXPIRED');
          return UNAUTHORIZED;
        }
        const accessToken = randomBytes(32).toString('hex');
        const replacement = randomBytes(32).toString('base64url');
        const replacementId = randomUUID();
        const expiresAt = new Date(now() + REFRESH_TTL_MS);
        await client.query(
          `UPDATE alpha_refresh_tokens SET status = 'ROTATED', consumed_at = $2,
           replaced_by_token_id = $3 WHERE id = $1`, [token.id, date(), replacementId]);
        await client.query(
          `INSERT INTO alpha_refresh_tokens
           (id, family_id, account_id, installation_record_id, token_hash, parent_token_id, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
          [replacementId, token.family_id, account.id, token.installation_record_id,
            digest(replacement), token.id, expiresAt]);
        await client.query(
          `INSERT INTO alpha_sessions (token_hash, account_id, expires_at, family_id)
           VALUES ($1, $2, $3, $4)`,
          [digest(accessToken), account.id, new Date(now() + SESSION_TTL_MS), token.family_id]);
        return { status: 200, body: { accessToken, expiresIn: SESSION_TTL_MS / 1000,
          refreshToken: replacement, refreshTokenExpiresAt: expiresAt.toISOString() } };
      });
    },
    async refreshLogout({ refreshToken } = {}) {
      if (typeof refreshToken !== 'string' || !REFRESH_TOKEN.test(refreshToken)) return UNAUTHORIZED;
      return transaction(async client => {
        const candidate = (await client.query(
          'SELECT account_id FROM alpha_refresh_tokens WHERE token_hash = $1',
          [digest(refreshToken)])).rows[0];
        if (!candidate) return { status: 204, body: null };
        await client.query('SELECT id FROM alpha_accounts WHERE id = $1 FOR UPDATE', [candidate.account_id]);
        const token = (await client.query(
          'SELECT family_id FROM alpha_refresh_tokens WHERE token_hash = $1 FOR UPDATE',
          [digest(refreshToken)])).rows[0];
        if (token) await revokeFamily(client, token.family_id, 'LOGOUT');
        return { status: 204, body: null };
      });
    },
    async reauthenticate(token, { password } = {}) {
      if (!/^[a-f0-9]{64}$/.test(token ?? '') || typeof password !== 'string')
        return UNAUTHORIZED;
      return transaction(async client => {
        const account = (await client.query(
          `SELECT a.id, a.password_hash FROM alpha_sessions s
           JOIN alpha_accounts a ON a.id = s.account_id
           WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL
           FOR UPDATE OF a`, [digest(token), date()]
        )).rows[0];
        if (!account) return UNAUTHORIZED;
        if (!await limit(client, 'reauth', account.id, 5, 15 * 60_000)) return LIMITED;
        return await passwordMatches(password, account.password_hash)
          ? { status: 204, body: null } : UNAUTHORIZED;
      });
    },
    async changePassword(token, { currentPassword, newPassword } = {}) {
      if (!/^[a-f0-9]{64}$/.test(token ?? '')) return UNAUTHORIZED;
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' ||
          newPassword.length < 8 || newPassword.length > 256 ||
          currentPassword === newPassword) return { status: 400,
            body: { message: 'Invalid password change request.' } };
      return transaction(async client => {
        const tokenHash = digest(token);
        const account = (await client.query(
          `SELECT a.id, a.password_hash FROM alpha_sessions s
           JOIN alpha_accounts a ON a.id = s.account_id
           WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL
           FOR UPDATE OF a`, [tokenHash, date()]
        )).rows[0];
        if (!account) return UNAUTHORIZED;
        if (!await limit(client, 'reauth', account.id, 5, 15 * 60_000)) return LIMITED;
        if (!await passwordMatches(currentPassword, account.password_hash)) return UNAUTHORIZED;
        const nextHash = await passwordHash(newPassword);
        await client.query('UPDATE alpha_accounts SET password_hash = $2 WHERE id = $1',
          [account.id, nextHash]);
        await client.query('DELETE FROM alpha_sessions WHERE account_id = $1 AND token_hash <> $2',
          [account.id, tokenHash]);
        await client.query(
          `UPDATE alpha_refresh_tokens SET status = 'REVOKED', revoked_at = $2,
           revocation_reason = 'PASSWORD_CHANGED' WHERE account_id = $1 AND status <> 'REVOKED'`,
          [account.id, date()]);
        return { status: 204, body: null };
      });
    },
    async me(token) {
      if (!/^[a-f0-9]{64}$/.test(token ?? '')) return UNAUTHORIZED;
      const account = (await pool.query(
        `SELECT a.id, a.email_normalized FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
         WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`, [digest(token), date()]
      )).rows[0];
      return account ? { status: 200, body: { id: account.id, email: account.email_normalized } } : UNAUTHORIZED;
    },
    async logout(token) {
      if (!/^[a-f0-9]{64}$/.test(token ?? '')) return UNAUTHORIZED;
      return transaction(async client => {
        const candidate = (await client.query(
          'SELECT account_id FROM alpha_sessions WHERE token_hash = $1', [digest(token)])).rows[0];
        if (!candidate) return UNAUTHORIZED;
        await client.query('SELECT id FROM alpha_accounts WHERE id = $1 FOR UPDATE', [candidate.account_id]);
        const deleted = await client.query(
          'DELETE FROM alpha_sessions WHERE token_hash = $1 RETURNING family_id', [digest(token)]);
        if (!deleted.rowCount) return UNAUTHORIZED;
        if (deleted.rows[0].family_id) await revokeFamily(client, deleted.rows[0].family_id, 'LOGOUT');
        return { status: 204, body: null };
      });
    }
  };
}
