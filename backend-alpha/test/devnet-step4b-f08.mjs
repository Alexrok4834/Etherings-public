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
function loadSigner(name) {
  const secret = Buffer.from(JSON.parse(readFileSync(join(identityDir, `${name}.json`), 'utf8')));
  assert.equal(secret.length, 64);
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
  const addressValue = getAddressDecoder().decode(
    createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
  secret.fill(0);
  return { address: addressValue, key };
}
const userA = loadSigner('upgrade-authority');
const userB = loadSigner('payer');
assert.equal(userA.address, 'GJEKqG4Yc7YSJqpRtbvU9GPz77S52JSKaywu1bgTfFEF');
assert.notEqual(userB.address, userA.address);
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
assert.equal(getAddressDecoder().decode(configData.subarray(1, 33)), userA.address);
assert.equal(getAddressDecoder().decode(configData.subarray(33, 65)), policy.mint);
assert.equal(getAddressDecoder().decode(configData.subarray(65, 97)), policy.treasury);
const reserve = getAddressDecoder().decode(configData.subarray(129, 161));
assert.equal(reserve, 'GopYsDaK3tiaTuRa6gpnw9YGKzc9kQa2cdWbxdnetfu6');
for (const [tokenAccount, owner] of [[reserve, userA.address],
  [policy.destination, userB.address], [policy.source, policy.authority]]) {
  const info = (await rpc('getAccountInfo', [tokenAccount,
    { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
  assert.equal(info?.owner, policy.tokenProgram);
  assert.equal(info.data.parsed.info.mint, policy.mint);
  assert.equal(info.data.parsed.info.owner, owner);
}
for (const user of [userA, userB]) {
  assert((await rpc('getBalance', [user.address,
    { commitment: 'finalized' }])).value > 2_000_000, 'test signer lacks fee SOL');
  [user.replay] = await getProgramDerivedAddress({
    programAddress: address(policy.gateway),
    seeds: [new TextEncoder().encode('nonce'), getAddressEncoder().encode(address(policy.config)),
      getAddressEncoder().encode(address(user.address))],
  });
}
assert.notEqual(userA.replay, userB.replay);

async function snapshot() {
  const balances = {};
  for (const [name, account] of Object.entries({ reserve, recipient: policy.destination,
    boundSource: policy.source, treasury: policy.treasury })) {
    balances[name] = (await rpc('getTokenAccountBalance', [account,
      { commitment: 'finalized' }])).value.amount;
  }
  const config = (await rpc('getAccountInfo', [policy.config,
    { encoding: 'base64', commitment: 'finalized' }])).value;
  const configBytes = Buffer.from(config.data[0], 'base64');
  const replay = {};
  for (const [name, user] of [['A', userA], ['B', userB]]) {
    const info = (await rpc('getAccountInfo', [user.replay,
      { encoding: 'base64', commitment: 'finalized' }])).value;
    assert(!info || info.owner === policy.gateway);
    const data = info ? Buffer.from(info.data[0], 'base64') : null;
    replay[name] = { address: user.replay, owner: info?.owner ?? null,
      nonce: data ? data.readBigUInt64LE(0).toString() : null,
      hash: data ? createHash('sha256').update(data).digest('hex') : null };
  }
  return { balances, config: {
    hash: createHash('sha256').update(configBytes).digest('hex'), stage: configBytes[169],
  }, replay };
}
const fields = [
  ['source', true, false], ['mint', false, false], ['destination', true, false],
  ['treasury', true, false], ['authority', false, true], ['config', true, false],
  ['meta', false, false], ['sysvar', false, false], ['tokenProgram', false, false],
  ['hook', false, false], ['replay', true, false], ['authority', true, true],
  ['systemProgram', false, false],
];
async function transaction(user, source, nonce, amount = 1_000_000_000n) {
  const { context, value: lifetime } = await rpc('getLatestBlockhash',
    [{ commitment: 'confirmed' }]);
  assert.equal((await rpc('isBlockhashValid', [lifetime.blockhash,
    { commitment: 'confirmed' }])).value, true);
  const slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);
  const data = Buffer.alloc(25);
  data[0] = 1;
  data.writeBigUInt64LE(amount, 1);
  data.writeBigUInt64LE(BigInt(nonce), 9);
  data.writeBigUInt64LE(BigInt(slot) + 600n, 17);
  const graph = { ...policy, source, destination: policy.source,
    authority: user.address, replay: user.replay };
  const gateway = { programAddress: address(policy.gateway), data,
    accounts: fields.map(([name, writable, signer]) => ({
      address: address(graph[name]),
      role: signer ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : writable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
  };
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(user.address), message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 600_000 }), gateway,
  ], message);
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(message)));
  assert.equal(bytes[0], 1);
  const signature = sign(null, bytes, user.key);
  assert.equal(signature.length, 64);
  return { raw: Buffer.concat([Buffer.from([1]), signature, bytes]).toString('base64'),
    contextSlot: context.slot, lastValidBlockHeight: lifetime.lastValidBlockHeight,
    authority: user.address, replay: user.replay, source, destination: policy.source,
    principal: amount.toString(), nonce: String(nonce) };
}
async function simulate(tx) {
  return (await rpc('simulateTransaction', [tx.raw, {
    encoding: 'base64', commitment: 'confirmed', minContextSlot: tx.contextSlot,
    sigVerify: true, replaceRecentBlockhash: false, innerInstructions: true,
  }])).value;
}
async function submit(name, tx) {
  const simulated = await simulate(tx);
  console.log(JSON.stringify({ case: `${name} preflight`, error: simulated.err,
    logs: simulated.logs }));
  assert.equal(simulated.err, null, `${name}: preflight rejected`);
  const signature = await rpc('sendTransaction', [tx.raw, {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
    minContextSlot: tx.contextSlot, maxRetries: 0,
  }]);
  for (;;) {
    const status = (await rpc('getSignatureStatuses', [[signature],
      { searchTransactionHistory: true }])).value[0];
    if (status?.err) throw new Error(`${name} ${signature}: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'finalized') {
      console.log(JSON.stringify({ case: `${name} finalized`, signature, slot: status.slot,
        err: status.err }));
      return { signature, slot: status.slot };
    }
    if (await rpc('getBlockHeight', [{ commitment: 'confirmed' }]) >
        tx.lastValidBlockHeight) {
      throw new Error(`${name} ${signature}: expired; inspect status before retry`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
function unchanged(other, before, label) {
  assert.deepEqual(other, before, `${label}: finalized balances/config/replays changed`);
}

const initial = await snapshot();
assert.deepEqual(initial.balances, { reserve: '495000000000', recipient: '35000000000',
  boundSource: '30000000000', treasury: '600000000' });
assert.equal(initial.config.stage, 0);
assert.equal(initial.replay.A.nonce, '1');
assert.equal(initial.replay.B.nonce, null);
console.log(JSON.stringify({ case: 'F08 initial', userA: userA.address,
  userB: userB.address, state: initial }));

// Both ordinary operations must be viable before any new state transition.
for (const [name, tx] of [['B nonce1', await transaction(userB, policy.destination, 1)],
  ['A nonce2', await transaction(userA, reserve, 2)]]) {
  const check = await simulate(tx);
  console.log(JSON.stringify({ case: `${name} viability`, error: check.err,
    logs: check.logs, graph: { authority: tx.authority, source: tx.source,
      destination: tx.destination, replay: tx.replay, nonce: tx.nonce } }));
  assert.equal(check.err, null, `${name}: existing Devnet graph is not viable`);
}
unchanged(await snapshot(), initial, 'viability simulations');

const replayA = await simulate(await transaction(userA, reserve, 1));
console.log(JSON.stringify({ case: 'A reused nonce1', error: replayA.err,
  logs: replayA.logs, unitsConsumed: replayA.unitsConsumed }));
assert.deepEqual(replayA.err, { InstructionError: [1, 'InvalidAccountData'] });
assert((replayA.logs ?? []).some((line) => line.includes(`Program ${policy.gateway} failed:`)));
unchanged(await snapshot(), initial, 'A replay rejection');

const bOne = await submit('B nonce1', await transaction(userB, policy.destination, 1));
const afterBOne = await snapshot();
assert.equal(afterBOne.replay.A.nonce, '1');
assert.equal(afterBOne.replay.B.nonce, '1');
assert.equal(BigInt(afterBOne.balances.recipient) - BigInt(initial.balances.recipient), -1_020_000_000n);
assert.equal(BigInt(afterBOne.balances.boundSource) - BigInt(initial.balances.boundSource), 1_000_000_000n);
assert.equal(BigInt(afterBOne.balances.treasury) - BigInt(initial.balances.treasury), 20_000_000n);
console.log(JSON.stringify({ case: 'after B nonce1', state: afterBOne, signature: bOne.signature }));

const failedB = await simulate(await transaction(userB, reserve, 2));
console.log(JSON.stringify({ case: 'B nonce2 wrong-source-owner', error: failedB.err,
  logs: failedB.logs, unitsConsumed: failedB.unitsConsumed }));
assert.deepEqual(failedB.err, { InstructionError: [1, { Custom: 4 }] });
assert((failedB.logs ?? []).some((line) => line.includes(`Program ${policy.tokenProgram} failed:`)));
unchanged(await snapshot(), afterBOne, 'B failed nonce2');

const bTwo = await submit('B nonce2 after failure',
  await transaction(userB, policy.destination, 2));
const afterBTwo = await snapshot();
assert.equal(afterBTwo.replay.A.nonce, '1');
assert.equal(afterBTwo.replay.B.nonce, '2');
assert.equal(BigInt(afterBTwo.balances.recipient) - BigInt(afterBOne.balances.recipient), -1_020_000_000n);
assert.equal(BigInt(afterBTwo.balances.boundSource) - BigInt(afterBOne.balances.boundSource), 1_000_000_000n);
assert.equal(BigInt(afterBTwo.balances.treasury) - BigInt(afterBOne.balances.treasury), 20_000_000n);
console.log(JSON.stringify({ case: 'after B nonce2', state: afterBTwo, signature: bTwo.signature }));

const aTwo = await submit('A nonce2', await transaction(userA, reserve, 2));
const final = await snapshot();
assert.equal(final.replay.A.nonce, '2');
assert.equal(final.replay.B.nonce, '2');
assert.equal(BigInt(final.balances.reserve) - BigInt(afterBTwo.balances.reserve), -1_020_000_000n);
assert.equal(BigInt(final.balances.boundSource) - BigInt(afterBTwo.balances.boundSource), 1_000_000_000n);
assert.equal(BigInt(final.balances.treasury) - BigInt(afterBTwo.balances.treasury), 20_000_000n);
assert.equal(final.balances.recipient, afterBTwo.balances.recipient);
assert.equal(final.config.stage, 0);
console.log(JSON.stringify({ case: 'F08 PASS', signatures: [bOne.signature, bTwo.signature,
  aTwo.signature], initial, afterBOne, afterBTwo, final }));
