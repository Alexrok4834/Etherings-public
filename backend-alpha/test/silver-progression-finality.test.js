import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { buildSilverProgressionMessage } from '../src/silver-progression-intent.js';
import { createSilverProgressionFinality } from '../src/silver-progression-finality.js';

const key = byte => bs58.encode(Buffer.alloc(32, byte));
const signer = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, address: bs58.encode(publicKey.export({
    format: 'der', type: 'spki',
  }).subarray(-32)) };
};
const uuid = value => Buffer.from(value.replaceAll('-', ''), 'hex');
const derive = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: program, seeds,
}))[0];

test('Silver finalized receipt requires exact two signatures, operation and replay state', async () => {
  const user = signer(), issuer = signer();
  const accountId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const reservationId = '33333333-3333-4333-8333-333333333333';
  const mint = key(4), programId = key(5);
  const preparation = { id: operationId, operation_id: operationId,
    reservation_id: reservationId, account_id: accountId,
    mint_address: mint, wallet_address: user.address, cluster: 'devnet',
    status: 'prepared', reservation_state: 'held', response_snapshot: null,
    current_wallet: user.address, expected_level: 1, target_level: 2,
    ert_cost: '15.000000000000000000', eru_principal: '0', eru_fee: '0' };
  preparation.request_digest = createHash('sha256').update(JSON.stringify({
    accountId, mint, expectedLevel: 1, targetLevel: 2, cost: '15',
  })).digest('hex');
  const candidate = await buildSilverProgressionMessage({ preparation, programId,
    issuerAddress: issuer.address, tokenAddress: key(6), cluster: 'devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    blockhash: key(7), lastValidBlockHeight: 1000 });
  const message = Buffer.from(candidate.messageBase64, 'base64');
  const userSignature = sign(null, message, user.privateKey);
  const issuerSignature = sign(null, message, issuer.privateKey);
  const raw = Buffer.concat([Buffer.from([2]), userSignature, issuerSignature, message]);
  const signature = bs58.encode(userSignature);
  const rawMint = Buffer.from(getAddressEncoder().encode(mint));
  const rawUser = Buffer.from(getAddressEncoder().encode(user.address));
  const replay = await derive(programId, new TextEncoder().encode('silver-progress'),
    rawMint, uuid(operationId));
  const replayData = Buffer.alloc(128);
  replayData.write('ERSPRV1', 0, 'ascii');
  replayData[8] = 1;
  replayData[9] = 2;
  rawMint.copy(replayData, 16);
  rawUser.copy(replayData, 48);
  uuid(operationId).copy(replayData, 80);
  uuid(reservationId).copy(replayData, 96);
  uuid(accountId).copy(replayData, 112);
  const ringData = Buffer.alloc(576);
  ringData.write('ERSRGV1', 0, 'ascii');
  rawMint.copy(ringData, 16);
  ringData[290] = 2;
  const submission = { message_base64: candidate.messageBase64,
    issuer_signature_base64: issuerSignature.toString('base64'),
    intent_digest: candidate.intentDigest, gateway_config_base64: null };
  const pool = { query: async sql => ({ rows: [
    sql.includes('alpha_silver_progression_submissions') ? submission : preparation,
  ] }) };
  const chain = { getGenesisHash: async () => candidate.genesisHash,
    getSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: null }),
    getTransaction: async () => ({ transaction: [raw.toString('base64'), 'base64'],
      meta: { err: null }, slot: 123 }),
    getAccountInfo: async address => ({ owner: programId,
      data: address === replay ? replayData : ringData }) };
  const finality = createSilverProgressionFinality({ pool, chain, programId,
    issuerAddress: issuer.address });
  const observed = await finality.verify(accountId, operationId, signature);
  assert.equal(observed.status, 'verified');
  assert.equal(observed.intentDigest, candidate.intentDigest);
  replayData[112] ^= 1;
  await assert.rejects(finality.verify(accountId, operationId, signature));
});

test('Silver paid finality requires the exact Gateway operation replay', async () => {
  const user = signer(), issuer = signer();
  const accountId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const reservationId = '33333333-3333-4333-8333-333333333333';
  const programId = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
  const gateway = 'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF';
  const mint = key(4);
  const preparation = { operation_id: operationId, reservation_id: reservationId,
    account_id: accountId, mint_address: mint, wallet_address: user.address,
    cluster: 'devnet', status: 'prepared', reservation_state: 'held',
    response_snapshot: null, current_wallet: user.address,
    expected_level: 4, target_level: 5, ert_cost: '30.000000000000000000',
    eru_principal: '38.000000000', eru_fee: '0.760000000' };
  preparation.request_digest = createHash('sha256').update(JSON.stringify({
    accountId, mint, expectedLevel: 4, targetLevel: 5, cost: '30',
  })).digest('hex');
  const config = Buffer.alloc(330);
  config[0] = 1;
  Buffer.from(bs58.decode(key(12))).copy(config, 33);
  Buffer.from(bs58.decode(key(13))).copy(config, 65);
  Buffer.from(bs58.decode(key(14))).copy(config, 97);
  config.writeBigUInt64LE(1n, 322);
  const candidate = await buildSilverProgressionMessage({ preparation, programId,
    issuerAddress: issuer.address, tokenAddress: key(6), cluster: 'devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    blockhash: key(7), lastValidBlockHeight: 1000,
    gatewayConfigData: config, nonce: 1, expirySlot: 50000 });
  const message = Buffer.from(candidate.messageBase64, 'base64');
  const decoded = getCompiledTransactionMessageDecoder().decode(message);
  const ix = getInstructionsFromCompiledTransactionMessage(decoded)[1];
  const data = Buffer.from(ix.data);
  const replay = await derive(programId, new TextEncoder().encode('silver-progress'),
    Buffer.from(getAddressEncoder().encode(mint)), uuid(operationId));
  const replayData = Buffer.alloc(128);
  replayData.write('ERSPRV1', 0, 'ascii');
  replayData[8] = 4; replayData[9] = 5;
  Buffer.from(getAddressEncoder().encode(mint)).copy(replayData, 16);
  Buffer.from(getAddressEncoder().encode(user.address)).copy(replayData, 48);
  uuid(operationId).copy(replayData, 80);
  uuid(reservationId).copy(replayData, 96);
  uuid(accountId).copy(replayData, 112);
  const ringData = Buffer.alloc(576);
  ringData.write('ERSRGV1', 0, 'ascii');
  Buffer.from(getAddressEncoder().encode(mint)).copy(ringData, 16);
  ringData[290] = 5;
  const u64 = value => { const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
  const gatewayArgs = Buffer.concat([u64(38_000_000_000), data.subarray(59, 75),
    data.subarray(3, 35), Buffer.from(getAddressEncoder().encode(mint)),
    data.subarray(35, 51), data.subarray(1, 3), data.subarray(51, 59),
    Buffer.from([1]), data.subarray(75, 83)]);
  const gatewayState = createHash('sha256').update(gatewayArgs).digest();
  const gatewayReplay = ix.accounts[18].address;
  const userSignature = sign(null, message, user.privateKey);
  const issuerSignature = sign(null, message, issuer.privateKey);
  const raw = Buffer.concat([Buffer.from([2]), userSignature, issuerSignature, message]);
  const submission = { message_base64: candidate.messageBase64,
    issuer_signature_base64: issuerSignature.toString('base64'),
    intent_digest: candidate.intentDigest,
    gateway_config_base64: candidate.gatewayConfigBase64 };
  const pool = { query: async sql => ({ rows: [
    sql.includes('alpha_silver_progression_submissions') ? submission : preparation,
  ] }) };
  const chain = { getGenesisHash: async () => candidate.genesisHash,
    getSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: null }),
    getTransaction: async () => ({ transaction: [raw.toString('base64'), 'base64'],
      meta: { err: null }, slot: 123 }),
    getAccountInfo: async address => address === replay ?
      { owner: programId, data: replayData } : address === gatewayReplay ?
        { owner: gateway, data: gatewayState } :
        { owner: programId, data: ringData } };
  const finality = createSilverProgressionFinality({ pool, chain,
    programId, issuerAddress: issuer.address });
  assert.equal((await finality.verify(accountId, operationId,
    bs58.encode(userSignature))).status, 'verified');
  gatewayState[0] ^= 1;
  await assert.rejects(finality.verify(accountId, operationId,
    bs58.encode(userSignature)));
});
