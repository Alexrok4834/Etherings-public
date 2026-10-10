import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, getExtraAccountMetasEncoder,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { createSilverChainReader } from '../src/silver-chain.js';

const key = () => bs58.encode(randomBytes(32));
const bytes = value => Buffer.from(bs58.decode(value));
const text = value => new TextEncoder().encode(value);
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const ORAO = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';

test('candidate Kit reader requires exact finalized config, DesignSet, mint and owner bytes', async () => {
  const programId = key();
  const walletAddress = key();
  const genesisHash = key();
  const issuanceId = randomBytes(32);
  const mintAddress = await pda(programId, text('silver-mint'), issuanceId);
  const config = await pda(programId, text('silver-config'));
  const collection = await pda(programId, text('silver-collection'));
  const state = await pda(programId, text('silver-state'), bytes(mintAddress));
  const lifecycle = await pda(programId, text('silver-lifecycle'), bytes(mintAddress));
  const extraMetas = await pda(programId, text('extra-account-metas'), bytes(mintAddress));
  const escrowAuthority = await pda(programId, text('silver-escrow'), bytes(mintAddress));
  const [escrowAddress] = await findAssociatedTokenPda({ mint: address(mintAddress),
    owner: address(escrowAuthority), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const network = await pda(ORAO, text('orao-vrf-network-configuration'));
  const versionBytes = Buffer.alloc(8);
  versionBytes.writeBigUInt64LE(1n);
  const design = await pda(programId, text('silver-design-set'), versionBytes);
  const treasury = key();
  const sourceTokenAddress = key();
  const configBytes = Buffer.alloc(145);
  configBytes[0] = 2;
  bytes(key()).copy(configBytes, 1);
  bytes(design).copy(configBytes, 73);
  versionBytes.copy(configBytes, 105);
  const collectionBytes = Buffer.alloc(66);
  collectionBytes[0] = 1;
  configBytes.subarray(1, 33).copy(collectionBytes, 1);
  bytes(config).copy(collectionBytes, 33);
  collectionBytes[65] = 1;
  const stateBytes = Buffer.alloc(204);
  stateBytes.set([3, 1, 1, 1]);
  issuanceId.copy(stateBytes, 4);
  bytes(mintAddress).copy(stateBytes, 36);
  bytes(collection).copy(stateBytes, 68);
  bytes(walletAddress).copy(stateBytes, 100);
  const lifeBytes = Buffer.alloc(128);
  Buffer.from('455253424c563100', 'hex').copy(lifeBytes);
  lifeBytes[8] = 1;
  bytes(mintAddress).copy(lifeBytes, 16);
  lifeBytes.writeBigUInt64LE(1n, 48);
  const meta = seed => ({ config: { __kind: 'ProgramPda', seeds: [
    { __kind: 'Literal', bytes: text(seed) }, { __kind: 'AccountKey', index: 1 },
  ] }, isSigner: false, isWritable: true });
  const metaBytes = Buffer.from(getExtraAccountMetasEncoder().encode([
    meta('silver-state'), meta('silver-lifecycle'),
  ]));
  Buffer.from('692565c54bfb661a', 'hex').copy(metaBytes);
  metaBytes.writeUInt32LE(74, 8);
  const networkBytes = Buffer.alloc(72);
  bytes(treasury).copy(networkBytes, 40);
  const token = (owner, amount) => {
    const raw = Buffer.alloc(165);
    bytes(mintAddress).copy(raw, 0);
    bytes(owner).copy(raw, 32);
    raw.writeBigUInt64LE(BigInt(amount), 64);
    raw[108] = 1;
    return raw;
  };
  const designBytes = Buffer.alloc(104 + 238);
  Buffer.from('ERSDSV1\0').copy(designBytes);
  designBytes[8] = 1;
  designBytes[9] = 1;
  designBytes.writeUInt16LE(1, 10);
  designBytes.writeUInt16LE(1, 12);
  const uri = Buffer.from('ipfs://candidate');
  designBytes.writeUInt16LE(38 + uri.length, 14);
  versionBytes.copy(designBytes, 16);
  configBytes.subarray(1, 33).copy(designBytes, 24);
  designBytes.writeUInt32LE(1, 104);
  designBytes.writeUInt16LE(uri.length, 108);
  uri.copy(designBytes, 110);
  randomBytes(32).copy(designBytes, 110 + uri.length);
  const digest = createHash('sha256').update('ETHERINGS_SILVER_DESIGN_SET_V1')
    .update(bytes(programId)).update(bytes(design)).update(versionBytes)
    .update(designBytes.subarray(12, 14))
    .update(designBytes.subarray(104, 104 + 38 + uri.length)).digest();
  digest.copy(designBytes, 56);
  digest.copy(configBytes, 113);
  designBytes[96] = 1;
  const accounts = new Map([
    [programId, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, raw: Buffer.alloc(0) }],
    [ORAO, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, raw: Buffer.alloc(0) }],
    [config, { owner: programId, raw: configBytes }],
    [collection, { owner: programId, raw: collectionBytes }],
    [state, { owner: programId, raw: stateBytes }],
    [lifecycle, { owner: programId, raw: lifeBytes }],
    [extraMetas, { owner: programId, raw: metaBytes }],
    [network, { owner: ORAO, raw: networkBytes }],
    [design, { owner: programId, raw: designBytes }],
    [escrowAddress, { owner: TOKEN_2022_PROGRAM_ADDRESS, raw: token(escrowAuthority, 0) }],
    [sourceTokenAddress, { owner: TOKEN_2022_PROGRAM_ADDRESS, raw: token(walletAddress, 1) }],
    [mintAddress, { owner: TOKEN_2022_PROGRAM_ADDRESS,
      parsed: { supply: '1', decimals: 0, mintAuthority: null, freezeAuthority: null } }],
  ]);
  let genesis = genesisHash;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (method === 'getGenesisHash') result = genesis;
    else if (method === 'getAccountInfo') {
      const entry = accounts.get(params[0]);
      result = { context: { slot: 100 }, value: entry ? { owner: entry.owner,
        lamports: 1000000, executable: Boolean(entry.executable), rentEpoch: 0,
        space: entry.raw?.length ?? 100,
        data: entry.parsed ? { program: 'spl-token-2022', parsed: { info: entry.parsed },
          space: 100 } : [entry.raw.toString('base64'), 'base64'] } : null };
    } else if (method === 'getTokenAccountsByOwner') {
      result = { context: { slot: 100 }, value: [{ pubkey: sourceTokenAddress,
        account: { owner: TOKEN_2022_PROGRAM_ADDRESS, lamports: 1000000,
          executable: false, rentEpoch: 0, space: 165,
          data: { program: 'spl-token-2022', parsed: { info: { mint: mintAddress,
            owner: walletAddress, tokenAmount: { amount: '1' } } }, space: 165 } } }] };
    } else if (method === 'getLatestBlockhash') result = { context: { slot: 100 },
      value: { blockhash: key(), lastValidBlockHeight: 1100 } };
    else throw Error(`Unexpected RPC ${method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reader = createSilverChainReader(`http://127.0.0.1:${server.address().port}`, {
      expectedCluster: 'local-validator', expectedGenesisHash: genesisHash,
    });
    const input = { programId, mintAddress, walletAddress, escrowAddress };
    const snapshot = await reader.readCandidateOpeningSnapshot(input);
    assert.equal(snapshot.sourceTokenAddress, sourceTokenAddress);
    assert.equal(snapshot.marketProgramId, null);
    const marketProgramId = key();
    assert.equal(snapshot.designCommitment, digest.toString('hex'));
    const withListing = Buffer.from(getExtraAccountMetasEncoder().encode([
      meta('silver-state'), meta('silver-lifecycle'),
      { config: { __kind: 'Literal', address: marketProgramId },
        isSigner: false, isWritable: false },
      { config: { __kind: 'AccountPda', accountIndex: 7, seeds: [
        { __kind: 'Literal', bytes: text('silver-market-listing') },
        { __kind: 'AccountKey', index: 1 },
      ] }, isSigner: false, isWritable: true },
    ]));
    Buffer.from('692565c54bfb661a', 'hex').copy(withListing);
    withListing.writeUInt32LE(144, 8);
    accounts.get(extraMetas).raw = withListing;
    assert.equal((await reader.readCandidateOpeningSnapshot(input)).marketProgramId,
      marketProgramId);
    accounts.get(extraMetas).raw = metaBytes;
    const mutate = async (keyAddress, offset) => {
      const entry = accounts.get(keyAddress);
      entry.raw[offset] ^= 1;
      assert.equal(await reader.readCandidateOpeningSnapshot(input), null);
      entry.raw[offset] ^= 1;
    };
    await mutate(config, 113);
    await mutate(design, 110);
    await mutate(collection, 33);
    await mutate(state, 36);
    await mutate(sourceTokenAddress, 32);
    await mutate(lifecycle, 9);
    genesis = key();
    await assert.rejects(reader.readCandidateOpeningSnapshot(input), /cluster mismatch/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
