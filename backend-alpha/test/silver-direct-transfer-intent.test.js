import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, getExtraAccountMetasEncoder, getMintEncoder,
  getTokenEncoder, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { buildSilverDirectTransferMessage } from '../src/silver-direct-transfer-intent.js';

const SILVER = '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX';
const MARKET = 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j';
const key = () => bs58.encode(randomBytes(32));
const text = value => new TextEncoder().encode(value);
const raw = value => getAddressEncoder().encode(address(value));
const pda = async (program, label, mint) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds: [text(label), raw(mint)],
}))[0];
const account = (owner, bytes) => ({ owner, data: [Buffer.from(bytes).toString('base64'),
  'base64'] });

async function fixture(kind, marketAware) {
  const mint = key(), sender = key(), recipient = key(), source = key();
  const eam = await pda(SILVER, 'extra-account-metas', mint);
  const [destination] = await findAssociatedTokenPda({ mint: address(mint),
    owner: address(recipient), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const box = kind === 'SILVER_BOX';
  const pdaMeta = name => ({ config: { __kind: 'ProgramPda', seeds: [
    { __kind: 'Literal', bytes: text(name) }, { __kind: 'AccountKey', index: 1 },
  ] }, isSigner: false, isWritable: true });
  const metas = [pdaMeta(box ? 'silver-state' : 'silver-ring-state'),
    ...(box ? [pdaMeta('silver-lifecycle')] : []),
    ...(marketAware ? [{ config: { __kind: 'Literal', address: MARKET },
      isSigner: false, isWritable: false },
    { config: { __kind: 'AccountPda', accountIndex: box ? 7 : 6, seeds: [
      { __kind: 'Literal', bytes: text('silver-market-listing') },
      { __kind: 'AccountKey', index: 1 },
    ] }, isSigner: false, isWritable: true }] : [])];
  const eamBytes = Buffer.from(getExtraAccountMetasEncoder().encode(metas));
  Buffer.from('692565c54bfb661a', 'hex').copy(eamBytes);
  eamBytes.writeUInt32LE(4 + 35 * metas.length, 8);
  const mintBytes = getMintEncoder().encode({ mintAuthority: null, supply: 1n,
    decimals: 0, isInitialized: true, freezeAuthority: null,
    extensions: [{ __kind: 'TransferHook',
      authority: '11111111111111111111111111111111', programId: SILVER }] });
  const sourceBytes = getTokenEncoder().encode({ mint, owner: sender,
    amount: 1n, delegate: key(), state: 'Initialized', isNative: null,
    delegatedAmount: 1n, closeAuthority: null, extensions: [] });
  const map = new Map([[mint, account(TOKEN_2022_PROGRAM_ADDRESS, mintBytes)],
    [source, account(TOKEN_2022_PROGRAM_ADDRESS, sourceBytes)],
    [eam, account(SILVER, eamBytes)]]);
  const readAccount = async value => map.get(value) ?? null;
  const rpc = { getAccountInfo: value => ({ send: async () => ({ value: await readAccount(value) }) }) };
  return { input: { rpc, readAccount, kind, mintAddress: mint,
    sourceTokenAddress: source, senderAddress: sender,
    recipientAddress: recipient, blockhash: key(), lastValidBlockHeight: 123 },
  map, eam, sender, mint, recipient, destination };
}

for (const kind of ['SILVER_BOX', 'SILVER_RING'])
  for (const marketAware of [false, true])
    test(`${kind} ${marketAware ? 'market-aware' : 'legacy'} current EAM owner Send`,
      async () => {
        const { input, sender, mint, recipient, destination } = await fixture(kind,
          marketAware);
        const candidate = await buildSilverDirectTransferMessage(input);
        assert.equal(candidate.marketAware, marketAware);
        assert.equal(candidate.destinationTokenAddress, destination);
        assert.equal(candidate.createsRecipientAta, true);
        const compiled = getCompiledTransactionMessageDecoder().decode(
          Buffer.from(candidate.messageBase64, 'base64'));
        assert.equal(compiled.header.numSignerAccounts, 1);
        assert.equal(compiled.staticAccounts[0], sender);
        assert.equal(compiled.instructions.length, 2);
        assert(compiled.staticAccounts.includes(mint));
        assert(compiled.staticAccounts.includes(recipient));
        assert.equal(compiled.staticAccounts.includes(MARKET), marketAware);
        assert(candidate.sizeBytes <= 1232);
      });

test('wrong source owner and changed EAM fail before sign', async () => {
  const { input, map, eam } = await fixture('SILVER_RING', true);
  const source = map.get(input.sourceTokenAddress);
  const wrong = getTokenEncoder().encode({ mint: input.mintAddress,
    owner: key(), amount: 1n, delegate: null, state: 'Initialized',
    isNative: null, delegatedAmount: 0n, closeAuthority: null, extensions: [] });
  map.set(input.sourceTokenAddress, account(TOKEN_2022_PROGRAM_ADDRESS, wrong));
  await assert.rejects(buildSilverDirectTransferMessage(input), /source mismatch/);
  map.set(input.sourceTokenAddress, source);
  map.set(eam, account(SILVER, Buffer.alloc(32)));
  await assert.rejects(buildSilverDirectTransferMessage(input), /EAM/);
});
