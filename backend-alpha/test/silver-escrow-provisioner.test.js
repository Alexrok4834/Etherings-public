import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createSilverEscrowProvisioner } from '../src/silver-escrow-provisioner.js';
import { drawBoxIdentity } from '../src/draw-box-identity.js';
import { breedingBoxIdentity } from '../src/cooper-breeding.js';
import { adminBoxIdentity } from '../src/admin-box-identity.js';

const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const mint = '7ScmhBvoCmj9LLfdRD1rqjio98deCRxY2dktBNHmUuVd';
const wallet = '3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr';

test('confirmed sealed Box gets one idempotent escrow provisioning', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, issuance_id: 'a'.repeat(64), entitlement_digest: 'c'.repeat(64) };
  const pool = { async query(sql, params) {
    assert.match(sql, /alpha_silver_opening_finalizations f/);
    assert.match(sql, /f\.status = 'confirmed'/);
    assert.deepEqual(params.slice(1), [programId,
      'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG']);
    return { rows: [row] };
  } };
  let ready = false, sends = 0, finalityReads = 0, escrowReads = 0, time = 0;
  const reader = {
    async readFinalized() { finalityReads++; return { finalized: true, programId, cluster: 'devnet',
      kind: 'SILVER_BOX', serial: '1', entitlementDigest: row.entitlement_digest,
      lifecycle: 'SEALED', accountId: row.account_id, issuanceId: row.issuance_id,
      mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet, tokenAmount: '1' }; },
    async readEscrow(args) { escrowReads++; return ready ? { ...args, address: args.escrowAddress,
      authority: args.escrowAuthority, finalized: true,
      programOwner: TOKEN_2022_PROGRAM_ADDRESS, amount: '0' } : null; },
  };
  const chain = { async provisionEscrow(args) {
    assert.equal(args.mintAddress, mint);
    assert.notEqual(args.escrowAddress, args.escrowAuthority);
    sends++;
    ready = true;
  } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader,
    programId, now: () => time });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 1, skipped: 0 });
  assert.deepEqual(await provisioner.tick(), { ready: 1, sent: 0, skipped: 0 });
  assert.deepEqual([finalityReads, escrowReads], [1, 1]);
  time += 5 * 60_000;
  assert.deepEqual(await provisioner.tick(), { ready: 1, sent: 0, skipped: 0 });
  assert.deepEqual([finalityReads, escrowReads], [2, 2]);
  row.finalized_signature = 'changed-row-evidence';
  assert.deepEqual(await provisioner.tick(), { ready: 1, sent: 0, skipped: 0 });
  assert.deepEqual([finalityReads, escrowReads], [3, 3]);
  assert.equal(sends, 1);
});

test('expired ready escrow is checked again and recreated only when absent', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, issuance_id: 'a'.repeat(64), entitlement_digest: 'c'.repeat(64) };
  const pool = { async query() { return { rows: [row] }; } };
  let time = 0, escrowExists = true, sends = 0;
  const reader = {
    async readFinalized() { return { finalized: true, programId, cluster: 'devnet',
      kind: 'SILVER_BOX', serial: '1', entitlementDigest: row.entitlement_digest,
      lifecycle: 'SEALED', accountId: row.account_id, issuanceId: row.issuance_id,
      mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet, tokenAmount: '1' }; },
    async readEscrow(args) { return escrowExists ? { ...args,
      address: args.escrowAddress, authority: args.escrowAuthority,
      finalized: true, programOwner: TOKEN_2022_PROGRAM_ADDRESS, amount: '0' } : null; },
  };
  const chain = { async provisionEscrow() { sends++; escrowExists = true; } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader,
    programId, now: () => time });
  assert.deepEqual(await provisioner.tick(), { ready: 1, sent: 0, skipped: 0 });
  escrowExists = false;
  time += 5 * 60_000;
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 1, skipped: 0 });
  assert.equal(sends, 1);
});

test('confirmed Draw Box gets escrow without changing first-entry identity', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, draw_result_id: randomUUID(), issuance_source: 'draw',
    finalized_signature: 'draw-signature' };
  const pool = { async query(sql) {
    assert.match(sql, /alpha_draw_results/);
    assert.match(sql, /f.state = 'CONFIRMED'/);
    return { rows: [row] };
  } };
  let sent = 0;
  const reader = {
    async readFinalized(args) {
      assert.equal(args.expectedIssuanceSource, 'draw');
      assert.equal(args.expectedDrawResultId, row.draw_result_id);
      assert.equal(args.expectedFinalizedSignature, row.finalized_signature);
      return { finalized: true, programId, cluster: 'devnet', kind: 'SILVER_BOX',
        serial: '4', lifecycle: 'SEALED', accountId: row.account_id,
        issuanceId: args.issuanceId, entitlementDigest: drawBoxIdentity(
          row.account_id, wallet, row.draw_result_id).entitlementDigest,
        issuanceSource: 'draw', drawResultId: row.draw_result_id,
        mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet, tokenAmount: '1' };
    },
    async readEscrow() { return null; },
  };
  const chain = { async provisionEscrow() { sent++; } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader, programId });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 1, skipped: 0 });
  assert.equal(sent, 1);
});

test('confirmed breeding Box uses both parent provenance before escrow funding', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, breeding_operation_id: randomUUID(),
    first_ring_id: randomUUID(), second_ring_id: randomUUID(),
    first_uses: 0, second_uses: 1, issuance_source: 'cooper-breeding',
    finalized_signature: 'breeding-signature' };
  const identity = breedingBoxIdentity(row.account_id, wallet, row.breeding_operation_id,
    row.first_ring_id, row.second_ring_id, row.first_uses, row.second_uses);
  row.issuance_id = identity.issuanceId;
  row.entitlement_digest = identity.entitlementDigest;
  const pool = { async query(sql) {
    assert.match(sql, /alpha_cooper_breeding_settlements/);
    return { rows: [row] };
  } };
  let sent = 0;
  const reader = { async readFinalized(args) {
    assert.deepEqual(args.expectedBreeding, { operationId: row.breeding_operation_id,
      firstRingId: row.first_ring_id, secondRingId: row.second_ring_id,
      firstUses: 0, secondUses: 1 });
    return { finalized: true, programId, cluster: 'devnet', kind: 'SILVER_BOX',
      lifecycle: 'SEALED', serial: '5', accountId: row.account_id,
      issuanceId: identity.issuanceId, entitlementDigest: identity.entitlementDigest,
      issuanceSource: 'cooper-breeding',
      breedingOperationId: row.breeding_operation_id,
      mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet, tokenAmount: '1' };
  }, async readEscrow() { return null; } };
  const chain = { async provisionEscrow() { sent++; } };
  assert.deepEqual(await createSilverEscrowProvisioner({ pool, chain, reader,
    programId, breedingEnabled: true }).tick(), { ready: 0, sent: 1, skipped: 0 });
  assert.equal(sent, 1);
});

test('confirmed administrator Box gets escrow only with matching grant provenance', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    admin_operation_id: randomUUID(), mint_address: mint,
    issuance_source: 'admin-grant', finalized_signature: 'admin-signature' };
  const identity = adminBoxIdentity(row.account_id, wallet, row.admin_operation_id);
  row.issuance_id = identity.issuanceId;
  row.entitlement_digest = identity.entitlementDigest;
  const pool = { async query(sql) {
    assert.match(sql, /alpha_admin_box_grants/);
    assert.match(sql, /g.state = 'CONFIRMED'/);
    return { rows: [row] };
  } };
  let currentOperationId = row.admin_operation_id;
  let sent = 0;
  const reader = {
    async readFinalized(args) {
      assert.equal(args.expectedIssuanceSource, 'admin-grant');
      assert.equal(args.expectedAdminOperationId, row.admin_operation_id);
      assert.equal(args.expectedFinalizedSignature, row.finalized_signature);
      return { finalized: true, programId, cluster: 'devnet', kind: 'SILVER_BOX',
        lifecycle: 'SEALED', serial: '17', accountId: row.account_id,
        issuanceId: identity.issuanceId, entitlementDigest: identity.entitlementDigest,
        issuanceSource: 'admin-grant', adminOperationId: currentOperationId,
        mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet, tokenAmount: '1' };
    },
    async readEscrow() { return null; },
  };
  const chain = { async provisionEscrow() { sent++; } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader, programId });
  currentOperationId = randomUUID();
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 0, skipped: 1 });
  currentOperationId = row.admin_operation_id;
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 1, skipped: 0 });
  assert.equal(sent, 1);
});

test('escrow scan reaches Box rows beyond the first twenty without an unbounded tick', async () => {
  const rows = Array.from({ length: 21 }, () => ({
    account_id: randomUUID(), wallet_address: wallet, mint_address: mint,
    issuance_id: 'a'.repeat(64), entitlement_digest: 'b'.repeat(64),
  }));
  const offsets = [];
  const pool = { async query(_sql, params) {
    offsets.push(params[0]);
    return { rows: rows.slice(params[0], params[0] + 20) };
  } };
  const reader = { async readFinalized() { return null; },
    async readEscrow() { throw new Error('must not inspect escrow'); } };
  const chain = { async provisionEscrow() { throw new Error('must not fund'); } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader, programId });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 0, skipped: 20 });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 0, skipped: 1 });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 0, skipped: 20 });
  assert.deepEqual(offsets, [0, 20, 0]);
});

test('Draw Box with mismatched on-chain result is never provisioned', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, draw_result_id: randomUUID(), issuance_source: 'draw' };
  const pool = { async query() { return { rows: [row] }; } };
  const identity = drawBoxIdentity(row.account_id, wallet, row.draw_result_id);
  const reader = { async readFinalized() { return { finalized: true, programId,
    cluster: 'devnet', kind: 'SILVER_BOX', lifecycle: 'SEALED',
    accountId: row.account_id, issuanceId: identity.issuanceId,
    entitlementDigest: identity.entitlementDigest, issuanceSource: 'draw',
    drawResultId: randomUUID(), mintAddress: mint, originalRecipient: wallet,
    tokenOwner: wallet, tokenAmount: '1', serial: '4' }; },
  async readEscrow() { throw new Error('must not inspect escrow'); } };
  const chain = { async provisionEscrow() { throw new Error('must not fund'); } };
  assert.deepEqual(await createSilverEscrowProvisioner({ pool, chain, reader, programId }).tick(),
    { ready: 0, sent: 0, skipped: 1 });
});

test('unverified Box cannot trigger escrow funding', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, issuance_id: 'b'.repeat(64) };
  const pool = { async query() { return { rows: [row] }; } };
  const reader = { async readFinalized() { return { finalized: true,
    kind: 'SILVER_BOX', lifecycle: 'SEALED', accountId: randomUUID() }; },
  async readEscrow() { throw new Error('must not inspect escrow'); } };
  const chain = { async provisionEscrow() { throw new Error('must not fund'); } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader, programId });
  assert.deepEqual(await provisioner.tick(), { ready: 0, sent: 0, skipped: 1 });
});

test('unexpected existing escrow is rejected without funding', async () => {
  const row = { account_id: randomUUID(), wallet_address: wallet,
    mint_address: mint, issuance_id: 'd'.repeat(64), entitlement_digest: 'e'.repeat(64) };
  const pool = { async query() { return { rows: [row] }; } };
  const reader = {
    async readFinalized() { return { finalized: true, programId, cluster: 'devnet',
      kind: 'SILVER_BOX', lifecycle: 'SEALED', accountId: row.account_id,
      issuanceId: row.issuance_id, entitlementDigest: row.entitlement_digest,
      mintAddress: mint, originalRecipient: wallet, tokenOwner: wallet,
      tokenAmount: '1', serial: '2' }; },
    async readEscrow(args) { return { ...args, address: args.escrowAddress,
      authority: wallet, finalized: true, programOwner: TOKEN_2022_PROGRAM_ADDRESS,
      amount: '0' }; },
  };
  const chain = { async provisionEscrow() { throw new Error('must not fund'); } };
  const provisioner = createSilverEscrowProvisioner({ pool, chain, reader, programId });
  await assert.rejects(() => provisioner.tick(), /account mismatch/);
});
