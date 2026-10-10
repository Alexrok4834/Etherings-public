import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import bs58 from 'bs58';
import { AccountRole, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { buildSilverMarketplaceBuyMessage, buildSilverMarketplaceCancelMessage,
  buildSilverMarketplaceListMessage, exactSilverSaleLegs }
  from '../src/silver-marketplace-intent.js';

const key = () => bs58.encode(randomBytes(32));
const input = () => ({ marketProgramId: key(), silverProgramId: key(),
  mintAddress: key(), kind: 'SILVER_BOX',
  sellerAddress: key(), sourceTokenAddress: key(), buyerAddress: key(),
  royaltyAddress: key(), platformAddress: key(), priceLamports: '100000000000',
  nonce: 1, blockhash: key(), lastValidBlockHeight: 100 });

test('checked lamport legs round up independently and reject overflow', () => {
  assert.deepEqual(exactSilverSaleLegs('1'), {
    price: 1n, royalty: 1n, platform: 1n, total: 3n,
  });
  assert.deepEqual(exactSilverSaleLegs('100000000000'), {
    price: 100_000_000_000n, royalty: 4_000_000_000n,
    platform: 2_000_000_000n, total: 106_000_000_000n,
  });
  assert.throws(() => exactSilverSaleLegs((1n << 64n) - 1n), /exceeds u64/);
  assert.throws(() => exactSilverSaleLegs('0'), /Invalid lamport/);
});

test('exact one-signer atomic Box/Ring buy fits legacy packet including ATA creation', async () => {
  for (const kind of ['SILVER_BOX', 'SILVER_RING']) {
    const args = { ...input(), kind };
    for (const createBuyerAta of [false, true]) {
      const candidate = await buildSilverMarketplaceBuyMessage({ ...args, createBuyerAta });
      const compiled = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(candidate.messageBase64, 'base64'));
      const instructions = getInstructionsFromCompiledTransactionMessage(compiled);
      assert.equal(compiled.header.numSignerAccounts, 1);
      assert.equal(compiled.staticAccounts[0], args.buyerAddress);
      assert.equal(candidate.sizeBytes, 65 +
        Buffer.from(candidate.messageBase64, 'base64').length);
      assert(candidate.sizeBytes <= 1232);
      assert.deepEqual(instructions.map(ix => ix.programAddress), createBuyerAta
        ? ['ComputeBudget111111111111111111111111111111',
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', args.marketProgramId]
        : ['ComputeBudget111111111111111111111111111111', args.marketProgramId]);
      const buy = instructions.at(-1);
      assert.equal(buy.data[0], 24);
      assert.equal(Buffer.from(buy.data).readBigUInt64LE(1), 1n);
      assert.equal(Buffer.from(buy.data).readBigUInt64LE(9), 100_000_000_000n);
      assert.equal(buy.accounts.length, 16);
      assert.equal(buy.accounts[0].address, args.buyerAddress);
      assert.equal(buy.accounts[10].address, candidate.listing);
      assert.equal(buy.accounts[11].address, candidate.authority);
      assert.equal(buy.accounts[8].role, kind === 'SILVER_BOX'
        ? AccountRole.WRITABLE : AccountRole.READONLY);
      assert.equal(buy.accounts[14].address, args.marketProgramId);
      assert.equal(buy.accounts[15].address, args.silverProgramId);
    }
  }
});

test('royalty and platform may share one SOL recipient without merging fee legs', async () => {
  const args = input();
  args.royaltyAddress = '4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk';
  args.platformAddress = args.royaltyAddress;
  const candidate = await buildSilverMarketplaceBuyMessage(args);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  const buy = getInstructionsFromCompiledTransactionMessage(compiled).at(-1);
  assert.equal(buy.accounts[2].address, args.royaltyAddress);
  assert.equal(buy.accounts[3].address, args.royaltyAddress);
  assert.equal(candidate.royaltyLamports, '4000000000');
  assert.equal(candidate.platformLamports, '2000000000');
  assert.equal(candidate.buyerDebitLamports, '106000000000');
  await assert.rejects(buildSilverMarketplaceBuyMessage({ ...args,
    royaltyAddress: args.sellerAddress }), /Overlapping sale recipients/);
});

test('list and cancel bind seller, mint, listing nonce and one wallet signature', async () => {
  for (const kind of ['SILVER_BOX', 'SILVER_RING']) {
    const args = { ...input(), kind };
    const list = await buildSilverMarketplaceListMessage(args);
    const compiled = getCompiledTransactionMessageDecoder().decode(
      Buffer.from(list.messageBase64, 'base64'));
    const [ix] = getInstructionsFromCompiledTransactionMessage(compiled);
    assert.equal(compiled.header.numSignerAccounts, 1);
    assert.equal(compiled.staticAccounts[0], args.sellerAddress);
    assert.equal(ix.programAddress, args.marketProgramId);
    assert.equal(ix.data[0], 22);
    assert.equal(Buffer.from(ix.data).readBigUInt64LE(1), 100_000_000_000n);
    assert.equal(Buffer.from(ix.data).readBigUInt64LE(9), 1n);
    assert.equal(ix.accounts.length, 15);
    assert.equal(ix.accounts[6].address, list.listing);
    assert.equal(ix.accounts[8].address, list.extra);
    assert.equal(ix.accounts[8].role, AccountRole.WRITABLE);
    assert.equal(ix.accounts[11].address, args.silverProgramId);
    assert.equal(ix.accounts[12].address, list.silverProgramdata);
    assert.equal(ix.accounts[13].address, args.marketProgramId);
    assert.equal(ix.accounts[14].address, list.marketProgramdata);
    assert(list.sizeBytes <= 1232);
    const cancel = await buildSilverMarketplaceCancelMessage(args);
    const cancelCompiled = getCompiledTransactionMessageDecoder().decode(
      Buffer.from(cancel.messageBase64, 'base64'));
    const [cancelIx] = getInstructionsFromCompiledTransactionMessage(cancelCompiled);
    assert.equal(cancelCompiled.header.numSignerAccounts, 1);
    assert.equal(cancelCompiled.staticAccounts[0], args.sellerAddress);
    assert.equal(cancelIx.data[0], 23);
    assert.equal(Buffer.from(cancelIx.data).readBigUInt64LE(1), 1n);
    assert.equal(cancelIx.accounts[1].address, list.listing);
    assert.equal(cancelIx.accounts[2].address, args.sourceTokenAddress);
    assert(cancel.sizeBytes <= 1232);
  }
});
