// Resolve only the authoritative Ring inputs for a future daily M2E snapshot.
// This does not create a snapshot, accept steps, or credit ERT.
import { silverRingIsListed } from './silver-listed-eligibility.js';

const UNAVAILABLE = 'M2E_RING_SELECTION_UNAVAILABLE';

function unavailable() {
  const error = new Error('Authoritative M2E Ring inputs unavailable');
  error.code = UNAVAILABLE;
  return error;
}

function validComfort(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSilver(ring, { programId, cluster, walletAddress }) {
  return ring?.finalized === true && ring.kind === 'SILVER_RING' &&
    ring.programId === programId && ring.cluster === cluster &&
    ring.tokenOwner === walletAddress && typeof ring.mintAddress === 'string' &&
    validComfort(ring.comfort);
}

export async function resolveM2eRingInputs({ accountId, selection, ownedCooperRings, chain,
  marketReader = null, programId, cluster, walletAddress }) {
  if (!selection || !['COOPER', 'SILVER_RING'].includes(selection.kind) ||
      typeof selection.id !== 'string' || !selection.id ||
      !Array.isArray(ownedCooperRings) || !chain ||
      typeof chain.listOwnedRings !== 'function' ||
      typeof chain.readEquipmentEligibility !== 'function' ||
      !accountId || !programId || !cluster || !walletAddress) throw unavailable();

  const cooper = new Map();
  for (const ring of ownedCooperRings) {
    if (ring?.accountId !== accountId || typeof ring.id !== 'string' || !ring.id ||
        !validComfort(ring.comfort) ||
        cooper.has(ring.id)) throw unavailable();
    cooper.set(ring.id, ring);
  }

  let listed;
  try {
    listed = await chain.listOwnedRings({ programId, cluster, walletAddress });
  } catch { throw unavailable(); }
  if (!Array.isArray(listed)) throw unavailable();

  const eligibleSilver = new Map();
  const seen = new Set();
  for (const ring of listed) {
    if (!validSilver(ring, { programId, cluster, walletAddress }) ||
        seen.has(ring.mintAddress)) throw unavailable();
    seen.add(ring.mintAddress);
    let eligibility;
    try {
      eligibility = await chain.readEquipmentEligibility({ programId, cluster,
        walletAddress, mintAddress: ring.mintAddress });
    } catch { throw unavailable(); }
    if (eligibility?.state === 'UNKNOWN' || !eligibility) throw unavailable();
    if (eligibility.state === 'COOLDOWN' || eligibility.state === 'TRANSFERRED_AWAY') continue;
    if (eligibility.state !== 'ELIGIBLE' ||
        !validSilver(eligibility.ring, { programId, cluster, walletAddress }) ||
        eligibility.ring.mintAddress !== ring.mintAddress ||
        eligibility.ring.comfort !== ring.comfort) throw unavailable();
    try {
      if (await silverRingIsListed(marketReader, ring.mintAddress)) continue;
    } catch { throw unavailable(); }
    eligibleSilver.set(ring.mintAddress, eligibility.ring);
  }

  const selected = selection.kind === 'COOPER' ? cooper.get(selection.id) :
    eligibleSilver.get(selection.id);
  if (!selected || cooper.size + eligibleSilver.size < 1) throw unavailable();
  return { ringCount: cooper.size + eligibleSilver.size,
    selectedRing: { kind: selection.kind, id: selection.id },
    selectedRingComfort: selected.comfort };
}

// Adapter for the Alpha step-batch transaction. Only PostgreSQL owns
// Cooper/selection; the pure resolver above verifies Silver against the chain.
export async function resolveM2eRingInputsInTransaction({ client, accountId, chain,
  marketReader = null, programId, cluster, walletAddress }) {
  const selection = (await client.query(`SELECT ring_kind, ring_id
    FROM alpha_ring_selection WHERE account_id = $1 FOR UPDATE`, [accountId])).rows[0];
  const cooper = await ownedCooper(client, accountId);
  return resolveM2eRingInputs({ accountId,
    selection: selection ? { kind: selection.ring_kind, id: selection.ring_id } : null,
    ownedCooperRings: cooper, chain, marketReader, programId, cluster, walletAddress });
}

async function ownedCooper(client, accountId) {
  return (await client.query(`SELECT s.account_id, s.ring_id, p.comfort
    FROM alpha_starter_cooper s LEFT JOIN alpha_cooper_current_state p
      ON p.account_id = s.account_id AND p.ring_id = s.ring_id
    WHERE s.account_id = $1
    UNION ALL
    SELECT d.account_id, d.ring_id, p.comfort
    FROM alpha_draw_cooper_rings d JOIN alpha_cooper_current_state p
      ON p.account_id = d.account_id AND p.ring_id = d.ring_id
    WHERE d.account_id = $1
    UNION ALL
    SELECT g.account_id, g.ring_id, p.comfort
    FROM alpha_admin_cooper_rings g JOIN alpha_cooper_current_state p
      ON p.account_id = g.account_id AND p.ring_id = g.ring_id
    WHERE g.account_id = $1`, [accountId])).rows.map(row => ({
    accountId: row.account_id, id: row.ring_id, comfort: row.comfort,
  }));
}

// Current collection capacity is independent of the day's frozen selection.
// Use a verified Cooper only to reuse the same strict owned-Ring validation.
export async function resolveM2eEligibleRingCount({ client, accountId, chain,
  marketReader = null, programId, cluster, walletAddress }) {
  const cooper = await ownedCooper(client, accountId);
  if (cooper.length === 0) throw unavailable();
  const inputs = await resolveM2eRingInputs({ accountId,
    selection: { kind: 'COOPER', id: cooper[0].id }, ownedCooperRings: cooper,
    chain, marketReader, programId, cluster, walletAddress });
  return inputs.ringCount;
}

// A fresh verified account can display its Cooper capacity before it binds a
// wallet. This read does not authorize step settlement or claim Silver assets.
export async function resolveM2eUnboundCooperCount({ client, accountId }) {
  if (!client || !accountId) throw unavailable();
  const selection = (await client.query(`SELECT ring_kind, ring_id
    FROM alpha_ring_selection WHERE account_id = $1`, [accountId])).rows[0];
  const cooper = await ownedCooper(client, accountId);
  const seen = new Set();
  for (const ring of cooper) {
    if (ring.accountId !== accountId || typeof ring.id !== 'string' || !ring.id ||
        !validComfort(ring.comfort) || seen.has(ring.id)) throw unavailable();
    seen.add(ring.id);
  }
  if (selection?.ring_kind !== 'COOPER' || !seen.has(selection.ring_id))
    throw unavailable();
  return cooper.length;
}

export async function resolveM2eDisplayRingCount({ client, accountId, walletEnvironment,
  chain, marketReader = null, programId, cluster }) {
  if (!client || !accountId || !walletEnvironment) throw unavailable();
  const binding = (await client.query(`SELECT wallet_address, environment
    FROM alpha_wallet_bindings WHERE account_id = $1`, [accountId])).rows[0];
  if (!binding) return resolveM2eUnboundCooperCount({ client, accountId });
  if (!binding.wallet_address || binding.environment !== walletEnvironment) throw unavailable();
  return resolveM2eEligibleRingCount({ client, accountId, chain, marketReader,
    programId, cluster, walletAddress: binding.wallet_address });
}
