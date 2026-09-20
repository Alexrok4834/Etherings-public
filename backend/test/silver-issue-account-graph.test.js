import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRole, address } from '@solana/kit';
import { findExtraAccountMetaListPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { silverIssueAccounts } from '../../proofs/silver-first-entry/issue-account-graph.mjs';

const program = address('C4PqB6qN327TUrTVry98c42fh1MPmGPM2vPZR4PtpgEt');
const mint = address('DN27v1EbNKTzdTFeRqQTbKFzgBZAN1H6cqzsnqTQJDxn');

test('first-entry issuer uses canonical schema-3 meta-list PDA and exact account roles', async () => {
  const [extraMetas] = await findExtraAccountMetaListPda({ mint }, { programAddress: program });
  assert.equal(extraMetas, '5ubBjffcYkS7UievMTi7J3xRc4Y2o2Gnzi5dVoheTZkE');
  const keys = {
    issuer: address('11111111111111111111111111111112'),
    config: address('11111111111111111111111111111113'),
    mint,
    state: address('11111111111111111111111111111114'),
    token: address('11111111111111111111111111111115'),
    wallet: address('11111111111111111111111111111116'),
    authority: address('11111111111111111111111111111117'),
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    system: address('11111111111111111111111111111111'),
    collection: address('11111111111111111111111111111118'),
    extraMetas,
  };
  const expectedNames = ['issuer', 'config', 'mint', 'state', 'token', 'wallet',
    'authority', 'tokenProgram', 'system', 'collection', 'extraMetas'];
  const expectedRoles = [AccountRole.WRITABLE_SIGNER, AccountRole.READONLY,
    AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE_SIGNER,
    AccountRole.READONLY, AccountRole.READONLY, AccountRole.READONLY,
    AccountRole.READONLY, AccountRole.READONLY, AccountRole.WRITABLE];
  const accounts = silverIssueAccounts(keys, AccountRole);
  assert.equal(accounts.length, 11);
  assert.deepEqual(accounts.map(({ address: key }) => key), expectedNames.map((name) => keys[name]));
  assert.deepEqual(accounts.map(({ role }) => role), expectedRoles);
  assert.deepEqual(silverIssueAccounts(keys, AccountRole), accounts);

  const [otherMintMetas] = await findExtraAccountMetaListPda({
    mint: address('11111111111111111111111111111119'),
  }, { programAddress: program });
  assert.notEqual(otherMintMetas, extraMetas);
});
