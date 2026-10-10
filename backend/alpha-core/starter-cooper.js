import { createHash, randomInt, randomUUID } from 'node:crypto';
import { generateCooperInitial } from './cooper-generation.js';
const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };

function present(row, selection) {
  const equipped = selection.ring_kind === 'COOPER' && selection.ring_id === row.ring_id;
  return { id: row.ring_id, ringKind: 'COPPER', status: 'ACTIVE',
    level: row.current_level, shine: row.current_shine,
    attributes: { comfort: row.current_comfort, charm: row.current_charm,
      quality: row.current_quality, luck: row.current_luck },
    unspentAttributePoints: row.unspent_attribute_points,
    visualVariantCode: row.visual_variant_code, visualSetVersion: row.visual_set_version,
    rulesetVersion: 'copper-rules-v1', equipped,
    createdAt: row.created_at, equippedAt: equipped ? selection.equipped_at : null,
    updatedAt: row.updated_at };
}

async function currentRow(client, accountId) {
  const row = (await client.query(`SELECT s.*, p.level AS current_level,
      p.shine AS current_shine, p.comfort AS current_comfort,
      p.charm AS current_charm, p.quality AS current_quality,
      p.luck AS current_luck, p.unspent_attribute_points, p.updated_at
    FROM alpha_starter_cooper s
    LEFT JOIN alpha_cooper_current_state p
      ON p.account_id = s.account_id AND p.ring_id = s.ring_id
    WHERE s.account_id = $1`, [accountId])).rows[0] ?? null;
  if (row && (row.current_level === null || row.unspent_attribute_points === null))
    throw new Error('Cooper current state missing');
  return row;
}

async function ownedCooperRows(client, accountId, selection, starterRow) {
  const draws = (await client.query(`SELECT d.ring_id::text AS ring_id,
      d.visual_variant_code, d.visual_set_version, d.created_at,
      p.level AS current_level, p.shine AS current_shine,
      p.comfort AS current_comfort, p.charm AS current_charm,
      p.quality AS current_quality, p.luck AS current_luck,
      p.unspent_attribute_points, p.updated_at
    FROM alpha_draw_cooper_rings d JOIN alpha_cooper_current_state p
      ON p.account_id = d.account_id AND p.ring_id = d.ring_id
    WHERE d.account_id = $1 ORDER BY d.created_at, d.ring_id`,
  [accountId])).rows;
  const grants = (await client.query(`SELECT g.ring_id::text AS ring_id,
      g.visual_variant_code, g.visual_set_version, g.created_at,
      p.level AS current_level, p.shine AS current_shine,
      p.comfort AS current_comfort, p.charm AS current_charm,
      p.quality AS current_quality, p.luck AS current_luck,
      p.unspent_attribute_points, p.updated_at
    FROM alpha_admin_cooper_rings g JOIN alpha_cooper_current_state p
      ON p.account_id = g.account_id AND p.ring_id = g.ring_id
    WHERE g.account_id = $1 ORDER BY g.created_at, g.ring_id`,
  [accountId])).rows;
  return [present(starterRow, selection), ...draws.map(row => present(row, selection)),
    ...grants.map(row => present(row, selection))];
}

export function createStarterCooper({ pool, walletEnvironment, now = () => new Date(),
  sample = randomInt }) {
  if (!pool || !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? ''))
    throw new Error('Starter Cooper requires isolated Alpha PostgreSQL and wallet environment');

  async function account(client, token, lock) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const digest = createHash('sha256').update(token, 'ascii').digest('hex');
    const query = `SELECT a.id, b.wallet_address, b.environment
      FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
      LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL
      ${lock ? 'FOR UPDATE OF a' : ''}`;
    return (await client.query(query, [digest, now()])).rows[0] ?? null;
  }

  async function ensureForAccount(client, accountId) {
    let row = (await client.query('SELECT * FROM alpha_starter_cooper WHERE account_id = $1',
      [accountId])).rows[0];
    if (!row) {
      const initial = generateCooperInitial(sample);
      row = (await client.query(`INSERT INTO alpha_starter_cooper
        (account_id, ring_id, audit_id, visual_variant_code,
         comfort, charm, quality, luck) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`, [accountId, randomUUID(), randomUUID(), initial.visualVariantCode,
          initial.comfort, initial.charm, initial.quality, initial.luck])).rows[0];
    }
    const initial = await client.query(`INSERT INTO alpha_ring_selection
      (account_id, ring_kind, ring_id, equipped_at, updated_at)
      VALUES ($1, 'COOPER', $2, $3, $3) ON CONFLICT (account_id) DO NOTHING`,
    [accountId, row.ring_id, row.equipped_at]);
    if (initial.rowCount === 1) await client.query(`INSERT INTO alpha_ring_equipment_events
      (id, account_id, operation_key, event_type, current_kind, current_id, reason, created_at)
      VALUES ($1,$2,'initial-starter','INITIAL','COOPER',$3,'STARTER_CLAIM',$4)`,
    [row.audit_id, accountId, row.ring_id, row.equipped_at]);
    const selection = (await client.query(
      'SELECT ring_kind, ring_id, equipped_at FROM alpha_ring_selection WHERE account_id = $1',
      [accountId])).rows[0];
    if (!selection) throw new Error('Starter Cooper selection missing');
    return present(await currentRow(client, accountId), selection);
  }

  return {
    ensureForAccount,
    async claim(token) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const user = await account(client, token, true);
        if (!user) { await client.query('ROLLBACK'); return UNAUTHORIZED; }
        const ring = await ensureForAccount(client, user.id);
        const selection = (await client.query(`SELECT ring_kind, ring_id, equipped_at
          FROM alpha_ring_selection WHERE account_id = $1`, [user.id])).rows[0];
        const rings = await ownedCooperRows(client, user.id, selection,
          await currentRow(client, user.id));
        await client.query('COMMIT');
        return { status: 200, body: { ring, rings,
          walletBound: !!user.wallet_address && user.environment === walletEnvironment } };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async inventory(token) {
      const user = await account(pool, token, false);
      if (!user) return UNAUTHORIZED;
      const row = await currentRow(pool, user.id);
      if (!row) return { status: 200, body: { ring: null } };
      const selection = (await pool.query(
        'SELECT ring_kind, ring_id, equipped_at FROM alpha_ring_selection WHERE account_id = $1',
        [user.id])).rows[0];
      if (!selection) return { status: 409, body: { code: 'RING_SELECTION_MISSING' } };
      return { status: 200, body: { ring: present(row, selection),
        rings: await ownedCooperRows(pool, user.id, selection, row) } };
    }
  };
}
