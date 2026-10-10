import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifiedBoxMedia, verifiedBoxProvenance, verifiedSeriesCounter } from '../src/silver-chain.js';

test('Draw Box provenance requires exact source, result and binding digest', () => {
  const resultId = '22222222-2222-4222-8222-222222222222';
  const digest = 'a'.repeat(64);
  const fields = [['issuance_source', 'draw'], ['draw_result_id', resultId],
    ['entitlement_digest', digest]];
  const mint = { extensions: { __option: 'Some', value: [
    { __kind: 'TokenMetadata', additionalMetadata: fields }] } };
  assert.deepEqual(verifiedBoxProvenance(mint), { issuanceSource: 'draw',
    entitlementDigest: digest, drawResultId: resultId });
  fields[1][1] = 'wrong';
  assert.equal(verifiedBoxProvenance(mint), null);
  fields[1][1] = resultId;
  fields[0][1] = 'first-entry';
  assert.equal(verifiedBoxProvenance(mint), null);
});

test('Breeding Box provenance binds operation, both parents and pre-use counters', () => {
  const ids = ['11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'];
  const fields = [['issuance_source', 'cooper-breeding'],
    ['entitlement_digest', 'a'.repeat(64)], ['breeding_operation_id', ids[0]],
    ['breeding_first_parent', ids[1]], ['breeding_second_parent', ids[2]],
    ['breeding_first_uses', '0'], ['breeding_second_uses', '1']];
  const mint = { extensions: { __option: 'Some', value: [
    { __kind: 'TokenMetadata', additionalMetadata: fields }] } };
  assert.deepEqual(verifiedBoxProvenance(mint), { issuanceSource: 'cooper-breeding',
    entitlementDigest: 'a'.repeat(64), drawResultId: null,
    breedingOperationId: ids[0], breedingFirstParent: ids[1],
    breedingSecondParent: ids[2], breedingFirstUses: 0, breedingSecondUses: 1 });
  fields[6][1] = '2';
  assert.equal(verifiedBoxProvenance(mint), null);
  fields[6][1] = '1';
  fields[4][1] = ids[1];
  assert.equal(verifiedBoxProvenance(mint), null);
});

test('Box metadata URI/hash require canonical mint and issuance binding', () => {
  const mintAddress = 'mint';
  const issuanceId = 'a'.repeat(64);
  const collectionId = 'collection';
  const metadata = { __kind: 'TokenMetadata', mint: mintAddress,
    uri: 'ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png',
    additionalMetadata: [['kind', 'SILVER_BOX'], ['issuance_id', issuanceId],
      ['collection', collectionId], ['content_hash', 'b'.repeat(64)],
      ['rarity', 'SILVER'], ['series', 'ETHERINGS_NFT_V1'], ['serial', '1']] };
  const mint = { supply: 1n, decimals: 0, extensions: { __option: 'Some', value: [metadata,
    { __kind: 'MetadataPointer', metadataAddress: { value: mintAddress },
      authority: { __option: 'None' } }] } };
  assert.deepEqual(verifiedBoxMedia(mint, mintAddress, issuanceId, collectionId),
    { uri: metadata.uri, contentHash: 'b'.repeat(64), serial: '1' });
  const spent = { ...mint, supply: 0n };
  assert.deepEqual(verifiedBoxMedia(spent, mintAddress, issuanceId, collectionId), {});
  assert.deepEqual(verifiedBoxMedia(spent, mintAddress, issuanceId, collectionId,
    { allowSpent: true }),
  { uri: metadata.uri, contentHash: 'b'.repeat(64), serial: '1' });
  assert.deepEqual(verifiedBoxMedia(mint, 'wrong-mint', issuanceId, collectionId), {});
  assert.deepEqual(verifiedBoxMedia(mint, mintAddress, 'wrong-issuance', collectionId), {});
  metadata.additionalMetadata[3][1] = 'bad';
  assert.deepEqual(verifiedBoxMedia(mint, mintAddress, issuanceId, collectionId), {});
  metadata.additionalMetadata[3][1] = 'b'.repeat(64);
  metadata.additionalMetadata[5][1] = 'legacy';
  assert.deepEqual(verifiedBoxMedia(mint, mintAddress, issuanceId, collectionId), {});
});

test('series counter rejects malformed and mismatched account state', () => {
  const bytes = Buffer.alloc(24);
  bytes.write('ERSERV1\0', 0, 'ascii');
  bytes[8] = 1;
  bytes[9] = 1;
  bytes[10] = 1;
  bytes.writeBigUInt64LE(2n, 16);
  const raw = { owner: 'program', data: [bytes.toString('base64'), 'base64'] };
  assert.equal(verifiedSeriesCounter(raw, 'program', 1, '2'), true);
  assert.equal(verifiedSeriesCounter(raw, 'program', 2, '1'), false);
  assert.equal(verifiedSeriesCounter(raw, 'other', 1, '1'), false);
  assert.equal(verifiedSeriesCounter(raw, 'program', 1, '3'), false);
  assert.equal(verifiedSeriesCounter({ owner: 'program', data: [] }, 'program', 1, '1'), false);
});
