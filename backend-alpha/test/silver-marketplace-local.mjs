// Disposable Agave fixture only. Never sends to Devnet and never stores user keys.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createTransactionMessage,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { findAssociatedTokenPda, getExtraAccountMetasEncoder, getMintEncoder, getTokenEncoder,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { buildSilverMarketplaceBuyMessage, buildSilverMarketplaceCancelMessage,
  buildSilverMarketplaceListMessage } from '../src/silver-marketplace-intent.js';

const scratch = process.env.MARKET_LOCAL_SCRATCH;
assert(scratch?.startsWith('/tmp/etherings-market-'), 'Disposable scratch required');
const system = '11111111111111111111111111111111';
const silver = process.env.MARKET_LOCAL_SILVER;
assert(silver, 'Local Silver program ID required');
const key = () => bs58.encode(randomBytes(32));
const raw = value => bs58.decode(value);
const text = value => new TextEncoder().encode(value);
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const accountFile = (name, pubkey, owner, data, lamports = 10_000_000) => {
  writeFileSync(join(scratch, `${name}.json`), JSON.stringify({ pubkey,
    account: { lamports, owner, executable: false, rentEpoch: 0,
      data: [Buffer.from(data).toString('base64'), 'base64'] },
  }));
};

if (['prepare', 'prepare-list-cancel', 'prepare-lazy-list-cancel',
  'prepare-lazy-ring'].includes(process.argv[2])) {
  const ring = process.argv[2] === 'prepare-lazy-ring';
  const lazy = process.argv[2] === 'prepare-lazy-list-cancel';
  const legacy = lazy || ring;
  const listCancel = process.argv[2] !== 'prepare';
  mkdirSync(scratch, { recursive: true });
  const market = listCancel ? 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j' : key();
  const buyer = key();
  const seller = key();
  const royalty = key();
  const platform = key();
  const issuance = randomBytes(32);
  const boxMint = key();
  const operation = key();
  const mint = ring ? await pda(silver, text('silver-ring-mint'), raw(boxMint),
    raw(operation)) : await pda(silver, text('silver-mint'), issuance);
  const state = await pda(silver, text(ring ? 'silver-ring-state' : 'silver-state'), raw(mint));
  const lifecycle = ring ? system : await pda(silver, text('silver-lifecycle'), raw(mint));
  const collection = await pda(silver, text('silver-collection'));
  const extra = await pda(silver, text('extra-account-metas'), raw(mint));
  const listing = await pda(market, text('silver-market-listing'), raw(mint));
  const config = await pda(market, text('silver-market-config'));
  const authority = await pda(market, text('silver-market-authority'));
  const source = key();
  const [destination] = await findAssociatedTokenPda({ mint: address(mint),
    owner: address(buyer), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const mintBytes = getMintEncoder().encode({ mintAuthority: null, supply: 1n,
    decimals: 0, isInitialized: true, freezeAuthority: null, extensions: [
      { __kind: 'MetadataPointer', authority: null, metadataAddress: mint },
      { __kind: 'TransferHook', authority: system, programId: silver },
    ] });
  const token = (owner, amount, delegate, delegatedAmount) => getTokenEncoder().encode({
    mint, owner, amount: BigInt(amount), delegate, state: 'Initialized', isNative: null,
    delegatedAmount: BigInt(delegatedAmount), closeAuthority: null,
    extensions: [{ __kind: 'TransferHookAccount', transferring: false }],
  });
  const stateBytes = Buffer.alloc(ring ? 576 : 204);
  if (ring) {
    Buffer.from('ERSRGV1\0').copy(stateBytes);
    stateBytes[8] = 1; stateBytes[9] = 2;
    raw(mint).copy(stateBytes, 16); raw(boxMint).copy(stateBytes, 48);
    raw(operation).copy(stateBytes, 80); raw(key()).copy(stateBytes, 112);
    raw(collection).copy(stateBytes, 144); raw(key()).copy(stateBytes, 176);
    stateBytes.fill(1, 208, 240); stateBytes.writeBigUInt64LE(1n, 240);
    stateBytes.writeUInt16LE(2, 248); stateBytes.writeUInt32LE(3, 250);
    stateBytes.fill(3, 254, 286);
    Buffer.from([26, 24, 29, 21]).copy(stateBytes, 286);
    stateBytes[290] = 1; stateBytes[291] = 100; stateBytes[296] = 1;
    stateBytes.writeUInt16LE(3, 297);
    stateBytes.writeBigUInt64LE(10n, 304); stateBytes.writeBigUInt64LE(11n, 312);
    const uri = Buffer.from('ipfs://bafy-test');
    stateBytes.writeUInt16LE(uri.length, 336); uri.copy(stateBytes, 338);
    stateBytes.fill(4, 544, 576);
  } else {
    stateBytes.set([3, 1, 1, 1]);
    issuance.copy(stateBytes, 4); raw(mint).copy(stateBytes, 36);
    raw(collection).copy(stateBytes, 68);
  }
  const lifeBytes = Buffer.alloc(128);
  Buffer.from('ERSBLV1\0').copy(lifeBytes); lifeBytes[8] = 1;
  raw(mint).copy(lifeBytes, 16); lifeBytes.writeBigUInt64LE(1n, 48);
  lifeBytes.writeBigUInt64LE(1n, 120);
  const pdaMeta = seed => ({ config: { __kind: 'ProgramPda', seeds: [
    { __kind: 'Literal', bytes: text(seed) }, { __kind: 'AccountKey', index: 1 },
  ] }, isSigner: false, isWritable: true });
  const extraMetas = [
    pdaMeta(ring ? 'silver-ring-state' : 'silver-state'),
    ...(!ring ? [pdaMeta('silver-lifecycle')] : []),
    ...(!legacy ? [
      { config: { __kind: 'Literal', address: market }, isSigner: false, isWritable: false },
      { config: { __kind: 'AccountPda', accountIndex: 7, seeds: [
        { __kind: 'Literal', bytes: text('silver-market-listing') },
        { __kind: 'AccountKey', index: 1 },
      ] }, isSigner: false, isWritable: true },
    ] : []),
  ];
  const extraBytes = Buffer.from(getExtraAccountMetasEncoder().encode(extraMetas));
  Buffer.from('692565c54bfb661a', 'hex').copy(extraBytes);
  extraBytes.writeUInt32LE(4 + 35 * extraMetas.length, 8);
  const price = 1_000_000_001n;
  const listingBytes = Buffer.alloc(320);
  Buffer.from('ERSMKV1\0').copy(listingBytes);
  listingBytes[8] = 1; listingBytes[9] = 1; listingBytes[10] = 1;
  raw(mint).copy(listingBytes, 16); raw(seller).copy(listingBytes, 48);
  raw(source).copy(listingBytes, 80);
  listingBytes.writeBigUInt64LE(price, 112);
  listingBytes.writeBigUInt64LE(1n, 120);
  raw(royalty).copy(listingBytes, 128); raw(platform).copy(listingBytes, 160);
  listingBytes.writeBigUInt64LE(1n, 192);
  raw(silver).copy(listingBytes, 272);
  const configBytes = Buffer.alloc(137);
  configBytes[0] = 1;
  raw(listCancel ? '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk' : key())
    .copy(configBytes, 1);
  configBytes.writeBigUInt64LE(1n, 33);
  raw(royalty).copy(configBytes, 41);
  raw(platform).copy(configBytes, 73);
  raw(silver).copy(configBytes, 105);
  accountFile('mint', mint, TOKEN_2022_PROGRAM_ADDRESS, mintBytes);
  accountFile('state', state, silver, stateBytes);
  if (!ring) accountFile('lifecycle', lifecycle, silver, lifeBytes);
  accountFile('extra', extra, silver, extraBytes);
  if (!listCancel) accountFile('listing', listing, market, listingBytes);
  else accountFile('config', config, market, configBytes);
  accountFile('source', source, TOKEN_2022_PROGRAM_ADDRESS,
    token(seller, 1, listCancel ? null : authority, listCancel ? 0 : 1));
  accountFile('destination', destination, TOKEN_2022_PROGRAM_ADDRESS, token(buyer, 0, null, 0));
  const manifest = { market, silver, buyer, seller, royalty, platform,
    lazy: legacy, kind: ring ? 'SILVER_RING' : 'SILVER_BOX',
    mint, state, lifecycle, extra, listing, config, authority, source, destination,
    priceLamports: price.toString() };
  writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest));
  console.log(JSON.stringify({ fixture: ring ? 'lazy-ring-prepared'
    : lazy ? 'lazy-list-cancel-prepared'
    : listCancel ? 'list-cancel-prepared' : 'prepared',
    market, silver, buyer,
    mint, listing, extraBytes: extraBytes.length }));
} else if (process.argv[2] === 'simulate' ||
    process.argv[2] === 'simulate-list-cancel' ||
    process.argv[2] === 'simulate-lazy-list-cancel' ||
    process.argv[2] === 'simulate-lazy-ring') {
  const fixture = JSON.parse(readFileSync(join(scratch, 'manifest.json')));
  const url = process.env.MARKET_LOCAL_RPC;
  assert(url === 'http://127.0.0.1:18999' ||
    (process.env.MARKET_LOCAL_DOCKER_IP &&
      url === `http://${process.env.MARKET_LOCAL_DOCKER_IP}:18999`),
  'Disposable loopback or explicitly verified Docker bridge only');
  let id = 0;
  const rpc = async (method, params = []) => {
    const response = await fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.error) throw Error(JSON.stringify(body.error));
    return body.result;
  };
  const lifetime = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  if (process.argv[2] !== 'simulate') {
    const common = { marketProgramId: fixture.market, silverProgramId: fixture.silver,
      mintAddress: fixture.mint, kind: fixture.kind ?? 'SILVER_BOX', sellerAddress: fixture.seller,
      sourceTokenAddress: fixture.source, nonce: 1,
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: Number(lifetime.lastValidBlockHeight) };
    const list = await buildSilverMarketplaceListMessage({ ...common,
      priceLamports: fixture.priceLamports });
    const cancel = await buildSilverMarketplaceCancelMessage(common);
    const decodeIx = compiled => getInstructionsFromCompiledTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(
        Buffer.from(compiled.messageBase64, 'base64')))[0];
    const listIx = decodeIx(list);
    const cancelIx = decodeIx(cancel);
    const simulate = async instructions => {
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayer(address(fixture.seller), message);
      message = setTransactionMessageLifetimeUsingBlockhash({
        blockhash: address(lifetime.blockhash),
        lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
      }, message);
      message = appendTransactionMessageInstructions(instructions, message);
      const compiled = compileTransactionMessage(message);
      assert.equal(compiled.header.numSignerAccounts, 1);
      const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
      const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), bytes]);
      assert(tx.length <= 1232);
      const result = (await rpc('simulateTransaction', [tx.toString('base64'), {
        encoding: 'base64', sigVerify: false, commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [fixture.listing, fixture.source, fixture.extra] },
      }])).value;
      return { result, sizeBytes: tx.length };
    };
    const { result, sizeBytes } = await simulate([listIx, cancelIx]);
    const listing = result.accounts?.[0];
    const source = result.accounts?.[1];
    const extra = result.accounts?.[2];
    const sourceBytes = source && Buffer.from(source.data[0], 'base64');
    console.log(JSON.stringify({ fixture: 'list-cancel', err: result.err,
      sizeBytes, unitsConsumed: result.unitsConsumed,
      listingPhase: listing && Buffer.from(listing.data[0], 'base64')[9],
      tokenAmount: sourceBytes?.readBigUInt64LE(64).toString(),
      delegateOption: sourceBytes?.readUInt32LE(72),
      eamBytes: extra && Buffer.from(extra.data[0], 'base64').length,
      logs: result.logs }));
    assert.equal(result.err, null);
    assert.equal(Buffer.from(listing.data[0], 'base64')[9], 4);
    assert.equal(sourceBytes.readBigUInt64LE(64), 1n);
    assert.equal(sourceBytes.readUInt32LE(72), 0);
    assert.equal(Buffer.from(extra.data[0], 'base64').readUInt32LE(12),
      fixture.kind === 'SILVER_RING' ? 3 : 4);
    const replay = await simulate([listIx, cancelIx, cancelIx]);
    const duplicate = await simulate([listIx, listIx]);
    assert.notEqual(replay.result.err, null, 'Cancelled listing replay must fail');
    assert.notEqual(duplicate.result.err, null, 'Duplicate active listing must fail');
    console.log(JSON.stringify({ fixture: 'list-cancel-guards',
      replayError: replay.result.err, duplicateError: duplicate.result.err }));
    if (fixture.lazy) {
      const swapped = (index, replacement) => ({ ...listIx, accounts:
        listIx.accounts.map((account, position) => position === index
          ? { ...account, address: address(replacement) } : account) });
      for (const [label, index, replacement] of [
        ['wrong-config', 1, fixture.source],
        ['wrong-eam', 8, fixture.listing],
        ['wrong-programdata', 12, fixture.config],
      ]) {
        const negative = await simulate([swapped(index, replacement)]);
        assert.notEqual(negative.result.err, null, `${label} must fail closed`);
        console.log(JSON.stringify({ fixture: label, err: negative.result.err }));
      }
    }
  } else {
  const candidate = await buildSilverMarketplaceBuyMessage({
    marketProgramId: fixture.market, silverProgramId: fixture.silver,
    mintAddress: fixture.mint, kind: 'SILVER_BOX',
    sellerAddress: fixture.seller, sourceTokenAddress: fixture.source,
    buyerAddress: fixture.buyer, royaltyAddress: fixture.royalty,
    platformAddress: fixture.platform, priceLamports: fixture.priceLamports,
    nonce: 1, blockhash: lifetime.blockhash,
    lastValidBlockHeight: Number(lifetime.lastValidBlockHeight),
  });
  assert.equal(candidate.destination, fixture.destination);
  const message = Buffer.from(candidate.messageBase64, 'base64');
  const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
  const observed = [fixture.buyer, fixture.seller, fixture.royalty,
    fixture.platform, fixture.source, fixture.destination, fixture.listing,
    fixture.state];
  const before = await Promise.all(observed.map(async key =>
    (await rpc('getAccountInfo', [key, { encoding: 'base64' }])).value));
  const result = (await rpc('simulateTransaction', [tx.toString('base64'), {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed',
    innerInstructions: true, accounts: { encoding: 'base64', addresses: observed },
  }])).value;
  const after = result.accounts;
  const amount = account => account &&
    Buffer.from(account.data[0], 'base64').readBigUInt64LE(64);
  const listingPhase = account => account && Buffer.from(account.data[0], 'base64')[9];
  const cooldown = account => account &&
    Buffer.from(account.data[0], 'base64').readBigInt64LE(196);
  const balance = account => BigInt(account?.lamports ?? 0);
  const legs = [fixture.seller, fixture.royalty, fixture.platform].map((_, offset) =>
    (balance(after[offset + 1]) - balance(before[offset + 1])).toString());
  console.log(JSON.stringify({ fixture: 'atomic-buy', err: result.err,
    sizeBytes: candidate.sizeBytes, unitsConsumed: result.unitsConsumed,
    legs, source: amount(after?.[4])?.toString(),
    destination: amount(after?.[5])?.toString(),
    listingPhase: listingPhase(after?.[6]),
    cooldownBefore: cooldown(before[7])?.toString(),
    cooldownAfter: cooldown(after?.[7])?.toString(),
    logs: result.logs }));
  assert.equal(result.err, null, 'Exact atomic M -> Token-2022 -> S buy failed');
  assert.deepEqual(legs, [candidate.priceLamports,
    candidate.royaltyLamports, candidate.platformLamports]);
  assert.equal(amount(after[4]), 0n);
  assert.equal(amount(after[5]), 1n);
  assert.equal(listingPhase(after[6]), 3);
  assert.equal(cooldown(after[7]), cooldown(before[7]));

  // The same migrated EAM must not classify a seller-authorized direct
  // transfer as a sale. It leaves the listing stale and starts 48h cooldown.
  const directData = Buffer.alloc(10);
  directData[0] = 12;
  directData.writeBigUInt64LE(1n, 1);
  const directAccounts = [
    [fixture.source, AccountRole.WRITABLE], [fixture.mint, AccountRole.READONLY],
    [fixture.destination, AccountRole.WRITABLE],
    [fixture.seller, AccountRole.WRITABLE_SIGNER],
    [fixture.extra, AccountRole.READONLY], [fixture.state, AccountRole.WRITABLE],
    [fixture.lifecycle, AccountRole.WRITABLE],
    [fixture.market, AccountRole.READONLY], [fixture.listing, AccountRole.WRITABLE],
    [fixture.silver, AccountRole.READONLY],
  ].map(([key, role]) => ({ address: address(key), role }));
  let directMessage = createTransactionMessage({ version: 'legacy' });
  directMessage = setTransactionMessageFeePayer(address(fixture.buyer), directMessage);
  directMessage = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: address(lifetime.blockhash),
    lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, directMessage);
  directMessage = appendTransactionMessageInstructions([{
    programAddress: TOKEN_2022_PROGRAM_ADDRESS, data: directData,
    accounts: directAccounts,
  }], directMessage);
  const directCompiled = compileTransactionMessage(directMessage);
  assert.equal(directCompiled.header.numSignerAccounts, 2);
  const directBytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(directCompiled));
  const directTx = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), directBytes]);
  const direct = (await rpc('simulateTransaction', [directTx.toString('base64'), {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [fixture.state, fixture.listing] },
  }])).value;
  const directUntil = cooldown(direct.accounts?.[0]);
  console.log(JSON.stringify({ fixture: 'owner-direct-transfer', err: direct.err,
    unitsConsumed: direct.unitsConsumed, cooldownAfter: directUntil?.toString(),
    listingPhase: listingPhase(direct.accounts?.[1]), logs: direct.logs }));
  assert.equal(direct.err, null);
  assert(directUntil > cooldown(before[7]));
  assert.equal(listingPhase(direct.accounts[1]), 1);
  }
} else {
  throw Error('Use prepare or simulate');
}
