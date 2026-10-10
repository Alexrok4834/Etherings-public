import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { cooperEruStaticConfigSha256,
  createCooperEruCandidateReader } from '../src/cooper-eru-candidate-reader.js';
import { sameCooperEruIntent } from '../src/cooper-eru-intent.js';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const program = key(11);
const mint = key(12);
const treasury = key(13);
const hook = key(14);
const attestor = key(15);
const wallet = '2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc';
const genesis = key(17);
const raw = value => getAddressEncoder().encode(value);
const utf8 = value => new TextEncoder().encode(value);
const pda = async (...seeds) => (await getProgramDerivedAddress({
  programAddress: program, seeds,
}))[0];
const configData = Buffer.alloc(330);
configData[0] = 1;
for (const [offset, value] of [[33, mint], [65, treasury], [97, hook], [290, attestor]])
  configData.set(raw(value), offset);
configData.writeBigUInt64LE(1n, 322);
const ids = { account_id: randomUUID(), operation_id: randomUUID(),
  hybrid_operation_id: randomUUID(), reservation_id: randomUUID(), ring_id: randomUUID() };
const baseRow = { ...ids, wallet_address: wallet, current_wallet: wallet,
  cluster: 'local-validator', status: 'prepared', reservation_state: 'held',
  rules_version: 'copper-level-up-v2', response_snapshot: null,
  expected_level: 4, target_level: 5, current_level: 4,
  unspent_points_before: 12, current_points: 12,
  comfort: 20, charm: 10, quality: 8, luck: 6,
  ert_cost: '24.000000000000000000', eru_principal: '30.000000000000000000',
  eru_fee: '0.600000000000000000' };
baseRow.request_fingerprint = createHash('sha256').update(JSON.stringify({
  ownerUserId: ids.account_id, ringId: ids.ring_id,
  expectedCurrentLevel: 4, targetLevel: 5, rulesVersion: baseRow.rules_version,
})).digest('hex');
baseRow.request_digest = createHash('sha256').update(JSON.stringify({
  rulesVersion: baseRow.rules_version, operationId: ids.operation_id,
  hybridOperationId: ids.hybrid_operation_id,
  accountId: ids.account_id, ringId: ids.ring_id, walletAddress: wallet,
  cluster: baseRow.cluster, expectedLevel: 4, targetLevel: 5,
  unspentPointsBefore: 12, attributes: { comfort: 20, charm: 10, quality: 8, luck: 6 },
  ertCost: '24', eruPrincipal: '30', eruFee: '0.6',
})).digest('hex');

async function fixture(change = {}) {
  const config = await pda(utf8('eru-config'));
  const replay = await pda(utf8('nonce'), raw(config), raw(wallet));
  const operationReplay = await pda(utf8('cooper-level-up'), raw(config), raw(wallet),
    Buffer.from(ids.operation_id.replaceAll('-', ''), 'hex'));
  let reads = 0;
  const row = { ...baseRow, ...change.row };
  const pool = { async query(sql, parameters) {
    assert.match(sql, /alpha_ert_reservations/);
    assert.deepEqual(parameters, [ids.account_id, ids.operation_id]);
    reads++;
    return { rows: [reads === 2 && change.secondRow ? change.secondRow : row] };
  } };
  const chain = {
    async getGenesisHash() { return change.genesis ?? genesis; },
    async getAccountInfo(keyAddress) {
      if (keyAddress === program) return { executable: change.executable ?? true };
      if (keyAddress === config) return { owner: change.configOwner ?? program,
        data: change.configData ?? configData };
      if (keyAddress === replay) return change.replay ?? null;
      if (keyAddress === operationReplay) return change.operationReplay ?? null;
      throw new Error('Unexpected chain account');
    },
    async getSlot() { return change.slot ?? 30; },
    async getBlockHeight() { return 100; },
    async getLatestBlockhash() { return { blockhash: change.blockhash ?? key(18),
      lastValidBlockHeight: change.lastValidBlockHeight ?? 120 }; },
    async isBlockhashValid() { return change.validBlockhash ?? true; },
  };
  return { reader: createCooperEruCandidateReader({ pool, chain,
    cluster: 'local-validator', expectedGenesisHash: genesis, gatewayProgramId: program,
    expectedConfigStaticSha256: cooperEruStaticConfigSha256(configData) }),
  reads };
}

test('paid Gateway activity changes mutable config bytes without invalidating Cooper review', async () => {
  const afterPayment = Buffer.from(configData);
  afterPayment.fill(7, 170, 290);
  const { reader } = await fixture({ configData: afterPayment });
  assert.equal((await reader.read(ids.account_id, ids.operation_id)).operationId,
    ids.operation_id);
  const changedAuthority = Buffer.from(afterPayment);
  changedAuthority[290] ^= 1;
  const { reader: rejected } = await fixture({ configData: changedAuthority });
  await assert.rejects(() => rejected.read(ids.account_id, ids.operation_id));
  const activePayment = Buffer.from(afterPayment);
  activePayment[169] = 2;
  const { reader: active } = await fixture({ configData: activePayment });
  await assert.rejects(() => active.read(ids.account_id, ids.operation_id));
});

test('read-only resolver binds current preparation, config, replay and fresh blockhash', async () => {
  const { reader } = await fixture();
  const candidate = await reader.read(ids.account_id, ids.operation_id);
  assert.equal(candidate.operationId, ids.operation_id);
  assert.equal(candidate.reservationId, ids.reservation_id);
  assert.equal(candidate.walletAddress, wallet);
  assert.equal(candidate.sizeBytes, 780);
  const binding = { operation_id: ids.operation_id, account_id: ids.account_id,
    reservation_id: ids.reservation_id, wallet_address: wallet,
    cluster: 'local-validator', genesis_hash: genesis,
    gateway_program_id: program, nonce: String(candidate.nonce),
    expiry_slot: String(candidate.expirySlot) };
  const { reader: later } = await fixture({ slot: 40, blockhash: key(19) });
  const refreshed = await later.read(ids.account_id, ids.operation_id, binding);
  assert(sameCooperEruIntent(candidate, refreshed));
  const { reader: expired } = await fixture({ slot: candidate.expirySlot });
  await assert.rejects(() => expired.read(ids.account_id, ids.operation_id, binding));
  const replayData = Buffer.alloc(8);
  replayData.writeBigUInt64LE(8n);
  const { reader: advanced } = await fixture({ replay: { owner: program, data: replayData },
    operationReplay: { owner: '11111111111111111111111111111111', data: Buffer.alloc(0) } });
  const message = await advanced.read(ids.account_id, ids.operation_id);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(message.messageBase64, 'base64'));
  const instruction = getInstructionsFromCompiledTransactionMessage(compiled)[1];
  assert.equal(Buffer.from(instruction.data).readBigUInt64LE(9), 9n);
});

test('resolver fails closed on stale DB, foreign owner and chain mismatch', async () => {
  for (const change of [
    { row: { current_level: 5 } },
    { row: { current_wallet: key(20) } },
    { row: { request_digest: '0'.repeat(64) } },
    { row: { reservation_state: 'released' } },
    { row: { status: 'unknown' } },
    { secondRow: { ...baseRow, current_points: 13 } },
    { genesis: key(21) },
    { executable: false },
    { configOwner: key(22) },
    { configData: Buffer.alloc(330) },
    { operationReplay: { owner: program, data: Buffer.alloc(32) } },
    { replay: { owner: key(23), data: Buffer.alloc(8) } },
    { validBlockhash: false },
    { lastValidBlockHeight: 100 },
  ]) {
    const { reader } = await fixture(change);
    await assert.rejects(() => reader.read(ids.account_id, ids.operation_id));
  }
  const { reader } = await fixture();
  await assert.rejects(() => reader.read(randomUUID(), ids.operation_id));
});
