import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { createSilverChainReader } from '../src/silver-chain.js';

const b58 = () => bs58.encode(randomBytes(32));
const derive = (programId, seeds) => getProgramDerivedAddress({
  programAddress: address(programId), seeds,
});

test('Kit Silver reader accepts exact schema 2/3 and rejects counterfeit state', async () => {
  const programId = b58();
  const owner = b58();
  const issuanceId = createHash('sha256').update('silver-reader-test').digest('hex');
  const [mint] = await derive(programId, [new TextEncoder().encode('silver-mint'),
    Buffer.from(issuanceId, 'hex')]);
  const [state] = await derive(programId, [new TextEncoder().encode('silver-state'), bs58.decode(mint)]);
  const [collection] = await derive(programId, [new TextEncoder().encode('silver-collection')]);
  const [extraMetas] = await derive(programId, [new TextEncoder().encode('extra-account-metas'),
    bs58.decode(mint)]);
  const context = { slot: 200 };
  const issuanceSignature = bs58.encode(randomBytes(64));
  const latestSignature = bs58.encode(randomBytes(64));
  const stateBytes = Buffer.alloc(188);
  stateBytes.set([2, 1, 1, 1]);
  Buffer.from(issuanceId, 'hex').copy(stateBytes, 4);
  bs58.decode(mint).copy(stateBytes, 36);
  bs58.decode(collection).copy(stateBytes, 68);
  bs58.decode(owner).copy(stateBytes, 100);
  randomBytes(32).copy(stateBytes, 132);
  randomBytes(16).copy(stateBytes, 164);
  stateBytes.writeBigUInt64LE(100n, 180);
  const v3 = Buffer.concat([stateBytes, Buffer.alloc(16)]);
  v3[0] = 3;
  v3.writeBigUInt64LE(150n, 188);
  v3.writeBigInt64LE(1_790_000_000n, 196);
  const metaBytes = Buffer.alloc(47);
  Buffer.from('692565c54bfb661a', 'hex').copy(metaBytes);
  const snapshot = { bytes: stateBytes, stateOwner: programId, metaOwner: programId,
    meta: metaBytes, signature: issuanceSignature, signatureSlot: 100,
    signatureStatus: 'finalized', tokenAmount: '1' };
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
          : key === mint ? { owner: TOKEN_2022_PROGRAM_ADDRESS,
            data: { program: 'spl-token-2022', parsed: { info: { supply: '1', decimals: 0,
              mintAuthority: null, freezeAuthority: null } }, space: 100 } } : null;
      result = { context, value: account && { lamports: 1000000, executable: false,
        rentEpoch: 0, space: 204, ...account } };
    } else if (method === 'getTokenAccountsByOwner') {
      result = { context, value: snapshot.tokenAmount === '0' ? [] : [{ pubkey: b58(),
        account: { owner: TOKEN_2022_PROGRAM_ADDRESS, lamports: 1000000,
          executable: false, rentEpoch: 0, space: 200, data: { program: 'spl-token-2022',
            parsed: { info: { mint, owner, tokenAmount: { amount: snapshot.tokenAmount } } },
            space: 200 } } }] };
    } else if (method === 'getSignaturesForAddress') {
      result = [{ signature: snapshot.signature, slot: snapshot.signatureSlot, err: null,
        confirmationStatus: 'finalized', blockTime: 1790000000, memo: null }];
    } else if (method === 'getSignatureStatuses') {
      assert.equal(params[0][0], issuanceSignature);
      result = { context, value: [{ err: null,
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
    const legacy = await reader.readFinalized(input);
    assert.equal(legacy.stateSchemaVersion, 2);
    assert.equal(legacy.cooldownUntilUnixSeconds, undefined);
    assert.equal(legacy.finalizedSignature, issuanceSignature);
    snapshot.bytes = v3;
    snapshot.signature = latestSignature;
    snapshot.signatureSlot = 200;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.signatureSlot = 100;
    const current = await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature });
    assert.equal(current.stateSchemaVersion, 3);
    assert.equal(current.finalizedSignature, issuanceSignature);
    assert.equal(current.lastDirectTransferSlot, '150');
    assert.equal(current.cooldownUntilUnixSeconds, '1790000000');
    snapshot.signatureStatus = 'confirmed';
    assert.equal(await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature }), null);
    snapshot.signatureStatus = 'finalized';
    snapshot.signatureSlot = 200;
    assert.equal(await reader.readFinalized({ ...input,
      expectedFinalizedSignature: issuanceSignature }), null);
    snapshot.signatureSlot = 100;
    snapshot.bytes = Buffer.concat([v3, Buffer.from([0])]);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = Buffer.from(v3);
    snapshot.bytes[0] = 2;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = Buffer.from(v3);
    snapshot.meta = null;
    assert.equal(await reader.readFinalized(input), null);
    snapshot.meta = metaBytes;
    snapshot.metaOwner = b58();
    assert.equal(await reader.readFinalized(input), null);
    snapshot.metaOwner = programId;
    snapshot.stateOwner = b58();
    assert.equal(await reader.readFinalized(input), null);
    snapshot.stateOwner = programId;
    snapshot.bytes.writeBigInt64LE(-1n, 196);
    assert.equal(await reader.readFinalized(input), null);
    snapshot.bytes = v3;
    snapshot.tokenAmount = '0';
    assert.equal(await reader.readFinalized(input), null);
    await assert.rejects(reader.readFinalized({ ...input, cluster: 'local-validator' }),
      /cluster\/issuance mismatch/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
