import { createHash } from 'node:crypto';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda,
  findExtraAccountMetaListPda,
  TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createEruProof, kitConnection } from './eru.js';
import { readEruHistory } from './eru-history.js';
import { verifyCooperEruDevnetConfig } from './cooper-eru-candidate-reader.js';

const UNAVAILABLE = { status: 409, body: { message: 'ERU intent unavailable or already used.' } };
const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const SYSTEM = '11111111111111111111111111111111';
const utf8 = value => new TextEncoder().encode(value);
const raw = value => getAddressEncoder().encode(address(value));

function tokenAccount(account, mint, owner) {
  return account?.owner === TOKEN_2022_PROGRAM_ADDRESS &&
    account.data?.length >= 165 && account.data[108] === 1 &&
    Buffer.from(account.data.subarray(0, 32)).equals(Buffer.from(raw(mint))) &&
    (!owner || Buffer.from(account.data.subarray(32, 64)).equals(Buffer.from(raw(owner))));
}

async function identity(pool, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return (await pool.query(`SELECT a.id, b.wallet_address, b.environment
    FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
    LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND a.verified_at IS NOT NULL`,
  [createHash('sha256').update(token).digest('hex')])).rows[0] ?? null;
}

// The local file policy is deliberately absent. Resolve every candidate from
// the current binding and the pinned, live canonical Gateway config.
export function createCanonicalEruSend({ pool, rpcUrl, connection, deployment, walletEnvironment }) {
  if (!pool || !rpcUrl || !deployment || !walletEnvironment)
    throw new Error('Canonical Send configuration missing');
  const chain = connection ?? kitConnection(rpcUrl);
  const fixed = {
    sysvar: 'Sysvar1nstructions1111111111111111111111111',
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, systemProgram: SYSTEM,
  };
  async function resolve(token, recipient = null) {
    const user = await identity(pool, token);
    if (!user) return { error: UNAUTHORIZED };
    if (!user.wallet_address || user.environment !== walletEnvironment)
      return { error: UNAVAILABLE };
    try {
      const wallet = address(user.wallet_address);
      const verified = await verifyCooperEruDevnetConfig({ chain, ...deployment });
      const [source] = await findAssociatedTokenPda({ owner: wallet, mint: verified.mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
      const [replay] = await getProgramDerivedAddress({ programAddress: verified.gateway,
        seeds: [utf8('nonce'), raw(verified.config), raw(wallet)] });
      const sourceAccount = await chain.getAccountInfo(source);
      const treasuryAccount = await chain.getAccountInfo(deployment.treasuryAddress);
      const mintAccount = await chain.getAccountInfo(verified.mint);
      const replayAccount = await chain.getAccountInfo(replay);
      if (source === deployment.reserveAddress ||
          source === deployment.treasuryAddress ||
          !tokenAccount(sourceAccount, verified.mint, wallet) ||
          !tokenAccount(treasuryAccount, verified.mint) ||
          mintAccount?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
          mintAccount.data?.length < 82 || mintAccount.data[44] !== 9 ||
          (replayAccount && !(
            replayAccount.owner === verified.gateway && replayAccount.data?.length === 8) &&
            !(replayAccount.owner === SYSTEM && replayAccount.data?.length === 0)))
        return { error: UNAVAILABLE };
      let destination;
      if (recipient !== null) {
        [destination] = await findAssociatedTokenPda({ owner: address(recipient),
          mint: verified.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
        const account = await chain.getAccountInfo(destination);
        if (account && !tokenAccount(account, verified.mint, recipient))
          return { error: UNAVAILABLE };
      }
      const policy = { ...fixed, source, mint: verified.mint,
        treasury: deployment.treasuryAddress, authority: wallet,
        config: verified.config, meta: verified.meta, hook: verified.hook,
        replay, gateway: verified.gateway, destination: destination ?? source };
      return { user, policy };
    } catch { return { error: UNAVAILABLE }; }
  }
  async function recoveryPolicy(token) {
    const user = await identity(pool, token);
    if (!user) return { error: UNAUTHORIZED };
    if (!user.wallet_address || user.environment !== walletEnvironment)
      return { error: UNAVAILABLE };
    try {
      const wallet = address(user.wallet_address);
      const gateway = address(deployment.gatewayProgramId);
      const hook = address(deployment.hookProgramId);
      const mint = address(deployment.mintAddress);
      const [config] = await getProgramDerivedAddress({ programAddress: gateway,
        seeds: [utf8('eru-config')] });
      const [meta] = await findExtraAccountMetaListPda({ mint }, { programAddress: hook });
      const [source] = await findAssociatedTokenPda({ owner: wallet, mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
      const [replay] = await getProgramDerivedAddress({ programAddress: gateway,
        seeds: [utf8('nonce'), raw(config), raw(wallet)] });
      return { user, policy: { ...fixed, source, mint,
        destination: source, treasury: address(deployment.treasuryAddress),
        authority: wallet, config, meta, hook, replay, gateway } };
    } catch { return { error: UNAVAILABLE }; }
  }
  function core(policy) {
    return createEruProof({ pool, policy, rpcUrl, connection: chain,
      cluster: 'devnet', namespace: 'canonical' });
  }
  async function storedMatches(id, user, policy) {
    const row = (await pool.query(`SELECT account_id, wallet_address, cluster, message_base64
      FROM alpha_eru_intents WHERE id = $1 AND intent_namespace = 'canonical'`, [id])).rows[0];
    if (!row || row.account_id !== user.id || row.wallet_address !== policy.authority ||
        row.cluster !== 'devnet') return false;
    try {
      const decoded = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(row.message_base64, 'base64'));
      const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
      const ix = instructions[2];
      const ata = instructions[1];
      const recipient = ata?.accounts?.[2]?.address;
      if (!recipient) return false;
      const [expectedDestination] = await findAssociatedTokenPda({ owner: recipient,
        mint: policy.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
      return instructions.length === 3 && decoded.staticAccounts[0] === policy.authority &&
        instructions[0]?.data?.length === 5 && instructions[0].data[0] === 2 &&
        Buffer.from(instructions[0].data).readUInt32LE(1) === 600_000 &&
        instructions[0]?.programAddress === 'ComputeBudget111111111111111111111111111111' &&
        ata.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS &&
        ata.data?.length === 1 && ata.data[0] === 1 &&
        ata.accounts?.[0]?.address === policy.authority &&
        ata.accounts?.[1]?.address === expectedDestination &&
        ata.accounts?.[3]?.address === policy.mint &&
        ata.accounts?.[4]?.address === SYSTEM &&
        ata.accounts?.[5]?.address === TOKEN_2022_PROGRAM_ADDRESS &&
        ix?.programAddress === policy.gateway && ix.data?.length === 25 &&
        ix.accounts?.length === 13 &&
        ix.data[0] === 1 && ix.accounts?.[0]?.address === policy.source &&
        ix.accounts?.[1]?.address === policy.mint &&
        ix.accounts?.[2]?.address === expectedDestination &&
        ix.accounts?.[3]?.address === policy.treasury &&
        ix.accounts?.[4]?.address === policy.authority &&
        ix.accounts?.[5]?.address === policy.config &&
        ix.accounts?.[6]?.address === policy.meta &&
        ix.accounts?.[7]?.address === fixed.sysvar &&
        ix.accounts?.[8]?.address === TOKEN_2022_PROGRAM_ADDRESS &&
        ix.accounts?.[9]?.address === policy.hook &&
        ix.accounts?.[10]?.address === policy.replay &&
        ix.accounts?.[11]?.address === policy.authority &&
        ix.accounts?.[12]?.address === SYSTEM;
    } catch { return false; }
  }
  return {
    async issue(token, request = {}) {
      const resolved = await resolve(token, request.recipient);
      return resolved.error ?? core(resolved.policy).issue(token, request);
    },
    async submit(token, request = {}) {
      const resolved = await resolve(token);
      if (resolved.error) return resolved.error;
      if (!await storedMatches(request.id, resolved.user, resolved.policy)) return UNAVAILABLE;
      return core(resolved.policy).submit(token, request);
    },
    async reconcile(token, request = {}) {
      const resolved = await recoveryPolicy(token);
      if (resolved.error) return resolved.error;
      if (!await storedMatches(request.id, resolved.user, resolved.policy)) return UNAVAILABLE;
      return core(resolved.policy).reconcile(token, request);
    },
    async history(token) {
      const user = await identity(pool, token);
      if (!user) return UNAUTHORIZED;
      if (!user.wallet_address || user.environment !== walletEnvironment) return UNAVAILABLE;
      return readEruHistory(pool, user, deployment.gatewayProgramId);
    },
  };
}
