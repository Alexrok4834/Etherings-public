import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import bs58 from 'bs58';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createSilverChainReader } from '../src/silver-chain.js';

const address = () => bs58.encode(randomBytes(32));

test('equipment reader distinguishes finalized owner loss, active cooldown and UNKNOWN', async () => {
  const programId = address();
  const mintAddress = address();
  const walletAddress = address();
  const bytes = Buffer.alloc(576);
  Buffer.from('ERSRGV1\0').copy(bytes);
  bs58.decode(mintAddress).copy(bytes, 16);
  bytes.writeBigUInt64LE(20n, 320);
  bytes.writeBigInt64LE(2500n, 328);
  let owned = 'one';
  let blockTime = 2000;
  let stateOwner = programId;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const { id, method } = JSON.parse(Buffer.concat(parts).toString());
    let result;
    if (method === 'getGenesisHash') result =
      'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if (method === 'getAccountInfo') result = { context: { slot: 1000 },
      value: { owner: stateOwner, data: [bytes.toString('base64'), 'base64'] } };
    else if (method === 'getTokenAccountsByOwner') result = { context: { slot: 1000 },
      value: owned === 'none' ? [] : [{ account: { owner: TOKEN_2022_PROGRAM_ADDRESS,
        data: { parsed: { info: { mint: mintAddress, owner: walletAddress,
          tokenAmount: { amount: owned === 'zero' ? '0' : '1' } } } } } }] };
    else if (method === 'getSlot') result = 1000;
    else if (method === 'getBlockTime') result = blockTime;
    else throw new Error(`Unexpected RPC ${method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reader = createSilverChainReader(`http://127.0.0.1:${server.address().port}`);
    reader.listOwnedRings = async () => [{ finalized: true, kind: 'SILVER_RING',
      programId, cluster: 'devnet', mintAddress, tokenOwner: walletAddress,
      lastDirectTransferSlot: '20', cooldownUntilUnixSeconds: '2500' }];
    const input = { programId, cluster: 'devnet', mintAddress, walletAddress };
    assert.deepEqual(await reader.readEquipmentEligibility(input),
      { state: 'COOLDOWN', cooldownUntilUnixSeconds: '2500' });
    reader.listOwnedRings = async () => [{ finalized: true, kind: 'SILVER_RING',
      programId, cluster: 'devnet', mintAddress, tokenOwner: walletAddress,
      lastDirectTransferSlot: '21', cooldownUntilUnixSeconds: '2500' }];
    assert.deepEqual(await reader.readEquipmentEligibility(input), { state: 'UNKNOWN' });
    reader.listOwnedRings = async () => [{ finalized: true, kind: 'SILVER_RING',
      programId, cluster: 'devnet', mintAddress, tokenOwner: walletAddress,
      lastDirectTransferSlot: '20', cooldownUntilUnixSeconds: '2500' }];
    blockTime = 3000;
    assert.equal((await reader.readEquipmentEligibility(input)).state, 'ELIGIBLE');
    owned = 'zero';
    assert.deepEqual(await reader.readEquipmentEligibility(input),
      { state: 'TRANSFERRED_AWAY' });
    owned = 'none';
    assert.deepEqual(await reader.readEquipmentEligibility(input),
      { state: 'TRANSFERRED_AWAY' });
    owned = 'one';
    blockTime = null;
    assert.deepEqual(await reader.readEquipmentEligibility(input), { state: 'UNKNOWN' });
    stateOwner = address();
    assert.deepEqual(await reader.readEquipmentEligibility(input), { state: 'UNKNOWN' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
