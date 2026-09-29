import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import bs58 from 'bs58';
import {
  AccountRole, address, appendTransactionMessageInstructions,
  compileTransactionMessage, createSolanaRpc, createTransactionMessage,
  getAddressEncoder, getBase64Decoder, getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder, getInstructionsFromCompiledTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const INVALID = { status: 400, body: { message: 'Invalid ERU transfer.' } };
const UNAVAILABLE = { status: 409, body: { message: 'ERU intent unavailable or already used.' } };
const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_INTENT_TTL_SLOTS = 600n;
const FIELDS = [
  ['source', true, false], ['mint', false, false], ['destination', true, false],
  ['treasury', true, false], ['authority', false, true], ['config', true, false],
  ['meta', false, false], ['sysvar', false, false], ['tokenProgram', false, false],
  ['hook', false, false], ['replay', true, false], ['authority', true, true],
  ['systemProgram', false, false],
];

function strictSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === value ? bytes : null;
}

function compileIntent(policy, lifetime, nonce, expirySlot) {
  const data = Buffer.alloc(25);
  data[0] = 1;
  data.writeBigUInt64LE(30_000_000_000n, 1);
  data.writeBigUInt64LE(nonce, 9);
  data.writeBigUInt64LE(expirySlot, 17);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: 600_000 }),
    {
      programAddress: address(policy.gateway), data,
      accounts: FIELDS.map(([name, isWritable, isSigner]) => ({
        address: address(policy[name]),
        role: isSigner
          ? isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
          : isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
    },
  ];
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(policy.authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  return Buffer.from(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)));
}

function expiryOf(intent, gateway) {
  const decoded = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(intent.message_base64, 'base64'));
  const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
  if (instructions.length !== 2 || instructions[1].programAddress !== gateway ||
      instructions[1].data.length !== 25) throw new Error('Invalid stored ERU intent');
  return Buffer.from(instructions[1].data).readBigUInt64LE(17);
}

function expectedSettlement(message, meta, policy) {
  const decoded = getCompiledTransactionMessageDecoder().decode(message);
  const checks = [
    [policy.source, -30_600_000_000n],
    [policy.destination, 30_000_000_000n],
    [policy.treasury, 600_000_000n],
  ];
  return checks.every(([account, delta]) => {
    const index = decoded.staticAccounts.indexOf(account);
    if (index < 0) return false;
    const balance = rows => rows?.find(row => Number(row.accountIndex) === index &&
      row.mint === policy.mint)?.uiTokenAmount?.amount;
    const before = balance(meta?.preTokenBalances);
    const after = balance(meta?.postTokenBalances);
    return before !== undefined && after !== undefined &&
      BigInt(after) - BigInt(before) === delta;
  });
}

function kitConnection(rpcUrl) {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async getGenesisHash() { return rpc.getGenesisHash().send(); },
    async getSlot() { return Number(await rpc.getSlot({ commitment: 'confirmed' }).send()); },
    async isBlockhashValid(hash) {
      const { value } = await rpc.isBlockhashValid(hash, { commitment: 'confirmed' }).send();
      return value;
    },
    async getAccountInfo(key) {
      const { value } = await rpc.getAccountInfo(address(key), { encoding: 'base64', commitment: 'confirmed' }).send();
      return value && { data: Buffer.from(value.data[0], 'base64') };
    },
    async getBlockHeight() {
      return Number(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    },
    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return value;
    },
    async getTokenAccountBalance(key) {
      const { value } = await rpc.getTokenAccountBalance(address(key), { commitment: 'confirmed' }).send();
      return { value };
    },
    async sendRawTransaction(raw) {
      return rpc.sendTransaction(getBase64Decoder().decode(raw), {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
      }).send();
    },
    async confirmTransaction({ signature, lastValidBlockHeight }) {
      while (Number(await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) <= lastValidBlockHeight) {
        const { value } = await rpc.getSignatureStatuses([signature],
          { searchTransactionHistory: true }).send();
        const status = value[0];
        if (status?.err) return { value: { err: status.err } };
        if (status?.confirmationStatus === 'finalized')
          return { value: { err: null } };
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      throw new Error('Gateway transaction confirmation expired');
    },
    async getSignatureStatus(signature) {
      const { value } = await rpc.getSignatureStatuses([signature],
        { searchTransactionHistory: true }).send();
      return value[0];
    },
    async getTransaction(signature) {
      return rpc.getTransaction(signature, {
        encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0,
      }).send();
    },
  };
}

export function createEruProof({ pool, policy, rpcUrl, connection, cluster = 'local-validator' }) {
  if (!pool || !policy || !['local-validator', 'devnet'].includes(cluster))
    throw new Error('Invalid ERU proof cluster');
  if (cluster === 'local-validator' && rpcUrl !== 'http://127.0.0.1:18889')
    throw new Error('ERU local proof requires isolated loopback validator');
  if (cluster === 'devnet' && rpcUrl !== 'http://127.0.0.1:18889' &&
      (!rpcUrl || new URL(rpcUrl).protocol !== 'https:' ||
       new URL(rpcUrl).hostname !== 'solana-devnet.g.alchemy.com'))
    throw new Error('ERU Devnet requires approved HTTPS RPC');
  if (cluster === 'devnet' && rpcUrl === 'http://127.0.0.1:18889' && !connection)
    throw new Error('Devnet loopback is test-only');
  connection ??= kitConnection(rpcUrl);
  for (const field of new Set(FIELDS.map(([name]) => name).concat('gateway'))) {
    if (address(policy[field]) !== policy[field]) throw new Error('Invalid ERU proof policy');
  }
  if (policy.sysvar !== INSTRUCTIONS_SYSVAR ||
      policy.systemProgram !== SYSTEM_PROGRAM ||
      policy.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS)
    throw new Error('Unexpected ERU proof programs');
  async function identity(client, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (await client.query(
      `SELECT a.id, b.wallet_address FROM alpha_sessions s
       JOIN alpha_accounts a ON a.id = s.account_id
       LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND a.verified_at IS NOT NULL`,
      [createHash('sha256').update(token).digest('hex')]
    )).rows[0] ?? null;
  }

  async function reconcile(token, { id } = {}) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return INVALID;
    const user = await identity(pool, token);
    if (!user) return UNAUTHORIZED;
    const intent = (await pool.query('SELECT * FROM alpha_eru_intents WHERE id = $1', [id])).rows[0];
    if (!intent || intent.account_id !== user.id || intent.cluster !== cluster ||
        intent.wallet_address !== user.wallet_address ||
        user.wallet_address !== policy.authority) return UNAVAILABLE;
    if (cluster === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS)
      return UNAVAILABLE;
    if (intent.status === 'confirmed') return { status: 200,
      body: { status: 'confirmed', transactionSignature: intent.transaction_signature } };
    if (intent.status === 'failed') return { status: 409, body: { status: 'failed' } };
    if (intent.status === 'pending') return { status: 200, body: { status: 'pending' } };
    if (intent.status !== 'unknown') return UNAVAILABLE;
    const unresolved = { status: 503,
      body: { status: 'unknown', message: 'Settlement status unknown; do not retry.' } };
    if (!intent.transaction_signature) return unresolved;

    let signature;
    try { signature = bs58.decode(intent.transaction_signature); } catch { return UNAVAILABLE; }
    const message = Buffer.from(intent.message_base64, 'base64');
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI, Buffer.from(getAddressEncoder().encode(address(policy.authority)))]),
      format: 'der', type: 'spki',
    });
    if (signature.length !== 64 || !verify(null, message, publicKey, signature) ||
        expiryOf(intent, policy.gateway) < 1n) return UNAVAILABLE;

    const chainStatus = await connection.getSignatureStatus(intent.transaction_signature);
    if (!chainStatus || chainStatus.confirmationStatus !== 'finalized') return unresolved;
    const chainTx = await connection.getTransaction(intent.transaction_signature);
    if (!chainTx?.transaction?.[0]) return unresolved;
    const expectedRaw = Buffer.concat([Buffer.from([1]), signature, message]);
    if (!Buffer.from(chainTx.transaction[0], 'base64').equals(expectedRaw)) return unresolved;
    if ((chainStatus.err === null) !== (chainTx.meta?.err === null)) return unresolved;
    if (chainStatus.err === null && !expectedSettlement(message, chainTx.meta, policy))
      return unresolved;
    const next = chainStatus.err === null ? 'confirmed' : 'failed';
    const updated = await pool.query(
      `UPDATE alpha_eru_intents SET status = $2
       WHERE id = $1 AND cluster = $3 AND transaction_signature = $4 AND status = 'unknown'`,
      [id, next, cluster, intent.transaction_signature]
    );
    if (!updated.rowCount) return reconcile(token, { id });
    return next === 'confirmed'
      ? { status: 200, body: { status: next, transactionSignature: intent.transaction_signature } }
      : { status: 409, body: { status: next } };
  }

  return {
    reconcile,
    async issue(token) {
      const user = await identity(pool, token);
      if (!user) return UNAUTHORIZED;
      if (!user.wallet_address || user.wallet_address !== policy.authority) return UNAVAILABLE;
      if (cluster === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS)
        return UNAVAILABLE;
      const replay = await connection.getAccountInfo(policy.replay, 'confirmed');
      const lastNonce = replay ? replay.data.readBigUInt64LE(0) : 0n;
      if (lastNonce !== 0n) return UNAVAILABLE;
      const currentSlot = await connection.getSlot();
      if (!Number.isSafeInteger(currentSlot) || currentSlot < 0) return UNAVAILABLE;
      const currentHeight = await connection.getBlockHeight('confirmed');
      const previous = (await pool.query(
        `SELECT * FROM alpha_eru_intents WHERE account_id = $1 AND cluster = $2
         ORDER BY nonce DESC LIMIT 1`,
        [user.id, cluster]
      )).rows[0];
      if (previous) {
        if (previous.status !== 'pending') return UNAVAILABLE;
        if (expiryOf(previous, policy.gateway) >= BigInt(currentSlot)) {
          if (Number(previous.last_valid_block_height) >= currentHeight &&
              await connection.isBlockhashValid(previous.blockhash))
            return { status: 200, body: { id: previous.id, cluster, message: previous.message_base64 } };
          return UNAVAILABLE;
        }
      }
      const nonce = previous ? BigInt(previous.nonce) + 1n : 1n;
      if (nonce >= 9_223_372_036_854_775_807n) return UNAVAILABLE;
      const expirySlot = cluster === 'devnet'
        ? BigInt(currentSlot) + DEVNET_INTENT_TTL_SLOTS : 9_999_999n;
      const lifetime = await connection.getLatestBlockhash('confirmed');
      if (!await connection.isBlockhashValid(lifetime.blockhash)) return UNAVAILABLE;
      const message = compileIntent(policy, lifetime, nonce, expirySlot);
      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO alpha_eru_intents
           (id, account_id, cluster, wallet_address, nonce, message_base64, blockhash,
            last_valid_block_height, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
          [id, user.id, cluster, policy.authority, nonce.toString(), message.toString('base64'),
            lifetime.blockhash, lifetime.lastValidBlockHeight]
        );
      } catch (error) {
        if (error.code === '23505') return UNAVAILABLE;
        throw error;
      }
      return { status: 200, body: { id, cluster, message: message.toString('base64') } };
    },

    async submit(token, { id, signatureBase64 } = {}) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return INVALID;
      const signature = strictSignature(signatureBase64);
      if (!signature) return INVALID;
      const client = await pool.connect();
      let intent;
      try {
        await client.query('BEGIN');
        const user = await identity(client, token);
        if (!user) { await client.query('ROLLBACK'); return UNAUTHORIZED; }
        if (user.wallet_address !== policy.authority) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        intent = (await client.query('SELECT * FROM alpha_eru_intents WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (cluster === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        if (!intent || intent.account_id !== user.id || intent.cluster !== cluster ||
            intent.wallet_address !== user.wallet_address ||
            intent.status !== 'pending' ||
            expiryOf(intent, policy.gateway) < BigInt(await connection.getSlot()) ||
            Number(intent.last_valid_block_height) < await connection.getBlockHeight('confirmed') ||
            !await connection.isBlockhashValid(intent.blockhash)) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        const message = Buffer.from(intent.message_base64, 'base64');
        const publicKey = createPublicKey({
          key: Buffer.concat([SPKI, Buffer.from(getAddressEncoder().encode(address(policy.authority)))]), format: 'der', type: 'spki',
        });
        if (!verify(null, message, publicKey, signature)) {
          await client.query('ROLLBACK'); return INVALID;
        }
        await client.query(
          `UPDATE alpha_eru_intents SET status = 'unknown', transaction_signature = $2
           WHERE id = $1`, [id, bs58.encode(signature)]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }

      try {
        const raw = Buffer.concat([Buffer.from([1]), signature,
          Buffer.from(intent.message_base64, 'base64')]);
        const txid = await connection.sendRawTransaction(raw, { skipPreflight: false });
        if (txid !== bs58.encode(signature)) throw new Error('Unexpected transaction signature');
        await connection.confirmTransaction({
          signature: txid,
          lastValidBlockHeight: Number(intent.last_valid_block_height),
        }, 'confirmed');
      } catch { /* The durable signed operation must be reconciled, not marked failed. */ }
      try { return await reconcile(token, { id }); }
      catch { return { status: 503,
        body: { status: 'unknown', message: 'Settlement status unknown; do not retry.' } }; }
    },
  };
}
