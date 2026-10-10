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
import {
  getInitializeMint2Instruction, getInitializeTransferHookInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

const url = process.env.ALPHA_ERU_PROOF_RPC_URL;
const disposable = process.env.F11_DEVNET_SECRET_DIR;
const payerDir = process.env.ERU_DEVNET_SECRET_DIR;
const resume = process.env.F11_RESUME === '1';
assert(url && disposable && payerDir, 'External Devnet configuration required');
const decode = (bytes) => getAddressDecoder().decode(bytes);
const encode = (value) => getAddressEncoder().encode(address(value));
function key(dir, name) {
  const secret = Buffer.from(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
  assert.equal(secret.length, 64);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
  const signer = { address: decode(createPublicKey(privateKey).export({
    format: 'der', type: 'spki',
  }).subarray(-32)), privateKey };
  secret.fill(0);
  return signer;
}
const payer = key(payerDir, 'payer');
const issuer = key(disposable, 'authority');
const outsider = key(disposable, 'outsider');
const mintSigner = key(disposable, 'mint');
const wrongMintSigner = key(disposable, 'wrong-mint');
const gateway = key(disposable, 'program-gateway').address;
const hook = key(disposable, 'program-hook').address;
const reserve = key(disposable, 'reserve-placeholder').address;
const treasury = key(disposable, 'treasury-placeholder').address;
const system = '11111111111111111111111111111111';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const token = TOKEN_2022_PROGRAM_ADDRESS;
const signers = new Map([payer, issuer, outsider, mintSigner, wrongMintSigner]
  .map((item) => [item.address, item]));
let id = 0;
async function rpc(method, params = []) {
  const response = await fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const [config] = await getProgramDerivedAddress({
  programAddress: address(gateway), seeds: [new TextEncoder().encode('eru-config')],
});
const [meta] = await getProgramDerivedAddress({
  programAddress: address(hook), seeds: [new TextEncoder().encode('extra-account-metas'),
    encode(mintSigner.address)],
});
const [gatewayData] = await getProgramDerivedAddress({
  programAddress: address(loader), seeds: [encode(gateway)],
});
const [hookData] = await getProgramDerivedAddress({
  programAddress: address(loader), seeds: [encode(hook)],
});
const account = async (keyValue) => (await rpc('getAccountInfo', [keyValue,
  { encoding: 'base64', commitment: 'finalized' }])).value;
const digest = (value) => value ? {
  owner: value.owner, length: Buffer.from(value.data[0], 'base64').length,
  sha256: createHash('sha256').update(Buffer.from(value.data[0], 'base64')).digest('hex'),
  lamports: value.lamports,
} : null;
async function snapshot() {
  return { config: digest(await account(config)), meta: digest(await account(meta)),
    mint: digest(await account(mintSigner.address)),
    wrongMint: digest(await account(wrongMintSigner.address)) };
}
function metaAccount(keyValue, writable = false, signer = false) {
  return { address: address(keyValue), role: signer
    ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
    : writable ? AccountRole.WRITABLE : AccountRole.READONLY };
}
function systemTransfer(from, to, lamports) {
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  return { programAddress: address(system), data,
    accounts: [metaAccount(from, true, true), metaAccount(to, true)] };
}
function systemCreate(newAccount, lamports, space, owner) {
  const data = Buffer.alloc(52); data.writeUInt32LE(0, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4); data.writeBigUInt64LE(BigInt(space), 12);
  Buffer.from(encode(owner)).copy(data, 20);
  return { programAddress: address(system), data,
    accounts: [metaAccount(payer.address, true, true), metaAccount(newAccount, true, true)] };
}
function configure(authority = issuer.address, mint = mintSigner.address, configKey = config) {
  return { programAddress: address(gateway), data: Buffer.from([0]), accounts: [
    metaAccount(configKey, true), metaAccount(authority, true, true), metaAccount(mint),
    metaAccount(treasury), metaAccount(hook), metaAccount(reserve),
    metaAccount(gatewayData), metaAccount(system),
  ] };
}
function initializeHook(authority = issuer.address, mint = mintSigner.address,
  configKey = config, metaKey = meta) {
  return { programAddress: address(hook), data: Buffer.from([0xa0]), accounts: [
    metaAccount(metaKey, true), metaAccount(mint), metaAccount(authority, true, true),
    metaAccount(system), metaAccount(configKey), metaAccount(hookData),
  ] };
}
async function transaction(instructions) {
  const { context, value: lifetime } = await rpc('getLatestBlockhash',
    [{ commitment: 'confirmed' }]);
  assert.equal((await rpc('isBlockhashValid', [lifetime.blockhash,
    { commitment: 'confirmed' }])).value, true);
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(payer.address), message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  const compiled = compileTransactionMessage(message);
  const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
  const required = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  const signatures = required.map((value) => {
    const signer = signers.get(value);
    assert(signer, `Unexpected signer ${value}`);
    return sign(null, bytes, signer.privateKey);
  });
  assert(signatures.length < 128);
  return { raw: Buffer.concat([Buffer.from([signatures.length]), ...signatures, bytes])
    .toString('base64'), contextSlot: context.slot,
  lastValidBlockHeight: lifetime.lastValidBlockHeight };
}
async function simulate(label, instructions, expectedProgram, expectedError) {
  const tx = await transaction(instructions);
  const value = (await rpc('simulateTransaction', [tx.raw, {
    encoding: 'base64', commitment: 'confirmed', minContextSlot: tx.contextSlot,
    sigVerify: true, replaceRecentBlockhash: false, innerInstructions: true,
  }])).value;
  console.log(JSON.stringify({ case: label, err: value.err, logs: value.logs,
    unitsConsumed: value.unitsConsumed, innerInstructions: value.innerInstructions }));
  assert(value.err, `${label}: unexpectedly accepted`);
  assert(value.logs?.some((line) => line.includes(`Program ${expectedProgram} invoke`)),
    `${label}: target program was not invoked`);
  if (expectedError === 'InvalidSeeds') {
    assert.deepEqual(value.err, { InstructionError: [0, 'InvalidSeeds'] },
      `${label}: wrong structured RPC error`);
    assert(value.logs?.some((line) => line.startsWith(`Program ${expectedProgram} failed:`)),
      `${label}: target program did not fail`);
  } else {
    assert(value.logs?.some((line) => line.includes(`Program ${expectedProgram} failed: ${expectedError}`)),
      `${label}: wrong failure boundary`);
  }
  return value;
}
async function submit(label, instructions) {
  const tx = await transaction(instructions);
  const signature = await rpc('sendTransaction', [tx.raw, {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
    minContextSlot: tx.contextSlot, maxRetries: 0,
  }]);
  for (;;) {
    const status = (await rpc('getSignatureStatuses', [[signature],
      { searchTransactionHistory: true }])).value[0];
    if (status?.err) throw Error(`${label} ${signature}: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'finalized') {
      console.log(JSON.stringify({ case: label, signature, slot: status.slot }));
      return signature;
    }
    if (await rpc('getBlockHeight', [{ commitment: 'confirmed' }]) >
        tx.lastValidBlockHeight) throw Error(`${label} ${signature}: expiry, inspect status`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
function equal(before, after, label) {
  assert.deepEqual(after, before, `${label}: finalized state changed`);
}
async function initMint(name, mint, mintAuthority) {
  const size = 234;
  const rent = await rpc('getMinimumBalanceForRentExemption', [size]);
  await submit(name, [systemCreate(mint, rent, size, token),
    getInitializeTransferHookInstruction({ mint: address(mint),
      authority: address(issuer.address), programId: address(hook) }),
    getInitializeMint2Instruction({ mint: address(mint), decimals: 9,
      mintAuthority: address(mintAuthority), freezeAuthority: null })]);
  const value = (await rpc('getAccountInfo', [mint,
    { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
  assert.equal(value.owner, token);
  assert.equal(value.data.parsed.info.mintAuthority, mintAuthority);
  assert.equal(value.data.parsed.info.extensions[0].state.authority, issuer.address);
  assert.equal(value.data.parsed.info.extensions[0].state.programId, hook);
}

if (process.env.F11_REPEAT_ONLY === '1') {
  assert.equal(await rpc('getGenesisHash'), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(gateway, 'FSDDeUTQvDg2Umu63nxxna9kvNB1Jjcpxpe3KLBUNhrG');
  assert.equal(hook, 'E7Eo8V8gRfYKCaRj1zBx5cThi9NJJJMZtGiM4v2sZG5L');
  const before = await snapshot();
  assert.equal(before.config?.owner, gateway);
  assert.equal(before.config?.length, 290);
  assert.equal(before.config?.sha256,
    'a01518eac3447aa5f6e181cd0a40232d72629b8ef35e36b5d2ff7280dd4c45bd');
  assert.equal(before.meta?.owner, hook);
  assert.equal(before.meta?.length, 86);
  assert.equal(before.meta?.sha256,
    'c9a20ee3f19adb515f3b17471400e066983e299b807cd7af7698355902a860c4');
  assert.equal(before.mint?.sha256,
    '789d72dea03d7be4aa00188a7d322892f2fcb91e8d5cf39a859d7bc5abc8d4f1');
  assert.equal(before.wrongMint?.sha256,
    '89c21615315b648b416014ca29fcdf927a6da369149d4788128fb507507a209b');
  const configBytes = Buffer.from((await account(config)).data[0], 'base64');
  assert.equal(configBytes[0], 1);
  for (const [offset, expected] of [[1, issuer.address], [33, mintSigner.address],
    [65, treasury], [97, hook], [129, reserve]]) {
    assert.equal(decode(configBytes.subarray(offset, offset + 32)), expected);
  }
  const canonical = {
    config: ['97amFjWUMqwMFY5PVgcWYaTnQQaD4NTayFXvP3ipGDRW',
      '3dc24f1e2532b1a5b083ff42f9633389cf66a9f400878036273508917dd2e09f'],
    mint: ['7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe',
      'b9ff742f942a66d2f65cb0d24ef8274838ab62494d11cd2f93f69835b5ac2cb7'],
    hookMeta: ['2fGDWLUxokVrv6hWWJYH9kYfhrFfrn7GKqpEEAfByKtr',
      '8d1ce5b0b9b24b727b045e9bc958abadab347844086c411ff981b4f609e915e9'],
  };
  for (const [name, [keyValue, expectedHash]] of Object.entries(canonical)) {
    assert.equal(digest(await account(keyValue))?.sha256, expectedHash,
      `${name}: canonical hash changed before simulation`);
  }
  await simulate('repeat Hook init', [initializeHook()], hook, 'InvalidSeeds');
  equal(before, await snapshot(), 'repeat Hook init');
  for (const [name, [keyValue, expectedHash]] of Object.entries(canonical)) {
    assert.equal(digest(await account(keyValue))?.sha256, expectedHash,
      `${name}: canonical hash changed after simulation`);
  }
  console.log(JSON.stringify({ result: 'F11 focused repeat Hook PASS', disposable: before,
    canonicalHashes: Object.fromEntries(Object.entries(canonical)
      .map(([name, [, hash]]) => [name, hash])) }));
} else {
assert.equal(await rpc('getGenesisHash'), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
assert.notEqual(gateway, '81A7VsEBQpKgAagZrHnjE2ntK12poaiVth4i3wQ5thi2');
assert.notEqual(hook, '4HrsQyjt5StEJkhcqeWTLHvYCtDWVrBoeqEcnK5f8pHi');
for (const [program, dataAddress] of [[gateway, gatewayData], [hook, hookData]]) {
  const p = await account(program); const d = await account(dataAddress);
  assert(p?.executable && p.owner === loader);
  assert(d?.owner === loader);
  const bytes = Buffer.from(d.data[0], 'base64');
  assert.equal(bytes.readUInt32LE(0), 3);
  assert.equal(bytes[12], 1);
  assert.equal(decode(bytes.subarray(13, 45)), issuer.address);
}
let before = await snapshot();
if (resume) {
  assert.equal(before.config?.owner, system);
  assert.equal(before.config?.length, 0);
  assert.equal(before.config?.lamports, 650_240);
  assert.equal(before.meta?.owner, system);
  assert.equal(before.meta?.length, 0);
  assert.equal(before.meta?.lamports, 650_240);
  assert.equal(before.mint?.owner, token);
  assert.equal(before.mint?.length, 234);
  assert.equal(before.mint?.sha256,
    '789d72dea03d7be4aa00188a7d322892f2fcb91e8d5cf39a859d7bc5abc8d4f1');
  assert.equal(before.wrongMint?.owner, token);
  assert.equal(before.wrongMint?.sha256,
    '89c21615315b648b416014ca29fcdf927a6da369149d4788128fb507507a209b');
  const required = (await rpc('getMinimumBalanceForRentExemption', [290])) -
    before.config.lamports + (await rpc('getMinimumBalanceForRentExemption', [86])) -
    before.meta.lamports;
  const sourceRentFloor = await rpc('getMinimumBalanceForRentExemption', [0]);
  const minimumBalance = required + sourceRentFloor + 100_000;
  const balance = (await rpc('getBalance', [issuer.address,
    { commitment: 'finalized' }])).value;
  assert.equal(required, 1_910_080);
  assert(balance >= minimumBalance, 'issuer would fall below rent minimum');
  console.log(JSON.stringify({ case: 'resume checkpoint', required,
    sourceRentFloor, minimumBalance, balance, state: before }));
} else {
assert.deepEqual(before, { config: null, meta: null, mint: null, wrongMint: null });
console.log(JSON.stringify({ case: 'disposable identities', gateway, hook, issuer: issuer.address,
  outsider: outsider.address, mint: mintSigner.address, wrongMint: wrongMintSigner.address,
  config, meta, gatewayData, hookData, treasury, reserve, state: before }));
await initMint('valid mint initialized', mintSigner.address, issuer.address);
await initMint('wrong-authority mint initialized', wrongMintSigner.address, outsider.address);
const prefund = await rpc('getMinimumBalanceForRentExemption', [0]);
await submit('fund outsider', [systemTransfer(payer.address, outsider.address, 10_000_000)]);
await submit('prefund config PDA', [systemTransfer(outsider.address, config, prefund)]);
await submit('prefund Hook meta PDA', [systemTransfer(outsider.address, meta, prefund)]);
before = await snapshot();
assert.equal(before.config.owner, system); assert.equal(before.config.length, 0);
assert.equal(before.meta.owner, system); assert.equal(before.meta.length, 0);
console.log(JSON.stringify({ case: 'prefunded pre-init state', state: before }));

await simulate('outsider Gateway first writer', [configure(outsider.address)],
  gateway, 'invalid account data');
equal(before, await snapshot(), 'outsider Gateway first writer');
await simulate('wrong mint authority first init', [configure(issuer.address,
  wrongMintSigner.address)], gateway, 'invalid account data');
equal(before, await snapshot(), 'wrong mint authority first init');
await simulate('noncanonical Gateway config', [configure(issuer.address,
  mintSigner.address, wrongMintSigner.address)], gateway, 'invalid account data');
equal(before, await snapshot(), 'noncanonical Gateway config');
}
await submit('authorized prefunded Gateway init', [configure()]);
let state = await snapshot();
assert.equal(state.config.owner, gateway); assert.equal(state.config.length, 290);
const configBytes = Buffer.from((await account(config)).data[0], 'base64');
assert.equal(configBytes[0], 1);
for (const [offset, expected] of [[1, issuer.address], [33, mintSigner.address],
  [65, treasury], [97, hook], [129, reserve]]) {
  assert.equal(decode(configBytes.subarray(offset, offset + 32)), expected);
}
console.log(JSON.stringify({ case: 'Gateway canonical binding', state }));
await simulate('repeat Gateway init', [configure()], gateway, 'invalid account data');
equal(state, await snapshot(), 'repeat Gateway init');
await simulate('outsider Hook first writer', [initializeHook(outsider.address)],
  hook, 'invalid account data');
equal(state, await snapshot(), 'outsider Hook first writer');
await simulate('wrong Hook mint binding', [initializeHook(issuer.address,
  wrongMintSigner.address)], hook, 'invalid account data');
equal(state, await snapshot(), 'wrong Hook mint binding');
await submit('authorized prefunded Hook init', [initializeHook()]);
state = await snapshot();
assert.equal(state.meta.owner, hook); assert.equal(state.meta.length, 86);
console.log(JSON.stringify({ case: 'Hook canonical binding', state }));
await simulate('repeat Hook init', [initializeHook()], hook, 'InvalidSeeds');
equal(state, await snapshot(), 'repeat Hook init');
console.log(JSON.stringify({ result: 'F11 disposable pre-initialization PASS', state }));
}
