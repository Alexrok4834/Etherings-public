import { createHash, randomUUID } from 'node:crypto';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from './m2e-ert-decimal.js';
import { generateCooperInitial } from './cooper-generation.js';
import { selectDrawReward } from './draw-selection.js';
import { BOX_URI, BOX_HASH } from './silver-issuer-chain.js';

// Alpha port of MVP Raffle v2's versioned configuration, owner-scoped replay,
// one-shot integer selection and immutable result/history. Chain rewards are
// deliberately persisted as pending, never substituted with another outcome.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER = Object.freeze(['ERT', 'ERU', 'COPPER_RING', 'SILVER_BOX']);
const AMOUNTS = Object.freeze({ ERT: '10', ERU: '5', COPPER_RING: null, SILVER_BOX: null });
const TITLES = Object.freeze({ ERT: '10 ERT', ERU: '5 ERU',
  COPPER_RING: 'Cooper Ring', SILVER_BOX: 'Silver Box' });
const INVALID = { status: 400, body: { code: 'INVALID_DRAW_REQUEST' } };
const UNAVAILABLE = { status: 409, body: { code: 'DRAW_UNAVAILABLE' } };
const STALE = { status: 409, body: { code: 'DRAW_CONFIGURATION_STALE' } };
const CONFLICT = { status: 409, body: { code: 'DRAW_IDEMPOTENCY_CONFLICT' } };
const LIMIT = { status: 409, body: { code: 'DRAW_DAILY_LIMIT' } };
const BALANCE = { status: 409, body: { code: 'INSUFFICIENT_ERT' } };

function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).sort().join(',') === [...keys].sort().join(',');
}
function fingerprint(accountId, configId) {
  return createHash('sha256').update(JSON.stringify({ contractVersion: 'raffle-v2',
    ownerUserId: accountId, configurationVersion: configId }), 'utf8').digest('hex');
}
function json(value) { return JSON.parse(JSON.stringify(value)); }
function utcDay(date) { return date.toISOString().slice(0, 10); }
function nextMidnight(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
}
function rewardView(row, totalWeight, segmentIndex = row.segment_index) {
  const snapshot = row.reward_snapshot;
  return { rewardId: row.reward_id, code: snapshot.code, title: snapshot.title,
    type: row.reward_type, segmentIndex,
    weight: String(row.weight), probability: {
      numerator: String(row.weight), denominator: String(totalWeight) },
    imageUrl: snapshot.imageUrl ?? null,
    ...(row.reward_type === 'SILVER_BOX' ? { media: snapshot.media } : {}),
    ...(row.amount_exact === null ? { asset: snapshot.asset } : {
      amountExact: canonicalErt(row.amount_exact),
      amountDisplay: row.reward_type === 'ERT' ? displayErt(row.amount_exact) : '5.00' }) };
}

export function createAlphaDraw({ pool, auth, walletEnvironment, now = () => new Date(),
  sampleCooper, nextInt }) {
  if (!pool || !auth || typeof auth.me !== 'function' || !walletEnvironment)
    throw new Error('Draw requires Alpha database, auth and wallet environment');

  async function owner(token) {
    const session = await auth.me(token);
    return session.status === 200 ? { id: session.body.id, session } : { error: session };
  }
  async function configuration(client, lock = false) {
    return (await client.query(`SELECT * FROM alpha_draw_configurations
      WHERE status = 'ACTIVE' ${lock ? 'FOR UPDATE' : ''}`)).rows[0] ?? null;
  }
  async function rewards(client, id) {
    return (await client.query(`SELECT reward_id, reward_type, segment_index, weight,
      amount_exact::text AS amount_exact, reward_snapshot
      FROM alpha_draw_configuration_rewards WHERE configuration_id = $1
      ORDER BY segment_index`, [id])).rows;
  }
  function validRewards(rows) {
    return rows.length === 4 && rows.every((row, i) => row.segment_index === i &&
      row.reward_type === ORDER[i] && Number.isSafeInteger(row.weight) && row.weight > 0 &&
      (row.amount_exact === null ? null : canonicalErt(row.amount_exact)) ===
        AMOUNTS[row.reward_type] &&
      row.reward_snapshot?.type === row.reward_type &&
      row.reward_snapshot?.rewardId === row.reward_id &&
      row.reward_snapshot?.segmentIndex === i &&
      row.reward_snapshot?.weight === String(row.weight));
  }
  async function attempts(client, id, day) {
    return Number((await client.query(`SELECT count(*)::int AS used
      FROM alpha_draw_operations WHERE account_id = $1 AND utc_day = $2`,
    [id, day])).rows[0].used);
  }
  async function existing(client, accountId, key) {
    return (await client.query(`SELECT o.*, r.id AS result_id, r.result_snapshot,
      f.state AS fulfillment_state, f.chain_signature, f.chain_asset_address
      FROM alpha_draw_operations o
      JOIN alpha_draw_results r ON r.operation_id = o.id
      JOIN alpha_draw_fulfillments f ON f.result_id = r.id
      WHERE o.account_id = $1 AND o.idempotency_key = $2`,
    [accountId, key])).rows[0] ?? null;
  }
  function resultResponse(row, replayed) {
    return { ...json(row.result_snapshot), operation: {
      ...row.result_snapshot.operation, replayed },
      fulfillment: { ...row.result_snapshot.fulfillment,
        state: row.fulfillment_state,
        ...(row.chain_signature ? { signature: row.chain_signature } : {}),
        ...(row.chain_asset_address ? { assetAddress: row.chain_asset_address } : {}) } };
  }

  return {
    async current(token) {
      const context = await owner(token);
      if (context.error) return context.error;
      const config = await configuration(pool);
      if (!config) return UNAVAILABLE;
      const rows = await rewards(pool, config.id);
      if (!validRewards(rows)) return UNAVAILABLE;
      const day = utcDay(now());
      const used = await attempts(pool, context.id, day);
      const cooperToday = (await pool.query(`SELECT 1 FROM alpha_draw_results r
        JOIN alpha_draw_operations o ON o.id = r.operation_id
        WHERE r.account_id = $1 AND o.utc_day = $2
          AND r.selected_reward_type = 'COPPER_RING' LIMIT 1`,
      [context.id, day])).rowCount > 0;
      const eligible = rows.filter(row => row.reward_type !== 'COPPER_RING' || !cooperToday);
      const totalWeight = eligible.reduce((sum, row) => sum + row.weight, 0);
      return { status: 200, body: { contractVersion: 'raffle-v2',
        serverTime: now().toISOString(), draw: { drawId: config.id,
          configurationVersion: config.id, title: config.title, description: null,
          cost: { currency: 'ERT', amountExact: canonicalErt(config.cost_ert),
            amountDisplay: displayErt(config.cost_ert) },
          attempts: { limit: config.daily_user_attempt_limit,
            used: Math.min(used, config.daily_user_attempt_limit),
            remaining: Math.max(0, config.daily_user_attempt_limit - used),
            day, resetsAt: nextMidnight(day) }, totalWeight: String(totalWeight),
          rewards: eligible.map((row, index) => rewardView(row, totalWeight, index)),
          displayRewards: rows.map(row => ({ ...rewardView(row, totalWeight),
            eligible: row.reward_type !== 'COPPER_RING' || !cooperToday,
            probability: { numerator: row.reward_type === 'COPPER_RING' && cooperToday
              ? '0' : String(row.weight), denominator: String(totalWeight) } })) } } };
    },

    async history(token) {
      const context = await owner(token);
      if (context.error) return context.error;
      const rows = (await pool.query(`SELECT r.id AS result_id, r.created_at,
        r.result_snapshot, f.state AS fulfillment_state, f.chain_signature,
        f.chain_asset_address
        FROM alpha_draw_results r JOIN alpha_draw_fulfillments f ON f.result_id = r.id
        WHERE r.account_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`,
      [context.id])).rows;
      return { status: 200, body: { contractVersion: 'raffle-v2',
        items: rows.map(row => resultResponse(row, true)), nextCursor: null } };
    },

    async submit(token, body) {
      const context = await owner(token);
      if (context.error) return context.error;
      if (!exactKeys(body, ['contractVersion', 'configurationVersion', 'idempotencyKey']) ||
          body.contractVersion !== 'raffle-v2' ||
          !UUID.test(body.configurationVersion) || !UUID.test(body.idempotencyKey)) return INVALID;
      const configId = body.configurationVersion.toLowerCase();
      const key = body.idempotencyKey.toLowerCase();
      const digest = fingerprint(context.id, configId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT a.id, b.wallet_address, b.environment
          FROM alpha_accounts a LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
          WHERE a.id = $1 AND a.verified_at IS NOT NULL FOR UPDATE OF a`,
        [context.id])).rows[0];
        if (!account || !account.wallet_address || account.environment !== walletEnvironment) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        const prior = await existing(client, context.id, key);
        if (prior) {
          await client.query('COMMIT');
          return prior.request_fingerprint === digest
            ? { status: 200, body: resultResponse(prior, true) } : CONFLICT;
        }
        const config = await configuration(client, true);
        if (!config) { await client.query('ROLLBACK'); return UNAVAILABLE; }
        if (config.id !== configId) { await client.query('ROLLBACK'); return STALE; }
        const rows = await rewards(client, config.id);
        if (!validRewards(rows)) { await client.query('ROLLBACK'); return UNAVAILABLE; }
        const day = utcDay(now());
        const used = await attempts(client, account.id, day);
        if (used >= config.daily_user_attempt_limit) {
          await client.query('ROLLBACK'); return LIMIT;
        }
        const selectedRing = (await client.query(`SELECT ring_id FROM alpha_ring_selection
          WHERE account_id = $1`, [account.id])).rows[0];
        if (!selectedRing) { await client.query('ROLLBACK'); return UNAVAILABLE; }
        const balance = (await client.query(`SELECT available::text AS available
          FROM alpha_ert_available WHERE account_id = $1`, [account.id])).rows[0];
        if (!balance || parseUnsignedErtDecimal(balance.available, 'available')
          .lessThan(parseUnsignedErtDecimal(config.cost_ert, 'cost', false))) {
          await client.query('ROLLBACK'); return BALANCE;
        }
        const cooperToday = (await client.query(`SELECT 1 FROM alpha_draw_results r
          JOIN alpha_draw_operations o ON o.id = r.operation_id
          WHERE r.account_id = $1 AND o.utc_day = $2
            AND r.selected_reward_type = 'COPPER_RING' LIMIT 1`,
        [account.id, day])).rowCount > 0;
        const eligible = rows.filter(row => row.reward_type !== 'COPPER_RING' || !cooperToday);
        const selection = selectDrawReward(eligible.map((row, index) => ({
          rewardId: row.reward_id, segmentIndex: index,
          weight: row.weight, rewardSnapshot: { ...row.reward_snapshot, segmentIndex: index },
        })), nextInt);
        const selected = rows.find(row => row.reward_id === selection.selectedRewardId);
        const operationId = randomUUID();
        const resultId = randomUUID();
        const debitId = randomUUID();
        await client.query(`INSERT INTO alpha_draw_operations
          (id, account_id, idempotency_key, request_fingerprint, configuration_id,
           wallet_address, utc_day) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [operationId, account.id, key, digest, config.id, account.wallet_address, day]);
        await client.query(`INSERT INTO alpha_ert_ledger
          (id, account_id, event_key, amount) VALUES ($1,$2,$3,$4::numeric)`,
        [debitId, account.id, `draw-entry:${operationId}`, `-${canonicalErt(config.cost_ert)}`]);
        let fulfillment;
        if (selected.reward_type === 'ERT') {
          const creditId = randomUUID();
          await client.query(`INSERT INTO alpha_ert_ledger
            (id, account_id, event_key, amount) VALUES ($1,$2,$3,$4::numeric)`,
          [creditId, account.id, `draw-reward:${resultId}`, '10']);
          const balanceAfter = (await client.query(`SELECT balance::text AS balance
            FROM alpha_ert_available WHERE account_id = $1`, [account.id])).rows[0].balance;
          fulfillment = { type: 'ERT_CREDIT', state: 'CONFIRMED', ledgerId: creditId,
            ledgerTransactionId: creditId,
            balanceAfterExact: canonicalErt(balanceAfter),
            balanceAfterDisplay: displayErt(balanceAfter) };
        } else if (selected.reward_type === 'COPPER_RING') {
          const ringId = randomUUID();
          const ringEventId = randomUUID();
          const initial = generateCooperInitial(sampleCooper);
          fulfillment = { type: 'RING_AWARD', state: 'CONFIRMED', ringId, ringEventId,
            equipped: false, ring: { id: ringId,
              entitlementCode: `raffle-copper-v1:${resultId}`,
              kind: 'COPPER', level: 1, shine: 100,
              comfort: initial.comfort, charm: initial.charm,
              quality: initial.quality, luck: initial.luck,
              unspentAttributePoints: 0, equipped: false,
              visualVariantCode: initial.visualVariantCode } };
          // Insert after the immutable result exists (FK), below.
          fulfillment.initial = initial;
        } else {
          fulfillment = { type: selected.reward_type === 'ERU' ?
            'ERU_PAYOUT' : 'SILVER_BOX_ISSUANCE', state: 'PENDING' };
        }
        const response = { contractVersion: 'raffle-v2', operation: {
          operationId, idempotencyKey: key, status: 'COMPLETED', replayed: false },
          draw: { drawId: config.id, drawResultId: resultId,
            configurationVersion: config.id, createdAt: now().toISOString(),
            cost: { currency: 'ERT', amountExact: canonicalErt(config.cost_ert),
              amountDisplay: displayErt(config.cost_ert), ledgerTransactionId: debitId },
            attempts: { limit: config.daily_user_attempt_limit, used: used + 1,
              remaining: config.daily_user_attempt_limit - used - 1,
              day, resetsAt: nextMidnight(day) } },
          selection: { algorithm: selection.algorithm, ticket: String(selection.ticket),
            totalWeight: String(selection.totalWeight),
            selectedSegmentIndex: selection.selectedSegmentIndex,
            ranges: selection.ranges.map(range => ({ segmentIndex: range.segmentIndex,
              rewardId: range.rewardId, weight: String(range.weight),
              startInclusive: String(range.startInclusive),
              endExclusive: String(range.endExclusive) })) },
          reward: rewardView(selected, selection.totalWeight,
            selection.selectedSegmentIndex),
          fulfillment: Object.fromEntries(Object.entries(fulfillment)
            .filter(([field]) => field !== 'initial')) };
        await client.query(`INSERT INTO alpha_draw_results
          (id, operation_id, account_id, configuration_id, selected_reward_id,
           selected_reward_type, selected_segment_index, algorithm, ticket,
           total_weight, ranges_snapshot, result_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [resultId, operationId, account.id, config.id, selected.reward_id,
          selected.reward_type, selection.selectedSegmentIndex, selection.algorithm,
          selection.ticket, selection.totalWeight, JSON.stringify(selection.ranges),
          JSON.stringify(response)]);
        if (fulfillment.initial) {
          const i = fulfillment.initial;
          await client.query(`INSERT INTO alpha_draw_cooper_rings
            (ring_id, result_id, account_id, visual_variant_code,
             comfort, charm, quality, luck)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [fulfillment.ringId, resultId, account.id, i.visualVariantCode,
            i.comfort, i.charm, i.quality, i.luck]);
          await client.query(`INSERT INTO alpha_cooper_current_state
            (account_id, ring_id, level, shine, comfort, charm, quality, luck)
            VALUES ($1,$2,1,100,$3,$4,$5,$6)`,
          [account.id, fulfillment.ringId,
            i.comfort, i.charm, i.quality, i.luck]);
          await client.query(`INSERT INTO alpha_draw_cooper_events
            (id, ring_id, result_id, account_id, event_type, snapshot)
            VALUES ($1,$2,$3,$4,'RAFFLE_AWARDED',$5::jsonb)`,
          [fulfillment.ringEventId, fulfillment.ringId, resultId, account.id,
            JSON.stringify({ operationId, resultId, ringId: fulfillment.ringId,
              entitlementCode: fulfillment.ring.entitlementCode, initial: i })]);
        }
        await client.query(`INSERT INTO alpha_draw_fulfillments
          (result_id, reward_type, state, ledger_id, cooper_ring_id)
          VALUES ($1,$2,$3,$4,$5)`, [resultId, selected.reward_type,
          fulfillment.state, fulfillment.ledgerId ?? null, fulfillment.ringId ?? null]);
        await client.query('COMMIT');
        return { status: 200, body: response };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async adminConfigurations(token) {
      const context = await owner(token);
      if (context.error) return context.error;
      const admin = (await pool.query(`SELECT is_admin FROM alpha_accounts
        WHERE id = $1 AND verified_at IS NOT NULL`, [context.id])).rows[0];
      if (!admin?.is_admin)
        return { status: 403, body: { code: 'ADMIN_REQUIRED' } };
      const rows = (await pool.query(`SELECT c.id, c.status,
        c.daily_user_attempt_limit, c.cost_ert::text AS cost_ert,
        c.created_at, c.activated_at,
        r.reward_type, r.weight
        FROM alpha_draw_configurations c
        JOIN alpha_draw_configuration_rewards r ON r.configuration_id = c.id
        ORDER BY c.created_at DESC, r.segment_index LIMIT 80`)).rows;
      const configs = new Map();
      for (const row of rows) {
        let config = configs.get(row.id);
        if (!config) {
          config = { configurationVersion: row.id, status: row.status,
            costErtExact: row.cost_ert,
            dailyAttemptLimit: row.daily_user_attempt_limit,
            createdAt: new Date(row.created_at).toISOString(),
            activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
            weights: {} };
          configs.set(row.id, config);
        }
        config.weights[row.reward_type] = row.weight;
      }
      return { status: 200, body: { configurations: [...configs.values()] } };
    },
    async createDraft(token, body) {
      const context = await owner(token);
      if (context.error) return context.error;
      if (!exactKeys(body, ['configurationVersion', 'dailyAttemptLimit', 'weights']) ||
          !UUID.test(body.configurationVersion) ||
          !Number.isInteger(body.dailyAttemptLimit) ||
          body.dailyAttemptLimit < 1 || body.dailyAttemptLimit > 32767 ||
          !exactKeys(body.weights, ORDER) ||
          !ORDER.every(type => Number.isSafeInteger(body.weights[type]) &&
            body.weights[type] > 0) ||
          ORDER.reduce((sum, type) => sum + body.weights[type], 0) > 2_147_483_647)
        return INVALID;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const admin = (await client.query(`SELECT is_admin FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [context.id])).rows[0];
        if (!admin?.is_admin) { await client.query('ROLLBACK');
          return { status: 403, body: { code: 'ADMIN_REQUIRED' } }; }
        const id = body.configurationVersion.toLowerCase();
        const existing = (await client.query(`SELECT id FROM alpha_draw_configurations
          WHERE id = $1`, [id])).rows[0];
        if (existing) { await client.query('ROLLBACK'); return CONFLICT; }
        await client.query(`INSERT INTO alpha_draw_configurations
          (id, status, title, cost_ert, daily_user_attempt_limit, created_by_account_id)
          VALUES ($1,'DRAFT','Draw',5,$2,$3)`, [id, body.dailyAttemptLimit, context.id]);
        for (const [index, type] of ORDER.entries()) {
          const rewardId = randomUUID();
          const snapshot = { rewardId, segmentIndex: index,
            weight: String(body.weights[type]), type, code: type,
            title: TITLES[type], amountExact: AMOUNTS[type], imageUrl: null,
            ...(AMOUNTS[type] === null ? { asset: type === 'COPPER_RING' ?
              { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 } :
              { kind: 'SILVER_BOX', quantity: 1 } } : {}),
            ...(type === 'SILVER_BOX' ? { media: {
              uri: BOX_URI, contentHash: BOX_HASH } } : {}) };
          await client.query(`INSERT INTO alpha_draw_configuration_rewards
            (configuration_id, reward_id, segment_index, reward_type,
             weight, amount_exact, reward_snapshot)
            VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::jsonb)`,
          [id, rewardId, index, type, body.weights[type], AMOUNTS[type],
            JSON.stringify(snapshot)]);
        }
        await client.query('COMMIT');
        return { status: 200, body: { configurationVersion: id,
          status: 'DRAFT', weights: body.weights, costErtExact: '5',
          dailyAttemptLimit: body.dailyAttemptLimit } };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },

    async activate(token, body) {
      const context = await owner(token);
      if (context.error) return context.error;
      if (!exactKeys(body, ['configurationVersion']) ||
          !UUID.test(body.configurationVersion)) return INVALID;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const admin = (await client.query(`SELECT is_admin FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [context.id])).rows[0];
        if (!admin?.is_admin) { await client.query('ROLLBACK');
          return { status: 403, body: { code: 'ADMIN_REQUIRED' } }; }
        const id = body.configurationVersion.toLowerCase();
        const draft = (await client.query(`SELECT * FROM alpha_draw_configurations
          WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!draft || draft.status !== 'DRAFT' ||
            !validRewards(await rewards(client, id))) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        await client.query(`UPDATE alpha_draw_configurations
          SET status = 'DISABLED', disabled_at = now() WHERE status = 'ACTIVE'`);
        await client.query(`UPDATE alpha_draw_configurations
          SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [id]);
        await client.query('COMMIT');
        return { status: 200, body: { configurationVersion: id, status: 'ACTIVE' } };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  };
}
