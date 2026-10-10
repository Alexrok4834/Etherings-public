import { randomUUID } from 'node:crypto';

const UNKNOWN = 'M2E_COMFORT_EPOCH_UNAVAILABLE';

function unavailable() {
  const error = new Error('Authoritative M2E Comfort epoch unavailable');
  error.code = UNKNOWN;
  return error;
}

function validRing(ring) {
  return ring && ['COOPER', 'SILVER_RING'].includes(ring.kind) &&
    typeof ring.id === 'string' && ring.id.length > 0 &&
    Number.isSafeInteger(ring.comfort) && ring.comfort >= 0;
}

function sameRing(left, right) {
  return left.kind === right.kind && left.id === right.id &&
    left.comfort === right.comfort;
}

// Caller holds the Alpha account lock and writes this in the same transaction
// as an authoritative selection/Comfort mutation.
export async function recordM2eComfortChange(client, { accountId, sourceKey,
  previous = null, current, effectiveAt = new Date(), uncertainStartedAt = effectiveAt }) {
  if (!accountId || !sourceKey || !validRing(current) ||
      (previous !== null && !validRing(previous)) ||
      !(effectiveAt instanceof Date) || Number.isNaN(effectiveAt.getTime()) ||
      !(uncertainStartedAt instanceof Date) ||
      Number.isNaN(uncertainStartedAt.getTime()) ||
      uncertainStartedAt > effectiveAt) throw unavailable();
  if (previous && sameRing(previous, current)) return null;
  const existing = (await client.query(`SELECT * FROM alpha_m2e_comfort_changes
    WHERE account_id = $1 AND source_key = $2`, [accountId, sourceKey])).rows[0];
  const last = (await client.query(`SELECT effective_at FROM alpha_m2e_comfort_changes
    WHERE account_id = $1 ORDER BY effective_at DESC, id DESC LIMIT 1`,
  [accountId])).rows[0];
  let orderedAt = effectiveAt;
  if (!existing && last && new Date(last.effective_at) >= effectiveAt) {
    if (new Date(last.effective_at).getTime() > effectiveAt.getTime() + 1)
      throw unavailable();
    orderedAt = new Date(new Date(last.effective_at).getTime() + 1);
  }
  const id = randomUUID();
  await client.query(`INSERT INTO alpha_m2e_comfort_changes
    (id,account_id,source_key,previous_ring_kind,previous_ring_id,previous_comfort,
     current_ring_kind,current_ring_id,current_comfort,uncertain_started_at,effective_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (account_id,source_key) DO NOTHING`,
  [id, accountId, sourceKey, previous?.kind ?? null, previous?.id ?? null,
    previous?.comfort ?? null, current.kind, current.id, current.comfort,
    uncertainStartedAt, orderedAt]);
  const stored = (await client.query(`SELECT * FROM alpha_m2e_comfort_changes
    WHERE account_id = $1 AND source_key = $2`, [accountId, sourceKey])).rows[0];
  if (!stored || stored.current_ring_kind !== current.kind ||
      stored.current_ring_id !== current.id || stored.current_comfort !== current.comfort ||
      stored.previous_ring_kind !== (previous?.kind ?? null) ||
      stored.previous_ring_id !== (previous?.id ?? null) ||
      stored.previous_comfort !== (previous?.comfort ?? null)) throw unavailable();
  return stored.id;
}

// A batch is never split by guessing how many of its steps predate a change.
// A missing pre-cutover snapshot leaves the original outbox batch retryable.
export async function resolveM2eComfortEpoch(client, { accountId,
  observedStartedAt, observedEndedAt, current, dailySnapshot }) {
  if (!accountId || !validRing(current) ||
      !(observedStartedAt instanceof Date) ||
      !(observedEndedAt instanceof Date) ||
      observedStartedAt >= observedEndedAt) throw unavailable();
  const cutover = (await client.query(`SELECT activated_at
    FROM alpha_m2e_comfort_cutover WHERE id = true`)).rows[0]?.activated_at;
  if (!cutover) throw unavailable();
  const pendingSilver = (await client.query(`SELECT s.recorded_at, s.mint_address
    FROM alpha_silver_allocation_submissions s
    WHERE s.account_id = $1 AND s.recorded_at >= $2
      AND COALESCE((s.allocation->>'comfort')::integer,
        CASE WHEN s.attribute = 'comfort' THEN 1 ELSE 0 END) > 0
      AND NOT EXISTS (SELECT 1 FROM alpha_m2e_comfort_changes c
        WHERE c.account_id = s.account_id AND
          c.source_key = 'silver-points:' || s.signature)
    ORDER BY s.recorded_at`, [accountId, cutover])).rows;
  const unresolvedFor = ring => ring.kind === 'SILVER_RING' ?
    pendingSilver.filter(row => row.mint_address === ring.id) : [];
  const guardPending = (ring, verifiedAfter = null) => {
    if (unresolvedFor(ring).some(row =>
      new Date(row.recorded_at) < observedEndedAt &&
      (!verifiedAfter || new Date(row.recorded_at) >= verifiedAfter)))
      throw unavailable();
  };
  const changes = (await client.query(`SELECT * FROM alpha_m2e_comfort_changes
    WHERE account_id = $1 ORDER BY effective_at, id`, [accountId])).rows;
  const next = changes.find(change => new Date(change.effective_at) > observedStartedAt);
  if (next && new Date(next.uncertain_started_at) < observedEndedAt) throw unavailable();
  const prior = changes.filter(change => new Date(change.effective_at) <= observedStartedAt).at(-1);
  if (prior) {
    const ring = { kind: prior.current_ring_kind, id: prior.current_ring_id,
      comfort: prior.current_comfort };
    if (!next && !sameRing(ring, current)) throw unavailable();
    // A later authoritative Equip/Comfort event re-verifies the selected
    // Ring's current Comfort. Earlier unresolved submissions cannot poison
    // batches created after that event, but older batches still fail closed.
    guardPending(ring, new Date(prior.effective_at));
    return { segmentKey: prior.id, ring };
  }
  const first = changes[0];
  if (first && new Date(first.uncertain_started_at) < observedEndedAt)
    throw unavailable();
  if (dailySnapshot) {
    const frozen = { kind: dailySnapshot.selected_ring_kind,
      id: dailySnapshot.selected_ring_id,
      comfort: dailySnapshot.selected_ring_comfort };
    if (!first && !sameRing(frozen, current)) {
      // The old daily snapshot governs batches completed before activation.
      if (observedEndedAt <= new Date(cutover)) {
        guardPending(frozen);
        return { segmentKey: 'legacy', ring: frozen };
      }
      if (observedStartedAt < new Date(cutover)) throw unavailable();
      // The same selected Ring was already progressed before this migration:
      // establish one post-cutover segment from its verified current state.
      // A submitted but unresolved Silver allocation is not such evidence.
      if (frozen.kind === current.kind && frozen.id === current.id &&
          unresolvedFor(frozen).length === 0) {
        guardPending(current);
        return { segmentKey: 'cutover', ring: current };
      }
      throw unavailable();
    }
    if (first && observedStartedAt >= new Date(cutover) &&
        !sameRing(frozen, current)) throw unavailable();
    guardPending(frozen);
    return { segmentKey: 'legacy', ring: frozen };
  }
  if (first?.previous_ring_kind && first.previous_comfort !== null &&
      first.previous_comfort !== undefined) {
    const ring = { kind: first.previous_ring_kind, id: first.previous_ring_id,
      comfort: first.previous_comfort };
    guardPending(ring);
    return { segmentKey: 'legacy', ring };
  }
  if (observedStartedAt < new Date(cutover)) throw unavailable();
  guardPending(current);
  return { segmentKey: 'legacy', ring: current };
}
