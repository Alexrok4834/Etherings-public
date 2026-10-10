import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import { createRingEquipment } from '../src/ring-equipment.js';
import { createStarterCooper } from '../src/starter-cooper.js';
import { createAlphaServer } from '../src/server.js';

const databaseUrl = process.env.ALPHA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ALPHA_TEST_DATABASE_URL must point to disposable Alpha PostgreSQL');
const mint = () => bs58.encode(randomBytes(32));
const key = (kind, id) => ({ kind, id });
const request = (target, expectedCurrent, expectedVersion, idempotencyKey = randomUUID()) => ({
  contractVersion: 'alpha-ring-equipment-v1', target, expectedCurrent,
  expectedVersion, idempotencyKey,
});

test('mixed Equip backfill, replay, one-winner, confirmed fallback and UNKNOWN are account-scoped',
  async () => {
    const schema = 'alpha_equip_test_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: databaseUrl, max: 8,
        options: `-c search_path=${schema}` });
      for (const file of ['001_alpha_auth.sql', '002_alpha_wallet_binding.sql',
        '013_alpha_starter_cooper.sql', '019_alpha_cooper_current_state.sql',
        '016_alpha_m2e_daily_accounting.sql', '034_alpha_m2e_comfort_epochs.sql'])
        await pool.query(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
      // Equipment's current Cooper read also references the later Draw source.
      // This fixture exercises only starter ownership, so keep that read shape.
      await pool.query(`CREATE TABLE alpha_draw_cooper_rings (
        ring_id uuid PRIMARY KEY, account_id uuid NOT NULL,
        visual_variant_code text, visual_set_version integer,
        created_at timestamptz DEFAULT now())`);
      await pool.query(`CREATE TABLE alpha_admin_cooper_rings (
        ring_id uuid PRIMARY KEY, account_id uuid NOT NULL,
        visual_variant_code text, visual_set_version integer,
        created_at timestamptz DEFAULT now())`);
      const accountId = randomUUID();
      const starterId = randomUUID();
      const starterAuditId = randomUUID();
      const token = randomBytes(32).toString('hex');
      const wallet = mint();
      await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
        VALUES ($1,'equip@example.invalid','synthetic',now())`, [accountId]);
      await pool.query(`INSERT INTO alpha_sessions (token_hash,account_id,expires_at)
        VALUES ($1,$2,now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest('hex'), accountId]);
      await pool.query(`INSERT INTO alpha_wallet_bindings (account_id,wallet_address,environment)
        VALUES ($1,$2,'alpha-dev')`, [accountId, wallet]);
      await pool.query(`INSERT INTO alpha_starter_cooper
        (account_id,ring_id,audit_id,visual_variant_code,comfort,charm,quality,luck)
        VALUES ($1,$2,$3,'copper_signet',5,6,7,8)`,
      [accountId, starterId, starterAuditId]);
      const up = await readFile(new URL('../schema/015_alpha_ring_equipment.sql', import.meta.url),
        'utf8');
      const down = await readFile(new URL('../schema/rollback/015_alpha_ring_equipment.sql',
        import.meta.url), 'utf8');
      await pool.query(up);
      assert.deepEqual((await pool.query(`SELECT ring_kind,ring_id,version::text AS version
        FROM alpha_ring_selection WHERE account_id = $1`, [accountId])).rows[0],
      { ring_kind: 'COOPER', ring_id: starterId, version: '1' });
      assert.equal((await pool.query(`SELECT id FROM alpha_ring_equipment_events
        WHERE account_id = $1`, [accountId])).rows[0].id, starterAuditId);
      await pool.query(down);
      assert.equal((await pool.query(`SELECT to_regclass('alpha_ring_selection') AS name`))
        .rows[0].name, null);
      await pool.query(up);
      await assert.rejects(() => pool.query(`UPDATE alpha_ring_selection
        SET ring_id = $2 WHERE account_id = $1`, [accountId, randomUUID()]),
      /not owned/);

      const silverA = mint();
      const silverB = mint();
      const states = new Map([[silverA, 'ELIGIBLE'], [silverB, 'ELIGIBLE']]);
      const listings = new Set();
      let listingOutage = false;
      const chain = { async readEquipmentEligibility({ walletAddress, mintAddress }) {
        if (walletAddress !== wallet) return { state: 'TRANSFERRED_AWAY' };
        const state = states.get(mintAddress) ?? 'UNKNOWN';
        if (state === 'THROW') throw new Error('synthetic provider outage');
        return state === 'ELIGIBLE' ? { state, ring: { finalized: true,
          kind: 'SILVER_RING', programId, cluster: 'devnet', mintAddress,
          tokenOwner: walletAddress, comfort: 20 } } : { state };
      } };
      const programId = mint();
      const equipment = createRingEquipment({ pool, chain, programId, cluster: 'devnet',
        marketReader: { readListing: async mintAddress => {
          if (listingOutage) throw new Error('synthetic listing provider outage');
          return listings.has(mintAddress) ?
            { mintAddress, kind: 'SILVER_RING', state: 'ACTIVE' } : null;
        } },
        walletEnvironment: 'alpha-dev' });
      const cooper = createStarterCooper({ pool, walletEnvironment: 'alpha-dev' });
      const starter = key('COOPER', starterId);
      const ringA = key('SILVER_RING', silverA);
      const ringB = key('SILVER_RING', silverB);
      assert.equal((await equipment.current(token)).body.selection.id, starterId);
      assert.equal((await cooper.inventory(token)).body.ring.equipped, true);
      assert.equal((await equipment.equip(null, request(ringA, starter, '1'))).status, 401);
      assert.equal((await equipment.equip(token,
        request({ kind: 'SILVER_RING', id: 'not-a-mint' }, starter, '1'))).status, 400);
      const equipA = request(ringA, starter, '1');
      const first = await equipment.equip(token, equipA);
      assert.equal(first.status, 200);
      assert.equal(first.body.version, '2');
      assert.equal((await cooper.inventory(token)).body.ring.equipped, false);
      assert.equal((await equipment.equip(token, equipA)).body.replay, true);
      assert.equal((await equipment.equip(token, { ...equipA, target: ringB })).body.code,
        'RING_EQUIPMENT_IDEMPOTENCY_CONFLICT');
      assert.equal((await equipment.equip(token, request(ringB, starter, '1'))).body.code,
        'RING_EQUIPMENT_STALE');
      states.set(silverA, 'UNKNOWN');
      const unknown = await equipment.current(token);
      assert.equal(unknown.body.eligibility, 'UNKNOWN');
      assert.equal(unknown.body.effectsEnabled, false);
      assert.deepEqual(unknown.body.selection, ringA);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
        WHERE event_type = 'FALLBACK'`)).rows[0].n, 0);
      assert.equal((await equipment.equip(token, request(ringA, ringA, '2'))).status, 503);
      states.set(silverA, 'THROW');
      const providerUnknown = await equipment.current(token);
      assert.deepEqual(providerUnknown.body.selection, ringA);
      assert.equal(providerUnknown.body.effectsEnabled, false);
      states.set(silverA, 'COOLDOWN');
      const fallback = await equipment.current(token);
      assert.equal(fallback.body.fallbackReason, 'COOLDOWN');
      assert.deepEqual(fallback.body.selection, starter);
      assert.equal(fallback.body.version, '3');
      assert.equal((await equipment.current(token)).body.version, '3');
      assert.equal((await equipment.equip(token, request(ringA, starter, '3'))).status, 409);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM alpha_ring_equipment_events
        WHERE event_type = 'FALLBACK'`)).rows[0].n, 1);
      states.set(silverA, 'ELIGIBLE');
      assert.deepEqual((await equipment.current(token)).body.selection, starter);
      assert.equal((await cooper.claim(token)).body.ring.equipped, true);
      assert.equal((await equipment.equip(token, request(ringA, starter, '3'))).status, 200);
      states.set(silverA, 'TRANSFERRED_AWAY');
      assert.equal((await equipment.current(token)).body.fallbackReason, 'TRANSFERRED_AWAY');
      assert.deepEqual((await equipment.current(token)).body.selection, starter);
      states.set(silverA, 'ELIGIBLE');
      const raced = await Promise.all([
        equipment.equip(token, request(ringA, starter, '5')),
        equipment.equip(token, request(ringB, starter, '5')),
      ]);
      assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
      const selected = (await equipment.current(token)).body;
      assert.equal(selected.version, '6');
      assert([silverA, silverB].includes(selected.selection.id));
      const noChange = await equipment.equip(token,
        request(selected.selection, selected.selection, '6'));
      assert.equal(noChange.body.noChange, true);
      assert.equal(noChange.body.version, '6');
      listingOutage = true;
      assert.equal((await equipment.current(token)).body.eligibility, 'UNKNOWN');
      assert.equal((await equipment.current(token)).body.version, '6');
      listingOutage = false;
      listings.add(selected.selection.id);
      const listed = await equipment.current(token);
      assert.equal(listed.body.fallbackReason, 'LISTED');
      assert.deepEqual(listed.body.selection, starter);
      assert.equal((await equipment.current(token)).body.version, '7');
      assert.equal((await equipment.equip(token,
        request(selected.selection, starter, '7'))).body.code,
      'SILVER_RING_LISTED');
      assert.equal((await pool.query(`SELECT count(*)::int AS n
        FROM alpha_ring_equipment_events WHERE reason = 'LISTED'`)).rows[0].n, 1);
      listings.delete(selected.selection.id);
      assert.deepEqual((await equipment.current(token)).body.selection, starter);
      assert.equal((await equipment.equip(token,
        request(selected.selection, starter, '7'))).status, 200);
      assert.equal((await pool.query(`SELECT count(*)::int AS n
        FROM alpha_ring_equipment_operations`)).rows[0].n, 5);
      await assert.rejects(() => pool.query(`UPDATE alpha_ring_equipment_events
        SET reason = 'changed' WHERE account_id = $1`, [accountId]), /immutable/);

      const otherId = randomUUID();
      const otherToken = randomBytes(32).toString('hex');
      await pool.query(`INSERT INTO alpha_accounts (id,email_normalized,password_hash,verified_at)
        VALUES ($1,'other@example.invalid','synthetic',now())`, [otherId]);
      await pool.query(`INSERT INTO alpha_sessions (token_hash,account_id,expires_at)
        VALUES ($1,$2,now() + interval '1 hour')`,
      [createHash('sha256').update(otherToken).digest('hex'), otherId]);
      await pool.query(`INSERT INTO alpha_wallet_bindings (account_id,wallet_address,environment)
        VALUES ($1,$2,'alpha-dev')`, [otherId, mint()]);
      const otherStarter = await cooper.claim(otherToken);
      assert.equal(otherStarter.status, 200);
      assert.equal((await equipment.equip(otherToken,
        request(ringA, key('COOPER', otherStarter.body.ring.id), '1'))).status, 409);
      assert.equal((await equipment.current(otherToken)).body.selection.id,
        otherStarter.body.ring.id);
      await assert.rejects(() => pool.query(down), /history exists/);
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

test('equipment HTTP boundary forwards only explicit GET and POST routes', async () => {
  const equipment = { current: async () => ({ status: 200, body: { selection: 'read' } }),
    equip: async () => ({ status: 200, body: { selection: 'written' } }) };
  const server = createAlphaServer({}, {}, null, null, null, null, null, null,
    async () => {}, equipment);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await fetch(base + '/ring/equipment')).json()).selection, 'read');
    assert.equal((await (await fetch(base + '/ring/equipment/equip', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json()).selection, 'written');
    assert.equal((await fetch(base + '/ring/equipment/equip')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
