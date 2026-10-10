import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage, getAddressDecoder,
  getCompiledTransactionMessageEncoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getMintToCheckedInstruction } from '@solana-program/token-2022';

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
const configData = Buffer.from(configInfo.data[0], 'base64');
assert.equal(configData.length, 290);
assert.equal(configData[0], 1);
assert.equal(configData[169], 0);
assert.equal(getAddressDecoder().decode(configData.subarray(1, 33)), issuer);
assert.equal(getAddressDecoder().decode(configData.subarray(33, 65)), policy.mint);
assert.equal(getAddressDecoder().decode(configData.subarray(65, 97)), policy.treasury);
assert.equal(getAddressDecoder().decode(configData.subarray(97, 129)), policy.hook);
const sourceInfo = (await rpc('getAccountInfo', [policy.source,
  { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
assert.equal(sourceInfo?.owner, policy.tokenProgram);
assert.equal(sourceInfo.data.parsed.info.mint, policy.mint);
assert.equal(sourceInfo.data.parsed.info.owner, policy.authority);
const mintInfo = (await rpc('getAccountInfo', [policy.mint,
  { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
assert.equal(mintInfo?.owner, policy.tokenProgram);
assert.equal(mintInfo.data.parsed.info.decimals, 9);
assert.equal(mintInfo.data.parsed.info.mintAuthority, issuer);
const replayInfo = (await rpc('getAccountInfo', [policy.replay,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(replayInfo?.owner, policy.gateway);
assert.equal(Buffer.from(replayInfo.data[0], 'base64').readBigUInt64LE(0), 1n);
assert(Number((await rpc('getBalance', [issuer,
  { commitment: 'finalized' }])).value) > 2_000_000, 'test authority lacks fee SOL');

async function snapshot() {
  const balances = {};
  for (const name of ['source', 'destination', 'treasury']) {
    balances[name] = (await rpc('getTokenAccountBalance', [policy[name],
      { commitment: 'finalized' }])).value.amount;
  }
  const hashes = {};
  for (const name of ['config', 'replay']) {
    const info = (await rpc('getAccountInfo', [policy[name],
      { encoding: 'base64', commitment: 'finalized' }])).value;
    hashes[name] = createHash('sha256').update(Buffer.from(info.data[0], 'base64'))
      .digest('hex');
  }
  return { balances, hashes };
}

async function compile(instructions, feePayer) {
  const { context, value: lifetime } = await rpc('getLatestBlockhash',
    [{ commitment: 'confirmed' }]);
  assert.equal((await rpc('isBlockhashValid', [lifetime.blockhash,
    { commitment: 'confirmed' }])).value, true);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(feePayer), message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  return { bytes: Buffer.from(getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(message))), contextSlot: context.slot,
  lastValidBlockHeight: lifetime.lastValidBlockHeight };
}
function signedRaw(message, issuerSigns) {
  assert.equal(message.bytes[0], 1);
  const signature = issuerSigns ? sign(null, message.bytes, privateKey) : Buffer.alloc(64);
  assert.equal(signature.length, 64);
  return Buffer.concat([Buffer.from([1]), signature, message.bytes]).toString('base64');
}

const initial = await snapshot();
assert(['0', '30000000000'].includes(initial.balances.source),
  'fee-leg setup requires zero or exactly 30 ERU on sender');
assert.equal(initial.balances.destination, '35000000000');
assert.equal(initial.balances.treasury, '600000000');
assert.equal(initial.hashes.config,
  '6081ee28e684c1816c603ec7738e8f0f20cb1ed9f17f0683d34c26eda969bae1');
if (initial.balances.source === '0') {
const mintTemplate = getMintToCheckedInstruction({
  mint: address(policy.mint), token: address(policy.source),
  mintAuthority: address(issuer), amount: 30_000_000_000n, decimals: 9,
});
const mintInstruction = { ...mintTemplate, accounts: mintTemplate.accounts.map((meta, index) =>
  index === 2 ? { ...meta, role: AccountRole.READONLY_SIGNER } : meta) };
const mintTx = await compile([mintInstruction], issuer);
const mintRaw = signedRaw(mintTx, true);
const mintSimulation = (await rpc('simulateTransaction', [mintRaw, {
  encoding: 'base64', commitment: 'confirmed', minContextSlot: mintTx.contextSlot,
  sigVerify: true, replaceRecentBlockhash: false, innerInstructions: true,
}])).value;
console.log(JSON.stringify({ case: 'exact 30 ERU test funding preflight', error: mintSimulation.err,
  logs: mintSimulation.logs }));
assert.equal(mintSimulation.err, null, 'test-only funding preflight failed; do not send');
const fundingSignature = await rpc('sendTransaction', [mintRaw, {
  encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
  minContextSlot: mintTx.contextSlot, maxRetries: 0,
}]);
let finalized;
for (;;) {
  const status = (await rpc('getSignatureStatuses', [[fundingSignature],
    { searchTransactionHistory: true }])).value[0];
  if (status?.err) throw new Error(`funding ${fundingSignature}: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === 'finalized') { finalized = status; break; }
  if (await rpc('getBlockHeight', [{ commitment: 'confirmed' }]) >
      mintTx.lastValidBlockHeight) {
    throw new Error(`funding ${fundingSignature}: expiry; inspect before retry`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
const funded = await snapshot();
assert.equal(funded.balances.source, '30000000000');
assert.equal(funded.balances.destination, initial.balances.destination);
assert.equal(funded.balances.treasury, initial.balances.treasury);
assert.deepEqual(funded.hashes, initial.hashes);
console.log(JSON.stringify({ case: 'exact 30 ERU test funding finalized',
  signature: fundingSignature, slot: finalized.slot, initial, after: funded }));
}
const before = await snapshot();
assert.equal(before.balances.source, '30000000000');

const slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);
const data = Buffer.alloc(25);
data[0] = 1;
data.writeBigUInt64LE(30_000_000_000n, 1);
data.writeBigUInt64LE(2n, 9);
data.writeBigUInt64LE(BigInt(slot) + 600n, 17);
const ordered = [
  ['source', true, false], ['mint', false, false], ['destination', true, false],
  ['treasury', true, false], ['authority', false, true], ['config', true, false],
  ['meta', false, false], ['sysvar', false, false], ['tokenProgram', false, false],
  ['hook', false, false], ['replay', true, false],
  ['authority', true, true], ['systemProgram', false, false],
];
const graph = policy;
const gatewayInstruction = {
  programAddress: address(policy.gateway), data,
  accounts: ordered.map(([name, writable, signer]) => ({
    address: address(graph[name]),
    role: signer ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
      : writable ? AccountRole.WRITABLE : AccountRole.READONLY,
  })),
};
const gatewayTx = await compile([
  getSetComputeUnitLimitInstruction({ units: 600_000 }), gatewayInstruction,
], policy.authority);
const gatewayRaw = signedRaw(gatewayTx, false);
console.log(JSON.stringify({ case: 'fee-leg context',
  programs: ['ComputeBudget111111111111111111111111111111', policy.gateway],
  orderedAccounts: ordered.map(([name, writable, signer]) => ({
    name, address: graph[name], writable, signer,
  })), principal: '30000000000', expectedFee: '600000000', nonce: '2',
  feePayer: policy.authority, userSignature: 'not supplied; simulation only' }));
const simulated = (await rpc('simulateTransaction', [gatewayRaw, {
  encoding: 'base64', commitment: 'confirmed', minContextSlot: gatewayTx.contextSlot,
  sigVerify: false, replaceRecentBlockhash: false, innerInstructions: true,
}])).value;
console.log(JSON.stringify({ case: 'missing additive fee balance', error: simulated.err,
  logs: simulated.logs, unitsConsumed: simulated.unitsConsumed,
  innerInstructions: simulated.innerInstructions }));
assert.deepEqual(simulated.err, { InstructionError: [1, { Custom: 1 }] });
const logs = simulated.logs ?? [];
const tokenSuccess = logs.findIndex((line) => line === `Program ${policy.tokenProgram} success`);
const secondTokenInvoke = logs.findIndex((line, index) =>
  index > tokenSuccess && line.includes(`Program ${policy.tokenProgram} invoke [2]`));
assert(tokenSuccess >= 0 && secondTokenInvoke > tokenSuccess,
  'principal leg did not succeed before mandatory fee leg');
assert(logs.some((line) => line.toLowerCase().includes('insufficient funds')),
  'fee leg failed for unrelated reason');
assert(logs.some((line) => line.includes(`Program ${policy.hook} invoke [3]`)),
  'principal leg did not reach Hook');
const after = await snapshot();
assert.deepEqual(after, before, 'rejected fee-leg simulation changed finalized state');
console.log(JSON.stringify({ case: 'fee-leg atomicity PASS', before, after,
  rejectedTransactionSubmitted: false }));
