import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressDecoder,
  getAddressEncoder, getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';

const rpcUrl = process.env.ALPHA_ERU_PROOF_RPC_URL;
const policyFile = process.env.ALPHA_ERU_PROOF_POLICY_FILE;
const identityDir = process.env.ERU_DEVNET_SECRET_DIR;
assert(rpcUrl && policyFile && identityDir, 'External Devnet configuration required');
const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
assert.equal(policy.cluster, 'devnet');
assert.equal(policy.mint, '7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe');
const secret = Buffer.from(JSON.parse(readFileSync(join(identityDir, 'upgrade-authority.json'), 'utf8')));
assert.equal(secret.length, 64);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]),
  format: 'der', type: 'pkcs8',
});
const issuer = getAddressDecoder().decode(
  createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
assert.equal(issuer, 'GJEKqG4Yc7YSJqpRtbvU9GPz77S52JSKaywu1bgTfFEF');
secret.fill(0);
let id = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
assert.equal(await rpc('getGenesisHash', []), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const configInfo = (await rpc('getAccountInfo', [policy.config,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(configInfo?.owner, policy.gateway);
const configBytes = Buffer.from(configInfo.data[0], 'base64');
assert.equal(configBytes.length, 290);
assert.equal(configBytes[0], 1);
assert.equal(configBytes[169], 0);
assert.equal(getAddressDecoder().decode(configBytes.subarray(1, 33)), issuer);
assert.equal(getAddressDecoder().decode(configBytes.subarray(33, 65)), policy.mint);
assert.equal(getAddressDecoder().decode(configBytes.subarray(65, 97)), policy.treasury);
const reserve = getAddressDecoder().decode(configBytes.subarray(129, 161));
assert.equal(reserve, 'GopYsDaK3tiaTuRa6gpnw9YGKzc9kQa2cdWbxdnetfu6');
const [issuerReplay] = await getProgramDerivedAddress({
  programAddress: address(policy.gateway),
  seeds: [new TextEncoder().encode('nonce'), getAddressEncoder().encode(address(policy.config)),
    getAddressEncoder().encode(address(issuer))],
});

async function snapshot() {
  const balances = {};
  for (const [name, account] of Object.entries({ reserve, recipient: policy.destination,
    treasury: policy.treasury, ordinarySource: policy.source })) {
    balances[name] = (await rpc('getTokenAccountBalance', [account,
      { commitment: 'finalized' }])).value.amount;
  }
  const hashes = {};
  for (const [name, account] of Object.entries({ config: policy.config,
    issuerReplay, userReplay: policy.replay })) {
    const info = (await rpc('getAccountInfo', [account,
      { encoding: 'base64', commitment: 'finalized' }])).value;
    hashes[name] = info ? createHash('sha256').update(Buffer.from(info.data[0], 'base64'))
      .digest('hex') : null;
  }
  return { balances, hashes };
}

const fields = [
  ['source', true, false], ['mint', false, false], ['destination', true, false],
  ['treasury', true, false], ['authority', false, true], ['config', true, false],
  ['meta', false, false], ['sysvar', false, false], ['tokenProgram', false, false],
  ['hook', false, false], ['replay', true, false], ['authority', true, true],
  ['systemProgram', false, false],
];
async function transaction(source, nonce) {
  const { context, value: lifetime } = await rpc('getLatestBlockhash',
    [{ commitment: 'confirmed' }]);
  assert.equal((await rpc('isBlockhashValid', [lifetime.blockhash,
    { commitment: 'confirmed' }])).value, true);
  const slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);
  const data = Buffer.alloc(25);
  data[0] = 2;
  data.writeBigUInt64LE(5_000_000_000n, 1);
  data.writeBigUInt64LE(nonce, 9);
  data.writeBigUInt64LE(BigInt(slot) + 600n, 17);
  const account = { ...policy, source, authority: issuer, replay: issuerReplay };
  const gateway = {
    programAddress: address(policy.gateway), data,
    accounts: fields.map(([field, writable, signer]) => ({
      address: address(account[field]),
      role: signer ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : writable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
  };
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(issuer), message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 600_000 }), gateway,
  ], message);
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(message)));
  const signature = sign(null, bytes, privateKey);
  assert.equal(signature.length, 64);
  return { raw: Buffer.concat([Buffer.from([1]), signature, bytes]).toString('base64'),
    contextSlot: context.slot, lastValidBlockHeight: lifetime.lastValidBlockHeight };
}
async function simulate(tx) {
  return (await rpc('simulateTransaction', [tx.raw, {
    encoding: 'base64', commitment: 'confirmed', minContextSlot: tx.contextSlot,
    sigVerify: true, replaceRecentBlockhash: false, innerInstructions: true,
  }])).value;
}

const before = await snapshot();
assert.equal(before.balances.reserve, '500000000000');
assert.equal(before.balances.recipient, '30000000000');
assert.equal(before.balances.treasury, '600000000');
assert.equal(before.balances.ordinarySource, '0');
assert.equal(before.hashes.issuerReplay, null, 'issuer reward nonce already used');
const negative = await simulate(await transaction(policy.source, 1n));
console.log(JSON.stringify({ case: 'ordinary-source reward exemption', error: negative.err,
  logs: negative.logs, unitsConsumed: negative.unitsConsumed }));
assert.deepEqual(negative.err, { InstructionError: [1, 'InvalidAccountData'] });
assert(negative.logs.some((line) => line.includes(`Program ${policy.gateway} failed:`)));
assert.deepEqual(await snapshot(), before, 'negative simulation changed finalized state');

const positiveTx = await transaction(reserve, 1n);
const positive = await simulate(positiveTx);
console.log(JSON.stringify({ case: 'authorized reserve reward preflight', error: positive.err,
  logs: positive.logs, unitsConsumed: positive.unitsConsumed }));
assert.equal(positive.err, null, 'authorized reward simulation failed; do not send');
const signature = await rpc('sendTransaction', [positiveTx.raw, {
  encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
  minContextSlot: positiveTx.contextSlot, maxRetries: 0,
}]);
console.log(JSON.stringify({ case: 'authorized reserve reward submitted', signature }));
let finalized;
for (;;) {
  const status = (await rpc('getSignatureStatuses', [[signature],
    { searchTransactionHistory: true }])).value[0];
  if (status?.err) throw new Error(`reward ${signature}: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === 'finalized') { finalized = status; break; }
  if (await rpc('getBlockHeight', [{ commitment: 'confirmed' }]) >
      positiveTx.lastValidBlockHeight) {
    throw new Error(`reward ${signature}: expiry reached before finalized; inspect before retry`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
const after = await snapshot();
assert.equal(BigInt(after.balances.reserve) - BigInt(before.balances.reserve), -5_000_000_000n);
assert.equal(BigInt(after.balances.recipient) - BigInt(before.balances.recipient), 5_000_000_000n);
assert.equal(after.balances.treasury, before.balances.treasury);
assert.equal(after.balances.ordinarySource, before.balances.ordinarySource);
assert.equal(after.hashes.userReplay, before.hashes.userReplay);
const replayInfo = (await rpc('getAccountInfo', [issuerReplay,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(replayInfo?.owner, policy.gateway);
assert.equal(Buffer.from(replayInfo.data[0], 'base64').readBigUInt64LE(0), 1n);
const finalConfig = (await rpc('getAccountInfo', [policy.config,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(Buffer.from(finalConfig.data[0], 'base64')[169], 0,
  'Gateway config was not returned to idle stage');
console.log(JSON.stringify({ case: 'authorized reserve reward finalized', signature,
  slot: finalized.slot, before, after, issuerReplay }));
