import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createSilverMarketplaceReader } from '../src/silver-marketplace-read.js';

const key = () => bs58.encode(randomBytes(32));
const bytes = value => Buffer.from(bs58.decode(value));
const text = value => new TextEncoder().encode(value);
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const wrapped = (owner, data) => ({ owner, data: [data.toString('base64'), 'base64'] });

test('Marketplace simulation and submission pass the already encoded transaction to RPC', async () => {
  const rawBase64 = Buffer.from([1, 2, 3]).toString('base64');
  const calls = [];
  const rpc = {
    getGenesisHash: () => ({ send: async () => 'devnet-test' }),
    simulateTransaction: (raw, options) => ({ send: async () => {
      calls.push(['simulate', raw, options]);
      return { value: { err: null } };
    } }),
    sendTransaction: (raw, options) => ({ send: async () => {
      calls.push(['send', raw, options]);
      return 'signature';
    } }),
  };
  const reader = createSilverMarketplaceReader({ rpcUrl: 'private-test-rpc',
    marketProgramId: key(), silverProgramId: key(), expectedGenesisHash: 'devnet-test', rpc });
  assert.deepEqual(await reader.simulate(rawBase64), { err: null });
  assert.equal(await reader.send(rawBase64), 'signature');
  assert.equal(calls[0][1], rawBase64);
  assert.equal(calls[1][1], rawBase64);
  assert.equal(calls[0][2].sigVerify, true);
  assert.equal(calls[1][2].skipPreflight, false);
});

test('finalized listing projection distinguishes active source from stale transfer', async () => {
  const market = key(), silver = key(), mint = key(), seller = key(), source = key();
  const vault = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
  const configKey = await pda(market, text('silver-market-config'));
  const listingKey = await pda(market, text('silver-market-listing'), bytes(mint));
  const authority = await pda(market, text('silver-market-authority'));
  const stateKey = await pda(silver, text('silver-ring-state'), bytes(mint));
  const config = Buffer.alloc(137);
  config[0] = 1;
  bytes(vault).copy(config, 1);
  config.writeBigUInt64LE(1n, 33);
  bytes(vault).copy(config, 41);
  bytes(vault).copy(config, 73);
  bytes(silver).copy(config, 105);
  const listing = Buffer.alloc(320);
  Buffer.from('ERSMKV1\0').copy(listing);
  listing[8] = 1; listing[9] = 1; listing[10] = 2;
  bytes(mint).copy(listing, 16);
  bytes(seller).copy(listing, 48);
  bytes(source).copy(listing, 80);
  listing.writeBigUInt64LE(100_000_000_000n, 112);
  listing.writeBigUInt64LE(1n, 120);
  bytes(vault).copy(listing, 128);
  bytes(vault).copy(listing, 160);
  listing.writeBigUInt64LE(1n, 192);
  listing.writeBigUInt64LE(99n, 264);
  bytes(silver).copy(listing, 272);
  const state = Buffer.alloc(576);
  Buffer.from('ERSRGV1\0').copy(state);
  bytes(mint).copy(state, 16);
  const accounts = new Map([
    [configKey, wrapped(market, config)],
    [listingKey, wrapped(market, listing)],
    [stateKey, wrapped(silver, state)],
    [source, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: { parsed: { info: {
      mint, owner: seller, tokenAmount: { amount: '1' }, delegate: authority,
      delegatedAmount: { amount: '1' },
    } } } }],
  ]);
  let discovered = 0;
  const discoveredListing = Buffer.from(listing);
  discoveredListing.writeBigUInt64LE(9n, 112); // Discovery cannot set the displayed price.
  let discoveryGenesis = 'devnet-test';
  const discoveryRpc = {
    getGenesisHash: () => ({ send: async () => discoveryGenesis }),
    getProgramAccounts: () => ({ send: async () => {
      discovered += 1;
      return [{ pubkey: listingKey, account: wrapped(market, discoveredListing) }];
    } }),
  };
  const rpc = {
    getGenesisHash: () => ({ send: async () => 'devnet-test' }),
    getAccountInfo: account => ({ send: async () => ({ value: accounts.get(account) ?? null }) }),
  };
  const reader = createSilverMarketplaceReader({ rpcUrl: 'stub', rpc, discoveryRpc,
    marketProgramId: market, silverProgramId: silver,
    expectedGenesisHash: 'devnet-test' });
  assert.deepEqual(await reader.readConfig(), { address: configKey, version: '1',
    royaltyAddress: vault, platformAddress: vault });
  const live = await reader.readListing(mint);
  assert.equal(live.sourceReady, true);
  assert.equal(live.buyerDebitLamports, '106000000000');
  assert.equal(live.royaltyLamports, '4000000000');
  assert.equal(live.platformLamports, '2000000000');
  const found = await reader.listActive();
  assert.equal(found.length, 1);
  assert.equal(found[0].priceLamports, '100000000000');
  assert.equal(discovered, 1);
  accounts.get(source).data.parsed.info.owner = key();
  assert.equal((await reader.readListing(mint)).sourceReady, false);
  assert.equal((await reader.listActive()).length, 0);
  accounts.get(source).data.parsed.info.owner = seller;
  listing[9] = 4;
  accounts.set(listingKey, wrapped(market, listing));
  assert.equal((await reader.readListing(mint)).state, 'CANCELLED');
  assert.equal((await reader.readListing(mint)).sourceReady, false);
  assert.equal((await reader.listActive()).length, 0);
  assert.equal(discovered, 3);
  discoveryGenesis = 'wrong-chain';
  await assert.rejects(reader.listActive(), /discovery RPC genesis mismatch/);
  assert.equal(discovered, 3);
});
