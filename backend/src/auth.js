import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_N = 1 << 17;
const PASSWORD_MAXMEM = 256 * 1024 * 1024;
const CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
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

export function createAuth({ pool, mailer, codeSecret, now = () => Date.now() }) {
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
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    await client.query(
      `INSERT INTO alpha_email_challenges (account_id, code_hash, expires_at, attempts, sent_at)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (account_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
      [account.id, codeDigest(codeSecret, account.id, code), new Date(now() + CODE_TTL_MS), date()]
    );
    await mailer.sendVerification(email, code);
  }
  return {
    async register({ email: input, password }) {
      const email = normalizeEmail(input);
      if (!email || typeof password !== 'string' || password.length < 12 || password.length > 256) {
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
    async verify({ email: input, code }) {
      const email = normalizeEmail(input);
      if (!email || typeof code !== 'string' || !/^\d{8}$/.test(code)) return INVALID;
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
        const token = randomBytes(32).toString('hex');
        await client.query('INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
          [digest(token), account.id, new Date(now() + SESSION_TTL_MS)]);
        return { status: 200, body: { accessToken: token, expiresIn: SESSION_TTL_MS / 1000 } };
      });
    },
    async login({ email: input, password }) {
      const email = normalizeEmail(input);
      if (!email || typeof password !== 'string') return UNAUTHORIZED;
      const account = (await pool.query('SELECT id, password_hash, verified_at FROM alpha_accounts WHERE email_normalized = $1', [email])).rows[0];
      const dummy = 'scrypt:131072:8:1:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
      const matches = await passwordMatches(password, account?.password_hash ?? dummy);
      if (!account?.verified_at || !matches) return UNAUTHORIZED;
      const token = randomBytes(32).toString('hex');
      await pool.query('INSERT INTO alpha_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
        [digest(token), account.id, new Date(now() + SESSION_TTL_MS)]);
      return { status: 200, body: { accessToken: token, expiresIn: SESSION_TTL_MS / 1000 } };
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
      const deleted = await pool.query('DELETE FROM alpha_sessions WHERE token_hash = $1 RETURNING token_hash', [digest(token)]);
      return deleted.rowCount ? { status: 204, body: null } : UNAUTHORIZED;
    }
  };
}
