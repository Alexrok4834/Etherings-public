import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createCanonicalEruSend } from '../src/eru-canonical-send.js';
import { readEruHistory } from '../src/eru-history.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const encoder = getAddressEncoder();
const wallet = key(10);
const other = key(11);
const accountId = 'd108ef96-b90e-4a98-830e-237dc800d63a';
const token = 'a'.repeat(64);
const deployment = { gatewayProgramId: key(12), hookProgramId: key(13),
  mintAddress: key(14), reserveAddress: key(15), treasuryAddress: key(16),
  vaultAddress: key(17), attestorAddress: key(18), configEpoch: 1 };
const bytes = value => encoder.encode(value);
const account = (mint, owner, amount = 0n) => {
  const data = Buffer.alloc(165);
  data.set(bytes(mint), 0);
  data.set(bytes(owner), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { owner: TOKEN_2022_PROGRAM_ADDRESS, data };
};

test('canonical Send selects bound ATA and live Gateway, namespaces nonce, preserves exact fee', async () => {
  const [config] = await getProgramDerivedAddress({ programAddress: deployment.gatewayProgramId,
    seeds: [new TextEncoder().encode('eru-config')] });
  const [meta] = await getProgramDerivedAddress({ programAddress: deployment.hookProgramId,
    seeds: [new TextEncoder().encode('extra-account-metas'), bytes(deployment.mintAddress)] });
  const [source] = await findAssociatedTokenPda({ owner: wallet, mint: deployment.mintAddress,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: other, mint: deployment.mintAddress,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [replay] = await getProgramDerivedAddress({ programAddress: deployment.gatewayProgramId,
    seeds: [new TextEncoder().encode('nonce'), bytes(config), bytes(wallet)] });
  const configData = Buffer.alloc(330);
  configData[0] = 1;
  configData.writeBigUInt64LE(1n, 322);
  for (const [offset, value] of [[1, deployment.vaultAddress],
    [33, deployment.mintAddress], [65, deployment.treasuryAddress],
    [97, deployment.hookProgramId], [129, deployment.reserveAddress],
    [290, deployment.attestorAddress]]) configData.set(bytes(value), offset);
  const mintData = Buffer.alloc(82);
  mintData[44] = 9;
  let bound = wallet;
  let validSource = true;
  let chainNonce = 0n;
  const rows = [];
  const sql = [];
  const connection = {
    async getGenesisHash() { return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; },
    async getAccountInfo(address) {
      if ([deployment.gatewayProgramId, deployment.hookProgramId].includes(address))
        return { executable: true };
      if (address === config) return { owner: deployment.gatewayProgramId, data: configData };
      if (address === meta) return { owner: deployment.hookProgramId, data: Buffer.alloc(86) };
      if (address === deployment.mintAddress)
        return { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintData };
      if (address === source) return validSource
        ? account(deployment.mintAddress, wallet, 10_000_000_000n)
        : account(deployment.mintAddress, other, 10_000_000_000n);
      if (address === deployment.treasuryAddress)
        return account(deployment.mintAddress, key(19));
      if (address === replay) {
        const data = Buffer.alloc(8);
        data.writeBigUInt64LE(chainNonce);
        return { owner: deployment.gatewayProgramId, data };
      }
      return null;
    },
    async getTokenAccountBalance() { return { value: { amount: '10000000000' } }; },
    async getSlot() { return 100; },
    async getBlockHeight() { return 50; },
    async getLatestBlockhash() { return { blockhash: key(20), lastValidBlockHeight: 150 }; },
    async isBlockhashValid() { return true; },
  };
  const query = async (statement, params) => {
    sql.push(statement);
    if (statement.includes('FROM alpha_sessions')) {
      assert.equal(params[0], createHash('sha256').update(token).digest('hex'));
      return { rows: [{ id: accountId, wallet_address: bound, environment: 'alpha-local' }] };
    }
    if (statement.includes('FROM alpha_eru_intents')) {
      assert.match(statement, /intent_namespace = 'canonical'/);
      return { rows: statement.includes('WHERE id =')
        ? rows.filter(row => row.id === params[0]) : rows };
    }
    if (statement.startsWith('INSERT INTO alpha_eru_intents')) {
      assert.match(statement, /intent_namespace/);
      rows.push({ id: params[0], account_id: accountId, wallet_address: wallet,
        cluster: 'devnet', nonce: params[4], message_base64: params[5],
        blockhash: params[6], last_valid_block_height: params[7], status: 'pending',
        intent_namespace: 'canonical', transaction_signature: null,
        created_at: new Date('2026-10-02T12:00:00Z') });
    }
    if (statement.startsWith("UPDATE alpha_eru_intents SET status = 'failed'"))
      rows.find(row => row.id === params[0]).status = 'failed';
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const send = createCanonicalEruSend({ pool, connection, walletEnvironment: 'alpha-local',
    rpcUrl: 'http://127.0.0.1:18889', deployment });
  const first = await send.issue(token, { recipient: other, amount: '1.000000001' });
  assert.equal(first.status, 200);
  const message = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(first.body.message, 'base64'));
  const ix = getInstructionsFromCompiledTransactionMessage(message).at(-1);
  assert.equal(message.staticAccounts[0], wallet);
  assert.equal(ix.programAddress, deployment.gatewayProgramId);
  assert.equal(ix.accounts[0].address, source);
  assert.equal(ix.accounts[1].address, deployment.mintAddress);
  assert.equal(ix.accounts[2].address, destination);
  assert.equal(ix.accounts[3].address, deployment.treasuryAddress);
  assert.equal(ix.accounts[10].address, replay);
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(1), 1_000_000_001n);
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(9), 1n);
  assert.equal((1_000_000_001n * 200n + 9_999n) / 10_000n, 20_000_001n);
  const history = await send.history(token);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.operations.map(({ type, direction, amount, fee,
    counterparty, status }) => ({ type, direction, amount, fee, counterparty, status })),
  [{ type: 'send', direction: 'out', amount: '1.000000001', fee: '0.020000001',
    counterparty: other, status: 'pending' }]);
  rows[0].status = 'confirmed';
  const received = await readEruHistory(pool, { id: accountId, wallet_address: other },
    deployment.gatewayProgramId);
  assert.deepEqual(received.body.operations.map(({ type, direction, amount, fee,
    counterparty }) => ({ type, direction, amount, fee, counterparty })),
  [{ type: 'send', direction: 'in', amount: '1.000000001', fee: null,
    counterparty: wallet }]);
  rows[0].status = 'pending';
  assert.equal((await send.issue(token, { recipient: other,
    amount: '1.000000001' })).body.id, first.body.id);
  chainNonce = 4n; // An accepted game operation used the shared wallet replay PDA.
  const next = await send.issue(token, { recipient: other, amount: '1' });
  assert.equal(next.status, 200);
  assert.equal(rows[0].status, 'failed');
  assert.equal(Buffer.from(getInstructionsFromCompiledTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(Buffer.from(next.body.message, 'base64')))
    .at(-1).data).readBigUInt64LE(9), 5n);
  validSource = false;
  assert.equal((await send.issue(token, { recipient: other, amount: '1' })).status, 409);
  rows[1].status = 'unknown';
  rows[1].transaction_signature = null;
  assert.equal((await send.reconcile(token, { id: next.body.id })).status, 503);
  validSource = true;
  bound = other;
  assert.equal((await send.issue(token, { recipient: other, amount: '1' })).status, 409);
  assert.ok(sql.some(statement => statement.includes('intent_namespace')));
});
