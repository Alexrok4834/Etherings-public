import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransaction, createTransactionMessage, getAddressDecoder,
  getAddressEncoder, getProgramDerivedAddress, getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token-2022';

const rpcUrl = process.env.ALPHA_ERU_PROOF_RPC_URL;
const policyFile = process.env.ALPHA_ERU_PROOF_POLICY_FILE;
assert(rpcUrl && policyFile, 'External Devnet RPC and policy required');
const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
assert.equal(policy.cluster, 'devnet');
assert.equal(policy.mint, '7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe');
let requestId = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  assert.equal(response.status, 200, `${method}: HTTP status`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
assert.equal(await rpc('getGenesisHash', []),
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const configInfo = (await rpc('getAccountInfo', [policy.config,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(configInfo?.owner, policy.gateway);
const configBytes = Buffer.from(configInfo.data[0], 'base64');
assert.equal(configBytes.length, 290);
const decodeAddress = getAddressDecoder();
const issuer = decodeAddress.decode(configBytes.subarray(1, 33));
const reserve = decodeAddress.decode(configBytes.subarray(129, 161));
const [expectedMeta] = await getProgramDerivedAddress({
  programAddress: address(policy.hook),
  seeds: [new TextEncoder().encode('extra-account-metas'),
    getAddressEncoder().encode(address(policy.mint))],
});
assert.equal(expectedMeta, policy.meta, 'Hook MetaList PDA mismatch');
const replayInfo = (await rpc('getAccountInfo', [policy.replay,
  { encoding: 'base64', commitment: 'finalized' }])).value;
assert.equal(replayInfo?.owner, policy.gateway);

async function snapshot() {
  const balances = {};
  for (const [name, account] of Object.entries({ reserve,
    recipient: policy.destination, treasury: policy.treasury })) {
    balances[name] = (await rpc('getTokenAccountBalance', [account,
      { commitment: 'finalized' }])).value.amount;
  }
  const config = (await rpc('getAccountInfo', [policy.config,
    { encoding: 'base64', commitment: 'finalized' }])).value;
  const replay = (await rpc('getAccountInfo', [policy.replay,
    { encoding: 'base64', commitment: 'finalized' }])).value;
  return { balances,
    configSha256: createHash('sha256').update(Buffer.from(config.data[0], 'base64')).digest('hex'),
    replaySha256: createHash('sha256').update(Buffer.from(replay.data[0], 'base64')).digest('hex') };
}
const before = await snapshot();
const { context, value: lifetime } = await rpc('getLatestBlockhash',
  [{ commitment: 'confirmed' }]);
assert.equal((await rpc('isBlockhashValid', [lifetime.blockhash,
  { commitment: 'confirmed' }])).value, true);

const tokenInstruction = getTransferCheckedInstruction({
  source: address(reserve), mint: address(policy.mint),
  destination: address(policy.destination), authority: address(issuer),
  amount: 1_000_000_000n, decimals: 9,
});
const extras = ['meta', 'sysvar', 'config', 'hook'].map((field) => ({
  address: address(policy[field]), role: AccountRole.READONLY,
}));
const transfer = { ...tokenInstruction,
  accounts: [...tokenInstruction.accounts, ...extras] };
let message = createTransactionMessage({ version: 'legacy' });
message = setTransactionMessageFeePayer(address(issuer), message);
message = setTransactionMessageLifetimeUsingBlockhash({
  blockhash: lifetime.blockhash,
  lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
}, message);
message = appendTransactionMessageInstructions([
  getSetComputeUnitLimitInstruction({ units: 600_000 }), transfer,
], message);
const unsigned = compileTransaction(message);
assert.deepEqual(Object.keys(unsigned.signatures), [issuer]);
const serialized = getTransactionEncoder().encode({ ...unsigned,
  signatures: { [issuer]: new Uint8Array(64) },
});
const simulated = await rpc('simulateTransaction', [
  Buffer.from(serialized).toString('base64'),
  { encoding: 'base64', commitment: 'confirmed', minContextSlot: context.slot,
    sigVerify: false, replaceRecentBlockhash: false, innerInstructions: true },
]);

const parsed = {};
for (const [name, account] of Object.entries({ reserve,
  destination: policy.destination, mint: policy.mint })) {
  const info = (await rpc('getAccountInfo', [account,
    { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
  parsed[name] = { programOwner: info?.owner, data: info?.data?.parsed };
}
const meta = (await rpc('getAccountInfo', [policy.meta,
  { encoding: 'base64', commitment: 'finalized' }])).value;
const after = await snapshot();
const logs = simulated.value.logs ?? [];
assert.deepEqual(simulated.value.err,
  { InstructionError: [1, 'InvalidAccountData'] });
assert(logs.some((line) => line.includes(`Program ${transfer.programAddress} invoke [1]`)));
assert(logs.some((line) => line.includes(`Program ${policy.hook} invoke [2]`)));
assert(logs.some((line) => line.includes(`Program ${policy.hook} failed: invalid account data`)));
assert.equal(configBytes[169], 0, 'Gateway pending stage is not idle');
assert.notEqual(decodeAddress.decode(configBytes.subarray(170, 202)), reserve);
assert.notEqual(decodeAddress.decode(configBytes.subarray(234, 266)), issuer);
assert.equal(parsed.reserve.programOwner, transfer.programAddress);
assert.equal(parsed.destination.programOwner, transfer.programAddress);
assert.equal(parsed.reserve.data.info.mint, policy.mint);
assert.equal(parsed.destination.data.info.mint, policy.mint);
assert.equal(parsed.mint.data.info.extensions.find((extension) =>
  extension.extension === 'transferHook')?.state.programId, policy.hook);
assert.equal(meta?.owner, policy.hook);
assert.equal(Buffer.from(meta.data[0], 'base64').length, 86);
assert.deepEqual(after, before, 'Protected Devnet state changed');
console.log(JSON.stringify({
  simulation: {
    err: simulated.value.err, logs,
    innerInstructions: simulated.value.innerInstructions,
    unitsConsumed: simulated.value.unitsConsumed,
    contextSlot: simulated.context.slot,
    invocations: logs.filter((line) => /Program .* (invoke|success|failed)/.test(line)),
  },
  transaction: {
    feePayer: issuer,
    programs: ['ComputeBudget111111111111111111111111111111', transfer.programAddress],
    transferAccounts: transfer.accounts.map((accountMeta, index) => ({
      index, address: accountMeta.address, role: accountMeta.role,
    })),
    tokenDataHex: Buffer.from(transfer.data).toString('hex'),
  },
  accounts: {
    reserve: parsed.reserve, destination: parsed.destination, mint: parsed.mint,
    extraMeta: { owner: meta?.owner, length: Buffer.from(meta?.data?.[0] ?? '', 'base64').length,
      base64: meta?.data?.[0], sha256: createHash('sha256')
        .update(Buffer.from(meta?.data?.[0] ?? '', 'base64')).digest('hex') },
    configOwner: configInfo.owner, replayOwner: replayInfo.owner,
  },
  state: { before, after, unchanged: true, pendingStage: configBytes[169],
    pendingSourceEqualsReserve: false, pendingUserEqualsIssuer: false },
}, null, 2));
