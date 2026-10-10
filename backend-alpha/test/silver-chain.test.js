import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { getExtraAccountMetasEncoder, getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { createSilverChainReader } from '../src/silver-chain.js';

const b58 = () => bs58.encode(randomBytes(32));
const derive = (programId, seeds) => getProgramDerivedAddress({
  programAddress: address(programId), seeds,
});

test('escrow reader decodes finalized Token-2022 bytes on exact cluster', async () => {
  const mint = b58();
  const authority = b58();
  const escrow = b58();
  const bytes = Buffer.alloc(165);
  bs58.decode(mint).copy(bytes, 0);
  bs58.decode(authority).copy(bytes, 32);
  bytes[108] = 1;
  let genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const { id, method } = JSON.parse(Buffer.concat(parts).toString());
    const result = method === 'getGenesisHash' ? genesis : { context: { slot: 100 },
      value: { owner: TOKEN_2022_PROGRAM_ADDRESS,
        data: [bytes.toString('base64'), 'base64'] } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reader = createSilverChainReader(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(await reader.readEscrow({ cluster: 'devnet', mintAddress: mint,
      escrowAddress: escrow, escrowAuthority: authority }), {
      finalized: true, cluster: 'devnet', address: escrow,
      programOwner: TOKEN_2022_PROGRAM_ADDRESS,
      mintAddress: mint, authority, amount: '0',
    });
    await assert.rejects(reader.readEscrow({ cluster: 'local-validator', mintAddress: mint,
      escrowAddress: escrow, escrowAuthority: authority }), /cluster mismatch/);
    genesis = b58();
    await assert.rejects(reader.readEscrow({ cluster: 'devnet', mintAddress: mint,
      escrowAddress: escrow, escrowAuthority: authority }), /cluster mismatch/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Kit Silver reader projects only canonical schema-3 SEALED lifecycle ownership', async () => {
  const programId = b58();
  const owner = b58();
  const issuanceId = createHash('sha256').update('silver-reader-test').digest('hex');
  const [mint] = await derive(programId, [new TextEncoder().encode('silver-mint'),
    Buffer.from(issuanceId, 'hex')]);
  const [state] = await derive(programId, [new TextEncoder().encode('silver-state'), bs58.decode(mint)]);
  const [collection] = await derive(programId, [new TextEncoder().encode('silver-collection')]);
  const [extraMetas] = await derive(programId, [new TextEncoder().encode('extra-account-metas'),
    bs58.decode(mint)]);
  const [lifecycle] = await derive(programId, [new TextEncoder().encode('silver-lifecycle'),
    bs58.decode(mint)]);
  const context = { slot: 200 };
  const issuanceSignature = bs58.encode(randomBytes(64));
  const latestSignature = bs58.encode(randomBytes(64));
  const stateBytes = Buffer.alloc(204);
  stateBytes.set([3, 1, 1, 1]);
  Buffer.from(issuanceId, 'hex').copy(stateBytes, 4);
  bs58.decode(mint).copy(stateBytes, 36);
  bs58.decode(collection).copy(stateBytes, 68);
  bs58.decode(owner).copy(stateBytes, 100);
  randomBytes(32).copy(stateBytes, 132);
  randomBytes(16).copy(stateBytes, 164);
  stateBytes.writeBigUInt64LE(100n, 180);
  stateBytes.writeBigUInt64LE(150n, 188);
  stateBytes.writeBigInt64LE(1_790_000_000n, 196);
  const metaBytes = Buffer.from(getExtraAccountMetasEncoder().encode([
    { config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: new TextEncoder().encode('silver-state') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true },
    { config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: new TextEncoder().encode('silver-lifecycle') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true },
  ]));
  Buffer.from('692565c54bfb661a', 'hex').copy(metaBytes);
  metaBytes.writeUInt32LE(74, 8);
  const marketBytes = Buffer.from(getExtraAccountMetasEncoder().encode([
    { config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: new TextEncoder().encode('silver-state') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true },
    { config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: new TextEncoder().encode('silver-lifecycle') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true },
    { config: { __kind: 'Literal', address: 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j' },
      isSigner: false, isWritable: false },
    { config: { __kind: 'AccountPda', accountIndex: 7, seeds: [
      { __kind: 'Literal', bytes: new TextEncoder().encode('silver-market-listing') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true },
  ]));
  Buffer.from('692565c54bfb661a', 'hex').copy(marketBytes);
  marketBytes.writeUInt32LE(marketBytes.length - 12, 8);
  const lifecycleBytes = Buffer.alloc(128);
  Buffer.from('455253424c563100', 'hex').copy(lifecycleBytes);
  lifecycleBytes[8] = 1;
  lifecycleBytes[9] = 0;
  bs58.decode(mint).copy(lifecycleBytes, 16);
  lifecycleBytes.writeBigUInt64LE(1n, 48);
  lifecycleBytes.writeBigUInt64LE(100n, 120);
  const snapshot = { bytes: stateBytes, stateOwner: programId, metaOwner: programId,
    meta: metaBytes, lifecycle: lifecycleBytes, lifecycleOwner: programId,
    signature: issuanceSignature, signatureSlot: 100,
    signatureStatus: 'finalized', tokenAmount: '1', tokenOwner: owner,
    historyCalls: 0 };
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const { id, method, params } = JSON.parse(Buffer.concat(parts).toString());
    let result;
    if (method === 'getGenesisHash') result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if (method === 'getAccountInfo') {
      const key = params[0];
      const account = key === state ? { owner: snapshot.stateOwner,
        data: [snapshot.bytes.toString('base64'), 'base64'] }
        : key === extraMetas && snapshot.meta ? { owner: snapshot.metaOwner,
          data: [snapshot.meta.toString('base64'), 'base64'] }
          : key === lifecycle && snapshot.lifecycle ? { owner: snapshot.lifecycleOwner,
            data: [snapshot.lifecycle.toString('base64'), 'base64'] }
          : key === mint ? { owner: TOKEN_2022_PROGRAM_ADDRESS,
            data: { program: 'spl-token-2022', parsed: { info: { supply: '1', decimals: 0,
              mintAuthority: null, freezeAuthority: null } }, space: 100 } } : null;
      result = { context, value: account && { lamports: 1000000, executable: false,
        rentEpoch: 0, space: 204, ...account } };
    } else if (method === 'getTokenAccountsByOwner') {
      result = { context, value: snapshot.tokenAmount === '0' || params[0] !== snapshot.tokenOwner ?
        [] : [{ pubkey: b58(),
        account: { owner: TOKEN_2022_PROGRAM_ADDRESS, lamports: 1000000,
          executable: false, rentEpoch: 0, space: 200, data: { program: 'spl-token-2022',
            parsed: { info: { mint, owner: snapshot.tokenOwner,
              tokenAmount: { amount: snapshot.tokenAmount } } },
            space: 200 } } }] };
    } else if (method === 'getSignaturesForAddress') {
      snapshot.historyCalls++;
      result = [{ signature: snapshot.signature, slot: snapshot.signatureSlot, err: null,
        confirmationStatus: 'finalized', blockTime: 1790000000, memo: null }];
    } else if (method === 'getSignatureStatuses') {
      snapshot.historyCalls++;
      assert.equal(params[0][0], issuanceSignature);
      result = { context, value: [snapshot.signatureMissing ? null : { err: null,
        confirmationStatus: snapshot.signatureStatus, confirmations: null,
        slot: snapshot.signatureSlot,
        status: { Ok: null } }] };
    } else throw Error(`Unexpected RPC method ${method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reader = createSilverChainReader(`http://127.0.0.1:${server.address().port}`);
    const input = { programId, cluster: 'devnet', issuanceId };
    const current = await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature });
    assert.equal(current.stateSchemaVersion, 3);
    assert.equal(current.finalizedSignature, issuanceSignature);
    assert.equal(current.lastDirectTransferSlot, '150');
    assert.equal(current.cooldownUntilUnixSeconds, '1790000000');
    assert.equal(current.lifecycleAddress, lifecycle);
    assert.equal(current.lifecyclePhase, 'SEALED');
    assert.equal(current.lifecycleMigrationSlot, '100');
    assert.equal(snapshot.historyCalls, 0);
    snapshot.meta = marketBytes;
    assert.equal((await reader.readFinalized(input))?.mintAddress, mint);
    snapshot.meta = Buffer.from(marketBytes);
    snapshot.meta[marketBytes.length - 1] ^= 1;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.meta = metaBytes;
    snapshot.signatureMissing = true;
    assert.equal((await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature })).mintAddress, mint);
    assert.equal(snapshot.historyCalls, 0);
    const restartedLocal = createSilverChainReader(
      `http://127.0.0.1:${server.address().port}`, {
        expectedCluster: 'local-validator',
        expectedGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      });
    assert(await restartedLocal.readFinalized({ ...input, cluster: 'local-validator',
      expectedFinalizedSignature: issuanceSignature }));
    snapshot.signatureMissing = false;
    snapshot.signatureStatus = 'confirmed';
    assert((await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature })).finalized);
    snapshot.signatureStatus = 'finalized';
    snapshot.signatureSlot = 200;
    assert((await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature })).finalized);
    snapshot.signatureSlot = 100;
    snapshot.tokenOwner = b58();
    assert.equal(await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature }), null);
    const transferred = await reader.readFinalized({ ...input,
      walletAddress: snapshot.tokenOwner, expectedFinalizedSignature: issuanceSignature });
    assert.equal(transferred?.originalRecipient, owner);
    assert.equal(transferred?.tokenOwner, snapshot.tokenOwner);
    snapshot.tokenOwner = owner;
    snapshot.bytes = Buffer.concat([stateBytes, Buffer.from([0])]);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = Buffer.from(stateBytes);
    snapshot.bytes[0] = 2;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = Buffer.from(stateBytes);
    snapshot.meta = null;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.meta = metaBytes;
    snapshot.metaOwner = b58();
    assert.equal(await reader.readFinalized(input), null);
    snapshot.metaOwner = programId;
    snapshot.meta = Buffer.concat([metaBytes, Buffer.from([0])]);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.meta = metaBytes;
    snapshot.meta = Buffer.from(metaBytes);
    snapshot.meta[17] = 2;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.meta = metaBytes;
    snapshot.lifecycle = null;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.lifecycle = Buffer.from(lifecycleBytes);
    snapshot.lifecycleOwner = b58();
    assert.equal(await reader.readFinalized(input), null);
    snapshot.lifecycleOwner = programId;
    snapshot.lifecycle[8] = 2;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.lifecycle = Buffer.from(lifecycleBytes);
    snapshot.lifecycle[9] = 1;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.lifecycle = Buffer.from(lifecycleBytes);
    randomBytes(32).copy(snapshot.lifecycle, 16);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.lifecycle = lifecycleBytes;
    snapshot.stateOwner = b58();
    assert.equal(await reader.readFinalized(input), null);
    snapshot.stateOwner = programId;
    snapshot.bytes.writeBigInt64LE(-1n, 196);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = stateBytes;
    snapshot.tokenAmount = '0';
    assert.equal(await reader.readFinalized(input), null);
    assert.equal(snapshot.historyCalls, 0);
    await assert.rejects(reader.readFinalized({ ...input, cluster: 'local-validator' }),
      /cluster\/issuance mismatch/);
    assert.throws(() => createSilverChainReader('http://127.0.0.1:1', {
      expectedCluster: 'unknown', expectedGenesisHash: 'synthetic',
    }), /exact cluster identity/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('consumed Box projects only a canonical finalized Ring held by the requested wallet', async () => {
  const programId = b58();
  const wallet = b58();
  const issuanceId = createHash('sha256').update('ring-reader-test').digest('hex');
  const seed = value => new TextEncoder().encode(value);
  const key = value => bs58.decode(value);
  const [boxMint] = await derive(programId, [seed('silver-mint'), Buffer.from(issuanceId, 'hex')]);
  const [boxState] = await derive(programId, [seed('silver-state'), key(boxMint)]);
  const [lifecycle] = await derive(programId, [seed('silver-lifecycle'), key(boxMint)]);
  const [collection] = await derive(programId, [seed('silver-collection')]);
  const number = Buffer.alloc(8); number.writeBigUInt64LE(1n);
  const [operation] = await derive(programId, [seed('silver-open'), key(boxMint), number]);
  const [ringMint] = await derive(programId, [seed('silver-ring-mint'), key(boxMint), key(operation)]);
  const [ringState] = await derive(programId, [seed('silver-ring-state'), key(ringMint)]);
  const [metas] = await derive(programId, [seed('extra-account-metas'), key(ringMint)]);
  const version = Buffer.alloc(8); version.writeBigUInt64LE(1n);
  const [designAddress] = await derive(programId, [seed('silver-design-set'), version]);
  const request = b58();
  const uri = 'ipfs://ring-reader-test';
  const contentHash = randomBytes(32);
  const design = Buffer.alloc(104 + 238);
  Buffer.from('ERSDSV1\0').copy(design);
  design[8] = 1; design[9] = 1;
  design.writeUInt16LE(1, 10); design.writeUInt16LE(1, 12);
  design.writeUInt16LE(38 + uri.length, 14);
  version.copy(design, 16);
  randomBytes(32).copy(design, 24);
  randomBytes(8).copy(design, 96);
  design.writeUInt32LE(26, 104);
  design.writeUInt16LE(uri.length, 108);
  design.write(uri, 110, 'ascii');
  contentHash.copy(design, 110 + uri.length);
  const commitment = createHash('sha256').update('ETHERINGS_SILVER_DESIGN_SET_V1')
    .update(key(programId)).update(key(designAddress))
    .update(design.subarray(16, 24)).update(design.subarray(12, 14))
    .update(design.subarray(104, 104 + design.readUInt16LE(14))).digest();
  commitment.copy(design, 56);
  const box = Buffer.alloc(204);
  box.set([3, 1, 1, 1]);
  Buffer.from(issuanceId, 'hex').copy(box, 4);
  key(boxMint).copy(box, 36); key(collection).copy(box, 68); key(wallet).copy(box, 100);
  randomBytes(32).copy(box, 132); randomBytes(16).copy(box, 164);
  box.writeBigUInt64LE(100n, 180);
  const life = Buffer.alloc(128);
  Buffer.from('455253424c563100', 'hex').copy(life);
  life[8] = 1; life[9] = 2;
  key(boxMint).copy(life, 16); life.writeBigUInt64LE(2n, 48);
  key(operation).copy(life, 56); key(ringMint).copy(life, 88);
  life.writeBigUInt64LE(101n, 120);
  const op = Buffer.alloc(320);
  Buffer.from('ERSOPV1\0').copy(op); op[8] = 1; op[9] = 2;
  op.writeBigUInt64LE(1n, 16); key(boxMint).copy(op, 24); key(wallet).copy(op, 56);
  key(request).copy(op, 120); key(designAddress).copy(op, 184);
  version.copy(op, 216); op.writeUInt16LE(1, 224); commitment.copy(op, 226);
  key(ringMint).copy(op, 266); op.writeBigUInt64LE(102n, 298);
  const ring = Buffer.alloc(576);
  Buffer.from('ERSRGV1\0').copy(ring); ring[8] = 1; ring[9] = 2;
  key(ringMint).copy(ring, 16); key(boxMint).copy(ring, 48);
  key(operation).copy(ring, 80); key(wallet).copy(ring, 112);
  key(collection).copy(ring, 144); key(request).copy(ring, 176);
  commitment.copy(ring, 208); version.copy(ring, 240);
  ring.writeUInt32LE(26, 250); contentHash.copy(ring, 254);
  ring.set([15, 20, 25, 30], 286); ring[290] = 1; ring[291] = 100;
  ring[296] = 1; ring.writeUInt16LE(1, 297);
  ring.writeBigUInt64LE(101n, 304); ring.writeBigUInt64LE(102n, 312);
  ring.writeUInt16LE(uri.length, 336); ring.write(uri, 338, 'ascii');
  const mint = supply => Buffer.from(getMintEncoder().encode({ mintAuthority: null,
    supply, decimals: 0, isInitialized: true, freezeAuthority: null,
    extensions: supply === 0 ? [] : [
      { __kind: 'MetadataPointer', authority: null, metadataAddress: ringMint },
      { __kind: 'TransferHook', authority: programId, programId },
      { __kind: 'TokenMetadata', updateAuthority: null, mint: ringMint,
        name: 'EtheRings Silver Ring', symbol: 'ESRG', uri,
        additionalMetadata: new Map([['kind', 'SILVER_RING'], ['collection', collection],
          ['design_id', '26'], ['content_hash', contentHash.toString('hex')]]) },
    ] }));
  const extra = Buffer.from(getExtraAccountMetasEncoder().encode([{
    config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: seed('silver-ring-state') },
      { __kind: 'AccountKey', index: 1 } ] }, isSigner: false, isWritable: true,
  }]));
  Buffer.from('692565c54bfb661a', 'hex').copy(extra);
  const marketExtra = Buffer.from(getExtraAccountMetasEncoder().encode([{
    config: { __kind: 'ProgramPda', seeds: [
      { __kind: 'Literal', bytes: seed('silver-ring-state') },
      { __kind: 'AccountKey', index: 1 } ] }, isSigner: false, isWritable: true,
  }, { config: { __kind: 'Literal',
    address: 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j' },
  isSigner: false, isWritable: false }, {
    config: { __kind: 'AccountPda', accountIndex: 6, seeds: [
      { __kind: 'Literal', bytes: seed('silver-market-listing') },
      { __kind: 'AccountKey', index: 1 } ] }, isSigner: false, isWritable: true,
  }]));
  Buffer.from('692565c54bfb661a', 'hex').copy(marketExtra);
  const accounts = new Map([
    [boxState, { owner: programId, data: box }],
    [lifecycle, { owner: programId, data: life }],
    [boxMint, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mint(0) }],
    [operation, { owner: programId, data: op }],
    [ringState, { owner: programId, data: ring }],
    [ringMint, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mint(1) }],
    [metas, { owner: programId, data: extra }],
    [designAddress, { owner: programId, data: design }],
  ]);
  let tokenOwner = wallet;
  let ownerInventoryReads = 0;
  let genesisReads = 0;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const { id, method, params } = JSON.parse(Buffer.concat(parts).toString());
    let result;
    if (method === 'getGenesisHash') {
      genesisReads++;
      result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    }
    else if (method === 'getMultipleAccounts') {
      assert.equal(params[1].encoding, 'base64');
      assert.equal(params[1].commitment ?? 'finalized', 'finalized');
      result = { context: { slot: 200 }, value: params[0].map(key => {
        const account = accounts.get(key);
        return account && { lamports: 1000000, executable: false, rentEpoch: 0,
          space: account.data.length, owner: account.owner,
          data: [account.data.toString('base64'), 'base64'] };
      }) };
    } else if (method === 'getAccountInfo') {
      const account = accounts.get(params[0]);
      result = { context: { slot: 200 }, value: account && { lamports: 1000000,
        executable: false, rentEpoch: 0, space: account.data.length,
        owner: account.owner, data: [account.data.toString('base64'), 'base64'] } };
    } else if (method === 'getTokenAccountsByOwner') {
      if (params[1]?.programId === TOKEN_2022_PROGRAM_ADDRESS) ownerInventoryReads++;
      result = { context: { slot: 200 }, value: params[0] === tokenOwner ? [{ pubkey: b58(),
        account: { owner: TOKEN_2022_PROGRAM_ADDRESS, lamports: 1000000, executable: false,
          rentEpoch: 0, space: 200, data: { program: 'spl-token-2022', parsed: { info: {
            mint: ringMint, owner: tokenOwner, tokenAmount: { amount: '1' },
          } }, space: 200 } } }] : [] };
    } else throw Error(`Unexpected RPC method ${method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const reader = createSilverChainReader(url);
    const input = { programId, cluster: 'devnet', issuanceId, walletAddress: wallet };
    const valid = await reader.readRingForIssuance(input);
    assert.equal(valid?.mintAddress, ringMint);
    assert.equal(valid?.tokenOwner, wallet);
    assert.deepEqual({ level: valid.level, shine: valid.shine,
      unspentPoints: valid.unspentPoints, comfort: valid.comfort, charm: valid.charm,
      quality: valid.quality, luck: valid.luck,
      lastDirectTransferSlot: valid.lastDirectTransferSlot,
      cooldownUntilUnixSeconds: valid.cooldownUntilUnixSeconds },
    { level: 1, shine: 100, unspentPoints: 0, comfort: 15, charm: 20,
      quality: 25, luck: 30, lastDirectTransferSlot: '0', cooldownUntilUnixSeconds: '0' });
    assert.deepEqual(await reader.listOwnedRings({ programId, cluster: 'devnet',
      walletAddress: wallet }), [valid]);
    const beforeInventory = ownerInventoryReads;
    const beforeGenesis = genesisReads;
    const [boxes, rings] = await reader.listOwnedAssets({ programId, cluster: 'devnet',
      walletAddress: wallet });
    assert.deepEqual(boxes, []);
    assert.deepEqual(rings, [valid]);
    assert.equal(ownerInventoryReads - beforeInventory, 1);
    assert.equal(genesisReads - beforeGenesis, 1);
    accounts.get(metas).data = marketExtra;
    assert.equal((await reader.readRingForIssuance(input))?.mintAddress, ringMint);
    accounts.get(metas).data = extra;
    const restarted = createSilverChainReader(url);
    assert.deepEqual(await restarted.readRingForIssuance(input), valid);
    ring[290] = 2;
    ring.writeUInt32LE(6, 292);
    ring[299] = 90; // 15 + 20 + 25 + 30 at initial generation.
    assert.equal((await reader.readRingForIssuance(input))?.level, 2);
    ring[286] = 16;
    ring.writeUInt32LE(5, 292);
    assert.equal((await reader.readRingForIssuance(input))?.unspentPoints, 5);
    ring.writeUInt32LE(6, 292);
    assert.equal(await reader.readRingForIssuance(input), null);
    ring[286] = 15;
    ring[290] = 1;
    ring.writeUInt32LE(0, 292);
    ring[299] = 0;
    tokenOwner = b58();
    assert.equal(await reader.readRingForIssuance(input), null);
    assert.deepEqual(await reader.listOwnedRings({ programId, cluster: 'devnet',
      walletAddress: wallet }), []);
    assert.equal((await reader.listOwnedRings({ programId, cluster: 'devnet',
      walletAddress: tokenOwner }))[0]?.tokenOwner, tokenOwner);
    tokenOwner = wallet;
    assert.equal(await reader.readRingForIssuance({ ...input, walletAddress: b58() }), null);
    for (const [target, offset] of [[life, 9], [op, 9], [ring, 9], [design, 9], [box, 4]]) {
      const original = target[offset]; target[offset] ^= 1;
      assert.equal(await reader.readRingForIssuance(input), null);
      target[offset] = original;
    }
    accounts.get(ringMint).data = mint(0);
    assert.equal(await reader.readRingForIssuance(input), null);
    assert.deepEqual(await reader.listOwnedRings({ programId, cluster: 'devnet',
      walletAddress: wallet }), []);
    accounts.get(ringMint).data = mint(1);
    const oldDigest = design[56]; design[56] ^= 1;
    assert.equal(await reader.readRingForIssuance(input), null);
    design[56] = oldDigest;
    const oldBeneficiary = op[56]; op[56] ^= 1;
    assert.equal(await reader.readRingForIssuance(input), null);
    op[56] = oldBeneficiary;
    const oldAttribute = ring[286]; ring[286] = 0;
    assert.equal(await reader.readRingForIssuance(input), null);
    ring[286] = oldAttribute;
    for (const offset of [286, 287, 288, 289]) {
      const previous = ring[offset]; ring[offset] = 31;
      assert.equal(await reader.readRingForIssuance(input), null);
      ring[offset] = previous;
    }
    for (const [offset, value] of [[290, 2], [291, 99], [292, 1]]) {
      const previous = ring[offset]; ring[offset] = value;
      assert.equal(await reader.readRingForIssuance(input), null);
      ring[offset] = previous;
    }
    ring.writeBigUInt64LE(150n, 320);
    assert.equal(await reader.readRingForIssuance(input), null);
    ring.writeBigInt64LE(1790000000n, 328);
    assert.equal((await reader.readRingForIssuance(input))?.lastDirectTransferSlot, '150');
    assert.equal((await reader.readRingForIssuance(input))?.cooldownUntilUnixSeconds,
      '1790000000');
    ring.writeBigUInt64LE(0n, 320);
    assert.equal(await reader.readRingForIssuance(input), null);
    ring.writeBigInt64LE(-1n, 328);
    assert.equal(await reader.readRingForIssuance(input), null);
    ring.writeBigInt64LE(0n, 328);
    assert.equal((await reader.readRingForIssuance(input))?.mintAddress, ringMint);
    await assert.rejects(reader.readRingForIssuance({ ...input, cluster: 'local-validator' }),
      /cluster\/issuance mismatch/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
