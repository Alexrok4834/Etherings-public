import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveM2eDisplayRingCount, resolveM2eEligibleRingCount,
  resolveM2eUnboundCooperCount,
  resolveM2eRingInputs } from '../src/m2e-ring-inputs.js';

const identity = { accountId: 'alpha-owner', programId: 'canonical-program', cluster: 'devnet',
  walletAddress: 'bound-wallet' };
const cooper = { accountId: identity.accountId, id: 'starter-uuid', comfort: 12 };
const silver = { finalized: true, kind: 'SILVER_RING',
  programId: identity.programId, cluster: identity.cluster,
  tokenOwner: identity.walletAddress, mintAddress: 'ring-mint', comfort: 27 };

function inputs({ selection = { kind: 'COOPER', id: cooper.id },
  cooperRings = [cooper], rings = [silver], state = 'ELIGIBLE',
  eligibleRing = silver } = {}) {
  return { ...identity, selection, ownedCooperRings: cooperRings,
    chain: {
      async listOwnedRings() { return rings; },
      async readEquipmentEligibility() { return { state, ring: eligibleRing }; },
    } };
}

async function unavailable(input) {
  await assert.rejects(() => resolveM2eRingInputs(input),
    error => error.code === 'M2E_RING_SELECTION_UNAVAILABLE');
}

test('current tagged selection and eligible owned count use verified inputs only', async () => {
  assert.deepEqual(await resolveM2eRingInputs(inputs()), {
    ringCount: 2, selectedRing: { kind: 'COOPER', id: cooper.id },
    selectedRingComfort: 12,
  });
  assert.deepEqual(await resolveM2eRingInputs(inputs({
    selection: { kind: 'SILVER_RING', id: silver.mintAddress },
  })), { ringCount: 2,
    selectedRing: { kind: 'SILVER_RING', id: silver.mintAddress },
    selectedRingComfort: 27 });
});

test('confirmed cooldown excludes Silver and cannot supply selected effects', async () => {
  assert.equal((await resolveM2eRingInputs(inputs({ state: 'COOLDOWN' }))).ringCount, 1);
  assert.equal((await resolveM2eRingInputs(inputs({ state: 'TRANSFERRED_AWAY' }))).ringCount, 1);
  await unavailable(inputs({ state: 'COOLDOWN',
    selection: { kind: 'SILVER_RING', id: silver.mintAddress } }));
  await unavailable(inputs({ rings: [],
    selection: { kind: 'SILVER_RING', id: silver.mintAddress } }));
});

test('ACTIVE Marketplace listing excludes Silver capacity until finalized UNLIST', async () => {
  let state = 'ACTIVE';
  const marketReader = { async readListing(mintAddress) {
    return { mintAddress, kind: 'SILVER_RING', state };
  } };
  assert.equal((await resolveM2eRingInputs({ ...inputs(), marketReader })).ringCount, 1);
  await unavailable({ ...inputs({ selection: { kind: 'SILVER_RING', id: silver.mintAddress } }),
    marketReader });
  state = 'CANCELLED';
  assert.equal((await resolveM2eRingInputs({ ...inputs(), marketReader })).ringCount, 2);
  state = 'SOLD';
  assert.equal((await resolveM2eRingInputs({ ...inputs(), marketReader })).ringCount, 2);
  marketReader.readListing = async () => null;
  assert.equal((await resolveM2eRingInputs({ ...inputs(), marketReader })).ringCount, 2);
});

test('Marketplace UNKNOWN or wrong listing identity fails capacity closed', async () => {
  const input = inputs();
  await unavailable({ ...input, marketReader: { async readListing() {
    throw new Error('provider offline');
  } } });
  await unavailable({ ...input, marketReader: { async readListing() {
    return { mintAddress: 'wrong-mint', kind: 'SILVER_RING', state: 'ACTIVE' };
  } } });
  await unavailable({ ...input, marketReader: { async readListing() {
    return { mintAddress: silver.mintAddress, kind: 'SILVER_BOX', state: 'ACTIVE' };
  } } });
});

test('provider UNKNOWN and mismatched chain identity fail closed', async () => {
  await unavailable(inputs({ state: 'UNKNOWN' }));
  await unavailable(inputs({ rings: [{ ...silver, tokenOwner: 'another-wallet' }] }));
  await unavailable(inputs({ eligibleRing: { ...silver, comfort: 99 } }));
  await unavailable(inputs({ rings: [silver, silver] }));
  await unavailable(inputs({ cooperRings: [{ ...cooper, accountId: 'other-owner' }] }));
  await unavailable(inputs({ selection: { kind: 'COOPER', id: 'not-owned' } }));
  await unavailable(inputs({ cooperRings: [], rings: [] }));
  const offline = inputs();
  offline.chain.listOwnedRings = async () => { throw new Error('provider offline'); };
  await unavailable(offline);
  const eligibilityOffline = inputs();
  eligibilityOffline.chain.readEquipmentEligibility = async () => {
    throw new Error('provider offline');
  };
  await unavailable(eligibilityOffline);
});

test('Comfort follows the existing MVP nonnegative-safe-integer calculator input', async () => {
  const high = { ...silver, comfort: 150 };
  const result = await resolveM2eRingInputs(inputs({
    selection: { kind: 'SILVER_RING', id: high.mintAddress },
    rings: [high], eligibleRing: high,
  }));
  assert.equal(result.selectedRingComfort, 150);
  await unavailable(inputs({ cooperRings: [{ ...cooper, comfort: -1 }] }));
});

test('live capacity ignores a transferred daily selection but fails closed on UNKNOWN', async () => {
  const client = { async query() { return { rows: [{ account_id: identity.accountId,
    ring_id: cooper.id, comfort: cooper.comfort }] }; } };
  const chain = inputs().chain;
  const options = { client, accountId: identity.accountId, chain,
    programId: identity.programId, cluster: identity.cluster,
    walletAddress: identity.walletAddress };
  assert.equal(await resolveM2eEligibleRingCount(options), 2);
  let listingState = 'ACTIVE';
  options.marketReader = { async readListing(mintAddress) {
    return { mintAddress, kind: 'SILVER_RING', state: listingState };
  } };
  assert.equal(await resolveM2eEligibleRingCount(options), 1);
  listingState = 'CANCELLED';
  assert.equal(await resolveM2eEligibleRingCount(options), 2);
  chain.readEquipmentEligibility = async () => ({ state: 'COOLDOWN' });
  assert.equal(await resolveM2eEligibleRingCount(options), 1);
  chain.readEquipmentEligibility = async () => ({ state: 'UNKNOWN' });
  await assert.rejects(() => resolveM2eEligibleRingCount(options),
    error => error.code === 'M2E_RING_SELECTION_UNAVAILABLE');
});

test('unbound display cap counts only verified account Cooper with a valid selection', async () => {
  let selection = { ring_kind: 'COOPER', ring_id: cooper.id };
  let rings = [{ account_id: identity.accountId, ring_id: cooper.id,
    comfort: cooper.comfort }];
  const client = { async query(sql, args) {
    assert.deepEqual(args, [identity.accountId]);
    return { rows: sql.includes('alpha_ring_selection') ?
      (selection ? [selection] : []) : rings };
  } };
  const count = () => resolveM2eUnboundCooperCount({ client, accountId: identity.accountId });
  assert.equal(await count(), 1);
  rings = [...rings, { account_id: identity.accountId, ring_id: 'draw-cooper', comfort: 8 }];
  assert.equal(await count(), 2);
  selection = { ring_kind: 'SILVER_RING', ring_id: 'unverified' };
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
  selection = { ring_kind: 'COOPER', ring_id: cooper.id };
  rings = [{ account_id: 'another-account', ring_id: cooper.id, comfort: 12 }];
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
  rings = [{ account_id: identity.accountId, ring_id: cooper.id, comfort: null }];
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
  rings = [];
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
});

test('display capacity uses Cooper before binding and the canonical chain path after binding', async () => {
  let binding = null;
  const client = { async query(sql, args) {
    assert.deepEqual(args, [identity.accountId]);
    if (sql.includes('alpha_wallet_bindings')) return { rows: binding ? [binding] : [] };
    if (sql.includes('alpha_ring_selection')) return { rows: [{ ring_kind: 'COOPER',
      ring_id: cooper.id }] };
    return { rows: [{ account_id: identity.accountId, ring_id: cooper.id,
      comfort: cooper.comfort }] };
  } };
  let chainReads = 0;
  const chain = { async listOwnedRings() { chainReads++; return [silver]; },
    async readEquipmentEligibility() { return { state: 'ELIGIBLE', ring: silver }; } };
  const count = () => resolveM2eDisplayRingCount({ client, accountId: identity.accountId,
    walletEnvironment: 'alpha-local', chain, programId: identity.programId,
    cluster: identity.cluster });
  assert.equal(await count(), 1);
  assert.equal(chainReads, 0);
  binding = { wallet_address: identity.walletAddress, environment: 'alpha-local' };
  assert.equal(await count(), 2);
  assert.equal(chainReads, 1);
  binding = { wallet_address: identity.walletAddress, environment: 'wrong' };
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
  binding = { wallet_address: null, environment: 'alpha-local' };
  await assert.rejects(count, { code: 'M2E_RING_SELECTION_UNAVAILABLE' });
});
