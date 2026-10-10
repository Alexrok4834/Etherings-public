import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransactionMessage,
  createNoopSigner, createSolanaRpc, createTransactionMessage, getAddressDecoder, getAddressEncoder,
  getBase64Decoder, getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda, findExtraAccountMetaListPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token-2022';
import { createSilverChainReader } from './silver-chain.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const ORAO = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const BUDGET = 'ComputeBudget111111111111111111111111111111';
const UPGRADE_AUTHORITY = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER;
const meta = (key, role) => ({ address: address(key), role });
const rawAddress = key => Buffer.from(getAddressEncoder().encode(address(key)));
const decodeAddress = bytes => getAddressDecoder().decode(bytes);
const seed = text => Buffer.from(text, 'ascii');
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createSilverKeeperChain({ rpcUrl, programId, payerKeyPath,
  expectedProgramSha256, expectedProgramSize }) {
  if (!rpcUrl?.startsWith('https://') || programId !== PROGRAM || !payerKeyPath?.startsWith('/') ||
      !/^[a-f0-9]{64}$/.test(expectedProgramSha256 ?? '') ||
      !Number.isSafeInteger(expectedProgramSize) || expectedProgramSize < 1)
    throw new Error('Silver keeper requires pinned Devnet program and external payer file');
  const secret = Buffer.from(JSON.parse(readFileSync(payerKeyPath, 'utf8')));
  assert.equal(secret.length, 64);
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32),
  ]), format: 'der', type: 'pkcs8' });
  const payerAddress = decodeAddress(createPublicKey(privateKey).export({
    format: 'der', type: 'spki',
  }).subarray(-32));
  assert.deepEqual(secret.subarray(32), rawAddress(payerAddress));
  secret.fill(0);
  assert.equal(payerAddress, '8GDQdaWsnCHinqwaSD3E6d2WbpFr2xVWa8FqF9n9w23G');
  const rpc = createSolanaRpc(rpcUrl);
  const reader = createSilverChainReader(rpcUrl);
  const account = async key => (await rpc.getAccountInfo(address(key), {
    encoding: 'base64', commitment: 'finalized',
  }).send()).value;
  const bytes = value => Buffer.from(value.data[0], 'base64');

  const identities = async row => {
    const mint = row.mint_address;
    const number = Buffer.alloc(8); number.writeBigUInt64LE(BigInt(row.next_operation));
    const designVersion = Buffer.alloc(8);
    designVersion.writeBigUInt64LE(BigInt(row.design_version));
    const requestSeed = Buffer.from(row.seed_hex, 'hex');
    const operation = await pda(PROGRAM, seed('silver-open'), rawAddress(mint), number);
    const request = await pda(ORAO, seed('orao-vrf-randomness-request'), requestSeed);
    const ringMint = await pda(PROGRAM, seed('silver-ring-mint'), rawAddress(mint),
      rawAddress(operation));
    const [ringToken] = await findAssociatedTokenPda({ mint: address(ringMint),
      owner: address(row.wallet_address), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [ringMetas] = await findExtraAccountMetaListPda({ mint: address(ringMint) },
      { programAddress: address(PROGRAM) });
    return { operation, request, ringMint, ringToken, ringMetas,
      series: await pda(PROGRAM, seed('silver-nft-series'), Buffer.from([2]), Buffer.from([1])),
      ringState: await pda(PROGRAM, seed('silver-ring-state'), rawAddress(ringMint)),
      lifecycle: await pda(PROGRAM, seed('silver-lifecycle'), rawAddress(mint)),
      state: await pda(PROGRAM, seed('silver-state'), rawAddress(mint)),
      escrowAuthority: await pda(PROGRAM, seed('silver-escrow'), rawAddress(mint)),
      config: await pda(PROGRAM, seed('silver-config')),
      collection: await pda(PROGRAM, seed('silver-collection')),
      authority: await pda(PROGRAM, seed('silver-authority')),
      design: await pda(PROGRAM, seed('silver-design-set'), designVersion),
      requestSeed };
  };

  const inspect = async row => {
    assert.equal(row.cluster, 'devnet');
    assert.equal(row.genesis_hash, GENESIS);
    assert.equal(row.program_id, PROGRAM);
    assert.equal(await rpc.getGenesisHash().send(), GENESIS);
    const pd = await pda(LOADER, rawAddress(PROGRAM));
    const programData = await account(pd);
    assert.equal(programData?.owner, LOADER);
    assert.equal(decodeAddress(bytes(programData).subarray(13, 45)), UPGRADE_AUTHORITY);
    assert.equal(hash(bytes(programData).subarray(45, 45 + expectedProgramSize)),
      expectedProgramSha256);
    assert(bytes(programData).subarray(45 + expectedProgramSize).every(byte => byte === 0));
    const id = await identities(row);
    const [op, life, req, ring] = await Promise.all(
      [id.operation, id.lifecycle, id.request, id.ringMint].map(account));
    assert.equal(op?.owner, PROGRAM);
    assert.equal(life?.owner, PROGRAM);
    assert.equal(req?.owner, ORAO);
    const o = bytes(op), l = bytes(life), q = bytes(req);
    assert.equal(o.length, 320);
    assert(o.subarray(0, 8).equals(Buffer.from('ERSOPV1\0')));
    assert.equal(o[8], 1);
    assert.equal(o.readBigUInt64LE(16), BigInt(row.next_operation));
    assert.equal(decodeAddress(o.subarray(24, 56)), row.mint_address);
    assert.equal(decodeAddress(o.subarray(56, 88)), row.wallet_address);
    assert.equal(decodeAddress(o.subarray(88, 120)), row.escrow_address);
    assert.equal(decodeAddress(o.subarray(120, 152)), id.request);
    assert(o.subarray(152, 184).equals(id.requestSeed));
    assert.equal(decodeAddress(o.subarray(184, 216)), id.design);
    assert.equal(o.readBigUInt64LE(216), BigInt(row.design_version));
    assert.equal(o.subarray(226, 258).toString('hex'), row.design_commitment);
    assert.equal(l.length, 128);
    assert(l.subarray(0, 8).equals(Buffer.from('ERSBLV1\0')));
    assert.equal(decodeAddress(l.subarray(16, 48)), row.mint_address);
    assert.equal(l.readBigUInt64LE(48), BigInt(row.next_operation) + 1n);
    assert.equal(decodeAddress(l.subarray(56, 88)), id.operation);
    assert.equal(q.subarray(0, 8).toString('hex'), hash(seed('account:RandomnessV2')).slice(0, 16));
    assert.equal(decodeAddress(q.subarray(9, 41)), row.wallet_address);
    assert(q.subarray(41, 73).equals(id.requestSeed));
    if (o[9] === 2 && l[9] === 2) {
      assert.equal(decodeAddress(o.subarray(266, 298)), id.ringMint);
      assert.equal(decodeAddress(l.subarray(88, 120)), id.ringMint);
      const finalizedRing = await reader.readRingForIssuance({ programId: PROGRAM,
        cluster: 'devnet', issuanceId: row.issuance_id,
        walletAddress: row.wallet_address });
      assert.equal(finalizedRing?.mintAddress, id.ringMint);
      assert.equal(finalizedRing.boxMint, row.mint_address);
      assert.equal(finalizedRing.accountId, row.account_id);
      return { ...id, phase: 'consumed', fulfilled: true };
    }
    assert.equal(o[9], 1);
    assert.equal(l[9], 1);
    assert.equal(ring, null);
    const validEscrow = await reader.readOpeningInventory({ programId: PROGRAM,
      mintAddress: row.mint_address, walletAddress: row.wallet_address,
      sourceTokenAddress: row.source_token_address, escrowAddress: row.escrow_address,
      seed: id.requestSeed, nextOperation: row.next_operation,
      designVersion: row.design_version, designCommitment: row.design_commitment,
      issuanceId: row.issuance_id });
    assert.equal(validEscrow, true);
    assert([0, 1].includes(q[8]));
    if (q[8] === 1) assert(q.length >= 137 && q.subarray(73, 137).some(byte => byte !== 0));
    return { ...id, phase: 'opening', fulfilled: q[8] === 1 };
  };

  const build = async (row, id) => {
    assert.equal(id.phase, 'opening');
    assert.equal(id.fulfilled, true);
    const balance = (await rpc.getBalance(address(payerAddress), {
      commitment: 'finalized',
    }).send()).value;
    const rent = await Promise.all([512, 768, 576, 165, 256].map(space =>
      rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()));
    assert(Number(balance) > rent.reduce((sum, value) => sum + Number(value), 0) + 10_000_000);
    const accounts = [meta(payerAddress, WS), meta(row.mint_address, W), meta(id.state, R),
      meta(id.lifecycle, W), meta(id.operation, W), meta(row.escrow_address, W),
      meta(id.config, R), meta(id.design, R), meta(id.request, R), meta(ORAO, R),
      meta(TOKEN_2022_PROGRAM_ADDRESS, R), meta(id.escrowAuthority, R),
      meta(id.ringMint, W), meta(id.ringToken, W), meta(id.ringState, W),
      meta(id.ringMetas, W), meta(row.wallet_address, R), meta(id.authority, R),
      meta(SYSTEM, R), meta(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, R), meta(id.collection, R),
      meta(id.series, W)];
    const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(1_400_000, 1);
    const instructions = [
      { programAddress: address(BUDGET), data: limit, accounts: [] },
      { programAddress: address(PROGRAM), data: Buffer.from([15]), accounts },
    ];
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    let message = createTransactionMessage({ version: 'legacy' });
    message = setTransactionMessageFeePayer(address(payerAddress), message);
    message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash,
      lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, message);
    message = appendTransactionMessageInstructions(instructions, message);
    const compiled = compileTransactionMessage(message);
    assert.deepEqual(compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts),
      [payerAddress]);
    const messageBytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
    const signature = sign(null, messageBytes, privateKey);
    const raw = Buffer.concat([Buffer.from([1]), signature, messageBytes]);
    const simulation = await rpc.simulateTransaction(getBase64Decoder().decode(raw), {
      encoding: 'base64', commitment: 'confirmed', sigVerify: true,
      replaceRecentBlockhash: false, innerInstructions: true,
    }).send();
    assert.equal(simulation.value.err, null, 'Silver keeper simulation failed');
    return { operation: id.operation, request: id.request, ringMint: id.ringMint,
      payer: payerAddress, messageBase64: messageBytes.toString('base64'),
      blockhash: lifetime.blockhash, lastValidBlockHeight: Number(lifetime.lastValidBlockHeight),
      signature: bs58.encode(signature), simulationPassed: true };
  };

  return { payerAddress, inspect, build,
    async provisionEscrow({ mintAddress, escrowAddress, escrowAuthority }) {
      assert.equal(await rpc.getGenesisHash().send(), GENESIS);
      assert.equal(escrowAuthority,
        await pda(PROGRAM, seed('silver-escrow'), rawAddress(mintAddress)));
      const [expectedEscrow] = await findAssociatedTokenPda({
        mint: address(mintAddress), owner: address(escrowAuthority),
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      assert.equal(escrowAddress, expectedEscrow);
      const balance = (await rpc.getBalance(address(payerAddress), {
        commitment: 'finalized',
      }).send()).value;
      const rent = await rpc.getMinimumBalanceForRentExemption(171n).send();
      assert(Number(balance) > Number(rent) + 1_000_000 + 10_000,
        'Silver escrow payer balance insufficient');
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayer(address(payerAddress), message);
      message = setTransactionMessageLifetimeUsingBlockhash({
        blockhash: lifetime.blockhash,
        lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
      }, message);
      message = appendTransactionMessageInstructions([
        getCreateAssociatedTokenIdempotentInstruction({
          payer: createNoopSigner(address(payerAddress)), ata: address(escrowAddress),
          owner: address(escrowAuthority), mint: address(mintAddress),
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        }),
      ], message);
      const compiled = compileTransactionMessage(message);
      assert.deepEqual(compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts),
        [payerAddress]);
      const messageBytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
      const signature = sign(null, messageBytes, privateKey);
      const raw = Buffer.concat([Buffer.from([1]), signature, messageBytes]);
      const encoded = getBase64Decoder().decode(raw);
      const simulation = await rpc.simulateTransaction(encoded, {
        encoding: 'base64', commitment: 'confirmed', sigVerify: true,
        replaceRecentBlockhash: false,
      }).send();
      assert.equal(simulation.value.err, null, 'Silver escrow provisioning simulation failed');
      const expectedSignature = bs58.encode(signature);
      const sent = await rpc.sendTransaction(encoded, { encoding: 'base64',
        skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }).send();
      assert.equal(sent, expectedSignature);
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const status = (await rpc.getSignatureStatuses([expectedSignature],
          { searchTransactionHistory: true }).send()).value[0];
        if (status?.err) throw new Error('Silver escrow provisioning rejected');
        if (status?.confirmationStatus === 'finalized') {
          const escrow = await reader.readEscrow({ cluster: 'devnet', programId: PROGRAM,
            mintAddress, escrowAddress, escrowAuthority });
          assert(escrow?.finalized && escrow.address === escrowAddress &&
            escrow.mintAddress === mintAddress && escrow.authority === escrowAuthority &&
            escrow.amount === '0' && escrow.programOwner === TOKEN_2022_PROGRAM_ADDRESS,
          'Silver escrow provisioning state mismatch');
          return expectedSignature;
        }
      }
      throw new Error('Silver escrow provisioning finality unknown');
    },
    async signatureStatus(signature) {
      return (await rpc.getSignatureStatuses([signature],
        { searchTransactionHistory: true }).send()).value[0];
    },
    async transaction(signature) {
      return rpc.getTransaction(signature, { encoding: 'base64', commitment: 'finalized',
        maxSupportedTransactionVersion: 0 }).send();
    },
    matchesTransaction(finalization, tx) {
      const raw = Buffer.concat([Buffer.from([1]), bs58.decode(finalization.signature),
        Buffer.from(finalization.message_base64, 'base64')]);
      return tx.transaction?.[0] && Buffer.from(tx.transaction[0], 'base64').equals(raw);
    },
    async verifyRing(row, finalization, tx) {
      const ring = await reader.readRingForIssuance({ programId: PROGRAM,
        cluster: 'devnet', issuanceId: row.issuance_id,
        walletAddress: row.wallet_address });
      if (!ring || ring.finalized !== true || ring.mintAddress !== finalization.ring_mint_address ||
          ring.boxMint !== row.mint_address || ring.tokenOwner !== row.wallet_address) return false;
      const decoded = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(finalization.message_base64, 'base64'));
      const amount = (balances, key, mint) => {
        const index = decoded.staticAccounts.indexOf(key);
        return balances?.find(item => Number(item.accountIndex) === index &&
          item.mint === mint)?.uiTokenAmount?.amount;
      };
      const [ringToken] = await findAssociatedTokenPda({
        mint: address(finalization.ring_mint_address), owner: address(row.wallet_address),
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      return amount(tx.meta?.preTokenBalances, row.escrow_address, row.mint_address) === '1' &&
        amount(tx.meta?.postTokenBalances, row.escrow_address, row.mint_address) === '0' &&
        amount(tx.meta?.postTokenBalances, ringToken,
          finalization.ring_mint_address) === '1';
    },
    async blockHeight() {
      return Number(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    },
    async blockhashValid(blockhash) {
      return (await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send()).value;
    },
    async send(finalization) {
      const raw = Buffer.concat([Buffer.from([1]), bs58.decode(finalization.signature),
        Buffer.from(finalization.message_base64, 'base64')]);
      const sent = await rpc.sendTransaction(getBase64Decoder().decode(raw), {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
        maxRetries: 0,
      }).send();
      assert.equal(sent, finalization.signature);
    },
  };
}
