import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createNoopSigner, createTransactionMessage,
  getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, findExtraAccountMetaListPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { postJsonRpc } from './json-rpc.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DISTRIBUTOR = 'GjQwhUwa1XfwFVicqhJqA2oUHV2GaLrJ7o2GR6b1UzjH';
const VAULT = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
const AMOUNT = 5_000_000_000n;
const ADMIN_MAX_AMOUNT = 50_000_000_000n;
const ADMIN_TOTAL_AMOUNT = 20_000_000_000_000n;
const utf8 = value => new TextEncoder().encode(value);
const decoder = getAddressDecoder();
const encoder = getAddressEncoder();
const raw = value => Buffer.from(encoder.encode(address(value)));
const sha = value => createHash('sha256').update(value).digest();
const pda = async (...seeds) => (await getProgramDerivedAddress({
  programAddress: address(DISTRIBUTOR), seeds,
}))[0];
const meta = (key, role) => ({ address: address(key), role });
const uuid = value => Buffer.from(value.replaceAll('-', ''), 'hex');

// Internal only. There is no HTTP signing endpoint: the caller must revalidate
// the durable Draw result and bound wallet immediately before build.
export function createDrawEruChain({ rpcUrl, attestorKeyPath, adminAttestorKeyPath = null,
  expectedProgramSha256,
  expectedProgramSize, mint, reserve, gatewayProgramId, hook }) {
  if (!rpcUrl?.startsWith('https://') || !attestorKeyPath?.startsWith('/') ||
      !/^[a-f0-9]{64}$/.test(expectedProgramSha256 ?? '') ||
      !Number.isSafeInteger(expectedProgramSize) || expectedProgramSize < 1 ||
      ![mint, reserve, gatewayProgramId, hook].every(key =>
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key ?? '')))
    throw new Error('Draw ERU requires pinned Devnet Distributor and external attestor');
  const keyFile = lstatSync(attestorKeyPath);
  const keyDirectory = lstatSync(dirname(attestorKeyPath));
  if (!keyFile.isFile() || !keyDirectory.isDirectory() ||
      keyFile.uid !== process.getuid?.() || keyDirectory.uid !== process.getuid?.() ||
      (keyFile.mode & 0o077) || (keyDirectory.mode & 0o077))
    throw new Error('Draw ERU attestor file/directory must be private');
  const secret = Buffer.from(JSON.parse(readFileSync(attestorKeyPath, 'utf8')));
  if (secret.length !== 64) throw new Error('Draw ERU attestor key length invalid');
  const key = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32),
  ]), format: 'der', type: 'pkcs8' });
  const attestor = decoder.decode(createPublicKey(key).export({
    format: 'der', type: 'spki',
  }).subarray(-32));
  if (!secret.subarray(32).equals(raw(attestor)) || attestor === VAULT)
    throw new Error('Draw ERU attestor identity invalid');
  secret.fill(0);
  let adminKey = null;
  let adminAttestor = null;
  if (adminAttestorKeyPath !== null) {
    if (!adminAttestorKeyPath.startsWith('/') ||
        adminAttestorKeyPath === attestorKeyPath)
      throw new Error('Separate admin ERU attestor key required');
    const adminFile = lstatSync(adminAttestorKeyPath);
    const adminDirectory = lstatSync(dirname(adminAttestorKeyPath));
    if (!adminFile.isFile() || !adminDirectory.isDirectory() ||
        adminFile.uid !== process.getuid?.() ||
        adminDirectory.uid !== process.getuid?.() ||
        (adminFile.mode & 0o077) || (adminDirectory.mode & 0o077))
      throw new Error('Admin ERU attestor key file/directory must be private');
    const adminSecret = Buffer.from(JSON.parse(readFileSync(adminAttestorKeyPath, 'utf8')));
    if (adminSecret.length !== 64) throw new Error('Admin ERU attestor key length invalid');
    adminKey = createPrivateKey({ key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), adminSecret.subarray(0, 32),
    ]), format: 'der', type: 'pkcs8' });
    adminAttestor = decoder.decode(createPublicKey(adminKey).export({
      format: 'der', type: 'spki',
    }).subarray(-32));
    if (!adminSecret.subarray(32).equals(raw(adminAttestor)) ||
        adminAttestor === VAULT || adminAttestor === attestor)
      throw new Error('Admin ERU attestor identity invalid');
    adminSecret.fill(0);
  }
  let requestId = 0;
  async function rpc(method, params = []) {
    return postJsonRpc({ url: rpcUrl, method, params, id: ++requestId,
      label: 'Draw ERU RPC' });
  }
  async function account(keyAddress) {
    const value = (await rpc('getAccountInfo', [keyAddress,
      { encoding: 'base64', commitment: 'finalized' }])).value;
    return value && { ...value, bytes: Buffer.from(value.data[0], 'base64') };
  }
  async function pinned() {
    if (await rpc('getGenesisHash') !== GENESIS) throw new Error('Draw ERU cluster mismatch');
    const programdataAddress = (await getProgramDerivedAddress({
      programAddress: address(LOADER), seeds: [raw(DISTRIBUTOR)],
    }))[0];
    const config = await pda(utf8('reward-config'));
    const auth = await pda(utf8('reward-draw-auth'));
    const gatewayConfig = (await getProgramDerivedAddress({
      programAddress: address(gatewayProgramId),
      seeds: [utf8('eru-config')],
    }))[0];
    const [program, programdata, configAccount, authAccount] = await Promise.all(
      [DISTRIBUTOR, programdataAddress, config, auth].map(account));
    if (!program?.executable || program.owner !== LOADER ||
        program.bytes.readUInt32LE(0) !== 2 ||
        decoder.decode(program.bytes.subarray(4, 36)) !== programdataAddress ||
        programdata?.owner !== LOADER || programdata.bytes.readUInt32LE(0) !== 3 ||
        programdata.bytes[12] !== 1 ||
        decoder.decode(programdata.bytes.subarray(13, 45)) !== VAULT ||
        programdata.bytes.length < 45 + expectedProgramSize ||
        sha(programdata.bytes.subarray(45, 45 + expectedProgramSize)).toString('hex') !==
          expectedProgramSha256 ||
        !programdata.bytes.subarray(45 + expectedProgramSize).every(byte => byte === 0) ||
        configAccount?.owner !== DISTRIBUTOR || configAccount.bytes.length !== 161 ||
        configAccount.bytes[0] !== 1 ||
        decoder.decode(configAccount.bytes.subarray(1, 33)) !== VAULT ||
        decoder.decode(configAccount.bytes.subarray(33, 65)) !== mint ||
        decoder.decode(configAccount.bytes.subarray(65, 97)) !== reserve ||
        decoder.decode(configAccount.bytes.subarray(97, 129)) !== gatewayConfig ||
        decoder.decode(configAccount.bytes.subarray(129, 161)) !== hook ||
        authAccount?.owner !== DISTRIBUTOR || authAccount.bytes.length !== 33 ||
        authAccount.bytes[0] !== 1 ||
        decoder.decode(authAccount.bytes.subarray(1, 33)) !== attestor)
      throw new Error('Draw ERU Distributor authority/config pin mismatch');
    const reserveInfo = (await rpc('getAccountInfo', [reserve,
      { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
    const reserveState = reserveInfo?.data?.parsed?.info;
    const delegate = await pda(utf8('reward-delegate'));
    if (reserveInfo?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
        reserveState?.owner !== VAULT || reserveState?.mint !== mint ||
        reserveState?.delegate !== delegate ||
        !/^(0|[1-9][0-9]*)$/.test(reserveState?.delegatedAmount?.amount ?? '') ||
        BigInt(reserveState.delegatedAmount.amount) < AMOUNT ||
        !/^(0|[1-9][0-9]*)$/.test(reserveState?.tokenAmount?.amount ?? '') ||
        BigInt(reserveState.tokenAmount.amount) < AMOUNT)
      throw new Error('Draw ERU finite reserve delegate allowance unavailable');
    return { config, auth, gatewayConfig,
      reserveAmount: BigInt(reserveState.tokenAmount.amount),
      delegateAllowance: BigInt(reserveState.delegatedAmount.amount) };
  }
  async function identities(resultId, wallet) {
    const resultBytes = uuid(resultId);
    const nonce = sha(resultBytes).readBigUInt64LE(0) || 1n;
    const nonceBytes = Buffer.alloc(8);
    nonceBytes.writeBigUInt64LE(nonce);
    const [destination] = await findAssociatedTokenPda({
      owner: address(wallet), mint: address(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    return { nonce, destination,
      resultMarker: await pda(utf8('reward-draw-result'), resultBytes),
      payout: await pda(utf8('reward-payout'), nonceBytes),
      delegate: await pda(utf8('reward-delegate')) };
  }
  async function adminIdentities(operationId, wallet) {
    const operationBytes = uuid(operationId);
    const nonce = sha(Buffer.concat([utf8('admin-eru:'), operationBytes]))
      .readBigUInt64LE(0) || 1n;
    const nonceBytes = Buffer.alloc(8);
    nonceBytes.writeBigUInt64LE(nonce);
    const [destination] = await findAssociatedTokenPda({
      owner: address(wallet), mint: address(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    return { nonce, destination,
      adminAuth: await pda(utf8('reward-admin-auth')),
      resultMarker: await pda(utf8('reward-admin-result'), operationBytes),
      payout: await pda(utf8('reward-payout'), nonceBytes),
      delegate: await pda(utf8('reward-delegate')) };
  }
  return {
    attestorAddress: attestor,
    async verifyPinnedProgram() { return pinned(); },
    async adminRemaining() {
      if (!adminAttestor) throw new Error('Admin ERU attestor not configured');
      const ids = await adminIdentities('00000000-0000-4000-8000-000000000001', adminAttestor);
      const admin = await account(ids.adminAuth);
      if (admin?.owner !== DISTRIBUTOR || admin.bytes.length !== 49 ||
          admin.bytes[0] !== 1 ||
          decoder.decode(admin.bytes.subarray(1, 33)) !== adminAttestor ||
          admin.bytes.readBigUInt64LE(41) !== ADMIN_TOTAL_AMOUNT)
        throw new Error('Admin ERU authorization unavailable');
      const spent = admin.bytes.readBigUInt64LE(33);
      if (spent > ADMIN_TOTAL_AMOUNT) throw new Error('Admin ERU budget invalid');
      return ADMIN_TOTAL_AMOUNT - spent;
    },
    async buildAdmin({ operationId, wallet, amountBaseUnits }) {
      if (!adminKey || !adminAttestor)
        throw new Error('Admin ERU attestor not configured');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
          !/^(0|[1-9][0-9]*)$/.test(amountBaseUnits ?? ''))
        throw new Error('Admin ERU operation invalid');
      const amount = BigInt(amountBaseUnits);
      if (amount < 1n || amount > ADMIN_MAX_AMOUNT)
        throw new Error('Admin ERU amount outside approved limit');
      const { config, gatewayConfig, reserveAmount, delegateAllowance } = await pinned();
      if (reserveAmount < amount || delegateAllowance < amount ||
          await this.adminRemaining() < amount)
        throw new Error('Admin ERU reserve or budget unavailable');
      const ids = await adminIdentities(operationId, wallet);
      if (await account(ids.resultMarker) || await account(ids.payout))
        throw new Error('Admin ERU operation already exists; reconcile');
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const slot = Number(await rpc('getSlot', [{ commitment: 'finalized' }]));
      if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('Admin ERU slot invalid');
      const expiry = BigInt(slot + 600);
      const grant = Buffer.alloc(41);
      grant[0] = 6;
      uuid(operationId).copy(grant, 1);
      grant.writeBigUInt64LE(amount, 17);
      grant.writeBigUInt64LE(ids.nonce, 25);
      grant.writeBigUInt64LE(expiry, 33);
      const claim = Buffer.alloc(17);
      claim[0] = 2;
      claim.writeBigUInt64LE(ids.nonce, 1);
      claim.writeBigUInt64LE(amount, 9);
      const [metaList] = await findExtraAccountMetaListPda({ mint: address(mint) },
        { programAddress: address(hook) });
      const ixs = [getSetComputeUnitLimitInstruction({ units: 600_000 }),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: createNoopSigner(address(adminAttestor)), ata: address(ids.destination),
          owner: address(wallet), mint: address(mint),
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        { programAddress: address(DISTRIBUTOR), data: grant, accounts: [
          meta(config, AccountRole.READONLY), meta(ids.adminAuth, AccountRole.WRITABLE),
          meta(ids.resultMarker, AccountRole.WRITABLE),
          meta(ids.payout, AccountRole.WRITABLE),
          meta(adminAttestor, AccountRole.WRITABLE_SIGNER),
          meta(wallet, AccountRole.READONLY), meta(ids.destination, AccountRole.READONLY),
          meta(SYSTEM, AccountRole.READONLY),
        ] },
        { programAddress: address(DISTRIBUTOR), data: claim, accounts: [
          meta(config, AccountRole.READONLY), meta(ids.payout, AccountRole.WRITABLE),
          meta(reserve, AccountRole.WRITABLE), meta(mint, AccountRole.READONLY),
          meta(ids.destination, AccountRole.WRITABLE),
          meta(ids.delegate, AccountRole.READONLY),
          meta(gatewayConfig, AccountRole.READONLY),
          meta(metaList, AccountRole.READONLY), meta(SYSVAR, AccountRole.READONLY),
          meta(TOKEN_2022_PROGRAM_ADDRESS, AccountRole.READONLY),
          meta(hook, AccountRole.READONLY),
        ] }];
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayer(address(adminAttestor), message);
      message = setTransactionMessageLifetimeUsingBlockhash({
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
      }, message);
      message = appendTransactionMessageInstructions(ixs, message);
      const compiled = compileTransactionMessage(message);
      const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
      if (compiled.header.numSignerAccounts !== 1 ||
          compiled.staticAccounts[0] !== adminAttestor)
        throw new Error('Admin ERU unexpected signer graph');
      const signature = sign(null, bytes, adminKey);
      const rawTransactionBase64 = Buffer.concat([
        Buffer.from([1]), signature, bytes,
      ]).toString('base64');
      if (Buffer.from(rawTransactionBase64, 'base64').length > 1232)
        throw new Error('Admin ERU transaction too large');
      const simulation = (await rpc('simulateTransaction', [rawTransactionBase64, {
        encoding: 'base64', commitment: 'confirmed',
        minContextSlot: latest.context.slot, sigVerify: true,
      }])).value;
      if (simulation.err)
        throw new Error(`Admin ERU simulation rejected: ${JSON.stringify(simulation.err)}`);
      return { signature: bs58.encode(signature), rawTransactionBase64,
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
        amountBaseUnits: amountBaseUnits, destination: ids.destination };
    },
    async build({ accountId, resultId, wallet }) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resultId))
        throw new Error('Draw ERU result identity invalid');
      const { config, auth, gatewayConfig } = await pinned();
      const ids = await identities(resultId, wallet);
      if (await account(ids.resultMarker) || await account(ids.payout))
        throw new Error('Draw ERU result/payout already exists; reconcile');
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const slot = Number(await rpc('getSlot', [{ commitment: 'finalized' }]));
      if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('Draw ERU slot invalid');
      const expiry = BigInt(slot + 600);
      const grant = Buffer.alloc(57);
      grant[0] = 4;
      uuid(accountId).copy(grant, 1);
      uuid(resultId).copy(grant, 17);
      grant.writeBigUInt64LE(AMOUNT, 33);
      grant.writeBigUInt64LE(ids.nonce, 41);
      grant.writeBigUInt64LE(expiry, 49);
      const claim = Buffer.alloc(17);
      claim[0] = 2;
      claim.writeBigUInt64LE(ids.nonce, 1);
      claim.writeBigUInt64LE(AMOUNT, 9);
      const [metaList] = await findExtraAccountMetaListPda({ mint: address(mint) },
        { programAddress: address(hook) });
      const ixs = [getSetComputeUnitLimitInstruction({ units: 600_000 }),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: createNoopSigner(address(attestor)), ata: address(ids.destination),
          owner: address(wallet), mint: address(mint),
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        { programAddress: address(DISTRIBUTOR), data: grant, accounts: [
          meta(config, AccountRole.READONLY), meta(auth, AccountRole.READONLY),
          meta(ids.resultMarker, AccountRole.WRITABLE),
          meta(ids.payout, AccountRole.WRITABLE),
          meta(attestor, AccountRole.WRITABLE_SIGNER),
          meta(wallet, AccountRole.READONLY), meta(ids.destination, AccountRole.READONLY),
          meta(SYSTEM, AccountRole.READONLY),
        ] },
        { programAddress: address(DISTRIBUTOR), data: claim, accounts: [
          meta(config, AccountRole.READONLY), meta(ids.payout, AccountRole.WRITABLE),
          meta(reserve, AccountRole.WRITABLE), meta(mint, AccountRole.READONLY),
          meta(ids.destination, AccountRole.WRITABLE),
          meta(ids.delegate, AccountRole.READONLY),
          meta(gatewayConfig, AccountRole.READONLY),
          meta(metaList, AccountRole.READONLY), meta(SYSVAR, AccountRole.READONLY),
          meta(TOKEN_2022_PROGRAM_ADDRESS, AccountRole.READONLY),
          meta(hook, AccountRole.READONLY),
        ] }];
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayer(address(attestor), message);
      message = setTransactionMessageLifetimeUsingBlockhash({
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
      }, message);
      message = appendTransactionMessageInstructions(ixs, message);
      const compiled = compileTransactionMessage(message);
      const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
      if (compiled.header.numSignerAccounts !== 1 ||
          compiled.staticAccounts[0] !== attestor)
        throw new Error('Draw ERU unexpected signer graph');
      const signature = sign(null, bytes, key);
      const rawTransactionBase64 = Buffer.concat([
        Buffer.from([1]), signature, bytes,
      ]).toString('base64');
      const transactionBytes = Buffer.from(rawTransactionBase64, 'base64').length;
      if (transactionBytes > 1232)
        throw new Error(`Atomic Draw ERU transaction too large: ${transactionBytes}`);
      const simulation = (await rpc('simulateTransaction', [rawTransactionBase64, {
        encoding: 'base64', commitment: 'confirmed',
        minContextSlot: latest.context.slot,
        sigVerify: true,
      }])).value;
      if (simulation.err) throw new Error(`Draw ERU simulation rejected: ${JSON.stringify(simulation.err)}`);
      return { signature: bs58.encode(signature), rawTransactionBase64,
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
        amountBaseUnits: AMOUNT.toString(), destination: ids.destination,
        payout: ids.payout, resultMarker: ids.resultMarker,
        transactionBytes,
        unitsConsumed: simulation.unitsConsumed };
    },
    async send(attempt) { return rpc('sendTransaction', [attempt.raw_transaction_base64,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
        maxRetries: 0 }]); },
    async status(signature) { return (await rpc('getSignatureStatuses', [[signature],
      { searchTransactionHistory: true }])).value[0]; },
    async blockHeight() { return rpc('getBlockHeight', [{ commitment: 'finalized' }]); },
    async readAdminFinalized(operationId, wallet, amountBaseUnits, expectedSignature) {
      if (await rpc('getGenesisHash') !== GENESIS)
        throw new Error('Admin ERU cluster mismatch');
      const ids = await adminIdentities(operationId, wallet);
      const [marker, payout, destination] = await Promise.all([
        ids.resultMarker, ids.payout, ids.destination].map(account));
      if (!marker || !payout) return null;
      const amount = BigInt(amountBaseUnits);
      if (marker.owner !== DISTRIBUTOR || marker.bytes.length !== 33 ||
          marker.bytes[0] !== 1 ||
          !marker.bytes.subarray(1, 17).equals(uuid(operationId)) ||
          marker.bytes.readBigUInt64LE(17) !== ids.nonce ||
          marker.bytes.readBigUInt64LE(25) !== amount ||
          payout.owner !== DISTRIBUTOR || payout.bytes.length !== 106 ||
          payout.bytes[0] !== 1 || payout.bytes[105] !== 1 ||
          !payout.bytes.subarray(1, 17).equals(uuid(operationId)) ||
          decoder.decode(payout.bytes.subarray(17, 49)) !== wallet ||
          decoder.decode(payout.bytes.subarray(49, 81)) !== ids.destination ||
          payout.bytes.readBigUInt64LE(81) !== amount ||
          payout.bytes.readBigUInt64LE(89) !== ids.nonce ||
          destination?.owner !== TOKEN_2022_PROGRAM_ADDRESS)
        throw new Error('Admin ERU finalized state mismatch');
      const tx = await rpc('getTransaction', [expectedSignature,
        { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (!tx || tx.meta?.err || !tx.transaction?.signatures?.includes(expectedSignature))
        throw new Error('Admin ERU finalized transaction mismatch');
      const keys = tx.transaction.message.accountKeys.map(entry =>
        typeof entry === 'string' ? entry : entry.pubkey);
      const destinationIndex = keys.indexOf(ids.destination);
      const reserveIndex = keys.indexOf(reserve);
      const before = new Map((tx.meta.preTokenBalances ?? [])
        .filter(value => value.mint === mint)
        .map(value => [value.accountIndex, BigInt(value.uiTokenAmount.amount)]));
      const after = new Map((tx.meta.postTokenBalances ?? [])
        .filter(value => value.mint === mint)
        .map(value => [value.accountIndex, BigInt(value.uiTokenAmount.amount)]));
      const destinationBalance = tx.meta.postTokenBalances?.find(value =>
        value.accountIndex === destinationIndex && value.mint === mint);
      const reserveBalance = tx.meta.postTokenBalances?.find(value =>
        value.accountIndex === reserveIndex && value.mint === mint);
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter(index => (after.get(index) ?? 0n) !== (before.get(index) ?? 0n));
      if (destinationIndex < 0 || reserveIndex < 0 ||
          destinationBalance?.owner !== wallet || reserveBalance?.owner !== VAULT ||
          changed.length !== 2 || !changed.includes(destinationIndex) ||
          !changed.includes(reserveIndex) ||
          after.get(destinationIndex) - (before.get(destinationIndex) ?? 0n) !== amount ||
          after.get(reserveIndex) - (before.get(reserveIndex) ?? 0n) !== -amount)
        throw new Error('Admin ERU exact reserve/recipient delta mismatch');
      return { signature: expectedSignature, destination: ids.destination,
        amountBaseUnits: amountBaseUnits };
    },
    async readFinalized(accountId, resultId, wallet, expectedSignature) {
      if (await rpc('getGenesisHash') !== GENESIS) throw new Error('Draw ERU cluster mismatch');
      const ids = await identities(resultId, wallet);
      const [marker, payout, destination] = await Promise.all([
        ids.resultMarker, ids.payout, ids.destination].map(account));
      if (!marker || !payout) return null;
      if (marker.owner !== DISTRIBUTOR || marker.bytes.length !== 49 ||
          marker.bytes[0] !== 1 ||
          !marker.bytes.subarray(1, 17).equals(uuid(accountId)) ||
          !marker.bytes.subarray(17, 33).equals(uuid(resultId)) ||
          marker.bytes.readBigUInt64LE(33) !== ids.nonce ||
          payout.owner !== DISTRIBUTOR || payout.bytes.length !== 106 ||
          payout.bytes[0] !== 1 || payout.bytes[105] !== 1 ||
          !payout.bytes.subarray(1, 17).equals(uuid(resultId)) ||
          decoder.decode(payout.bytes.subarray(17, 49)) !== wallet ||
          decoder.decode(payout.bytes.subarray(49, 81)) !== ids.destination ||
          payout.bytes.readBigUInt64LE(81) !== AMOUNT ||
          payout.bytes.readBigUInt64LE(89) !== ids.nonce ||
          destination?.owner !== TOKEN_2022_PROGRAM_ADDRESS)
        throw new Error('Draw ERU finalized state mismatch');
      const tx = await rpc('getTransaction', [expectedSignature,
        { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (!tx || tx.meta?.err || !tx.transaction?.signatures?.includes(expectedSignature))
        throw new Error('Draw ERU finalized transaction mismatch');
      const keys = tx.transaction.message.accountKeys.map(entry =>
        typeof entry === 'string' ? entry : entry.pubkey);
      const destinationIndex = keys.indexOf(ids.destination);
      const reserveIndex = keys.indexOf(reserve);
      const before = new Map((tx.meta.preTokenBalances ?? [])
        .filter(value => value.mint === mint)
        .map(value => [value.accountIndex, BigInt(value.uiTokenAmount.amount)]));
      const after = new Map((tx.meta.postTokenBalances ?? [])
        .filter(value => value.mint === mint)
        .map(value => [value.accountIndex, BigInt(value.uiTokenAmount.amount)]));
      const destinationBalance = tx.meta.postTokenBalances?.find(value =>
        value.accountIndex === destinationIndex && value.mint === mint);
      const reserveBalance = tx.meta.postTokenBalances?.find(value =>
        value.accountIndex === reserveIndex && value.mint === mint);
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter(index => (after.get(index) ?? 0n) !== (before.get(index) ?? 0n));
      if (destinationIndex < 0 || reserveIndex < 0 ||
          destinationBalance?.owner !== wallet || reserveBalance?.owner !== VAULT ||
          changed.length !== 2 || !changed.includes(destinationIndex) ||
          !changed.includes(reserveIndex) ||
          after.get(destinationIndex) - (before.get(destinationIndex) ?? 0n) !== AMOUNT ||
          after.get(reserveIndex) - (before.get(reserveIndex) ?? 0n) !== -AMOUNT)
        throw new Error('Draw ERU exact reserve/recipient delta mismatch');
      return { signature: expectedSignature, destination: ids.destination,
        amountBaseUnits: AMOUNT.toString() };
    },
  };
}
