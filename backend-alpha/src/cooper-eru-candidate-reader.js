import { createHash } from 'node:crypto';
import { address, createSolanaRpc, getAddressEncoder, getBase64Decoder,
  getProgramDerivedAddress } from '@solana/kit';
import { canonicalErt } from './m2e-ert-decimal.js';
import { buildCooperEruCandidateMessage } from './cooper-eru-intent.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSION = 'copper-level-up-v2';
const SYSTEM = '11111111111111111111111111111111';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const utf8 = value => new TextEncoder().encode(value);
const unavailable = () => new Error('Cooper ERU candidate unavailable');

// Gateway clears STAGE after a payment, but keeps the last payment's source,
// recipient, user, amount, fee and nonce in bytes 170..289. Those bytes are
// transaction state, not deployment identity. All other bytes remain pinned.
export function cooperEruStaticConfigSha256(data) {
  if (!(data instanceof Uint8Array) || data.length !== 330 || data[0] !== 1 ||
      data[169] !== 0) throw unavailable();
  const stable = Buffer.from(data);
  stable.fill(0, 170, 290);
  return createHash('sha256').update(stable).digest('hex');
}

const QUERY = `SELECT p.*, r.state AS reservation_state,
    c.level AS current_level, c.unspent_attribute_points AS current_points,
    c.comfort, c.charm, c.quality, c.luck,
    o.rules_version, o.request_fingerprint, o.response_snapshot,
    b.wallet_address AS current_wallet
  FROM alpha_cooper_level_eru_preparations p
  JOIN alpha_cooper_level_up_operations o ON o.id = p.operation_id
    AND o.account_id = p.account_id AND o.ring_id = p.ring_id
  JOIN alpha_hybrid_operations h ON h.id = p.hybrid_operation_id
    AND h.account_id = p.account_id AND h.wallet_address = p.wallet_address
    AND h.cluster = p.cluster AND h.operation_type = 'cooper_level_up'
    AND h.request_digest = p.request_digest AND h.ert_amount = p.ert_cost
    AND h.status = 'pending'
  JOIN alpha_ert_reservations r ON r.id = p.reservation_id
    AND r.operation_id = h.id AND r.account_id = p.account_id
    AND r.amount = p.ert_cost
  JOIN alpha_hybrid_outbox x ON x.operation_id = h.id
    AND x.payload_digest = p.request_digest AND x.state = 'pending'
  JOIN alpha_cooper_current_state c ON c.account_id = p.account_id
    AND c.ring_id = p.ring_id
  JOIN alpha_wallet_bindings b ON b.account_id = p.account_id
    AND b.wallet_address = p.wallet_address
  JOIN alpha_accounts a ON a.id = p.account_id AND a.verified_at IS NOT NULL
  WHERE p.account_id = $1 AND p.operation_id = $2`;

function checked(row, cluster) {
  if (!row || row.cluster !== cluster || row.status !== 'prepared' ||
      row.reservation_state !== 'held' || row.rules_version !== VERSION ||
      row.response_snapshot !== null || row.current_wallet !== row.wallet_address ||
      row.current_level !== row.expected_level ||
      row.current_points !== row.unspent_points_before) throw unavailable();
  const fingerprint = createHash('sha256').update(JSON.stringify({
    ownerUserId: row.account_id, ringId: row.ring_id,
    expectedCurrentLevel: row.expected_level, targetLevel: row.target_level,
    rulesVersion: VERSION,
  })).digest('hex');
  const requestDigest = createHash('sha256').update(JSON.stringify({
    rulesVersion: VERSION, operationId: row.operation_id,
    hybridOperationId: row.hybrid_operation_id,
    accountId: row.account_id, ringId: row.ring_id,
    walletAddress: row.wallet_address, cluster,
    expectedLevel: row.expected_level, targetLevel: row.target_level,
    unspentPointsBefore: row.unspent_points_before,
    attributes: { comfort: row.comfort, charm: row.charm,
      quality: row.quality, luck: row.luck },
    ertCost: canonicalErt(row.ert_cost),
    eruPrincipal: canonicalErt(row.eru_principal),
    eruFee: canonicalErt(row.eru_fee),
  })).digest('hex');
  if (row.request_fingerprint !== fingerprint || row.request_digest !== requestDigest)
    throw unavailable();
  return row;
}

export async function readPreparedCooperEru(client, accountId, operationId, cluster) {
  return checked((await client.query(QUERY, [accountId, operationId])).rows[0], cluster);
}

export function createCooperEruChainReader({ rpcUrl, cluster }) {
  if ((cluster === 'local-validator' && rpcUrl !== 'http://127.0.0.1:18889') ||
      (cluster === 'devnet' && (() => {
        try { const url = new URL(rpcUrl); return url.protocol !== 'https:' ||
          url.hostname !== 'solana-devnet.g.alchemy.com'; }
        catch { return true; }
      })()) || !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async getGenesisHash() { return rpc.getGenesisHash().send(); },
    async getAccountInfo(key) {
      const { value } = await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'confirmed',
      }).send();
      return value && { owner: value.owner, executable: value.executable,
        data: Buffer.from(value.data[0], 'base64') };
    },
    async getSlot() { return Number(await rpc.getSlot({ commitment: 'confirmed' }).send()); },
    async getBlockHeight() {
      return Number(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    },
    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash,
        lastValidBlockHeight: Number(value.lastValidBlockHeight) };
    },
    async isBlockhashValid(hash) {
      const { value } = await rpc.isBlockhashValid(address(hash), {
        commitment: 'confirmed',
      }).send();
      return value;
    },
    async sendRawTransaction(raw) {
      return rpc.sendTransaction(getBase64Decoder().decode(raw), {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed',
      }).send();
    },
  };
}

// Startup readback for a disabled-by-default DEV paid route. Do not trust a
// caller-supplied treasury, mint, Hook or attestor over canonical chain config.
export async function verifyCooperEruDevnetConfig({ chain, gatewayProgramId,
  hookProgramId, mintAddress, reserveAddress, treasuryAddress, vaultAddress,
  attestorAddress, configEpoch }) {
  if (await chain.getGenesisHash() !== DEVNET_GENESIS ||
      !Number.isSafeInteger(configEpoch) || configEpoch < 1) throw unavailable();
  const gateway = address(gatewayProgramId);
  const hook = address(hookProgramId);
  const mint = address(mintAddress);
  const [config] = await getProgramDerivedAddress({ programAddress: gateway,
    seeds: [utf8('eru-config')] });
  const [meta] = await getProgramDerivedAddress({ programAddress: hook,
    seeds: [utf8('extra-account-metas'), getAddressEncoder().encode(mint)] });
  const [gatewayAccount, hookAccount, state, metaAccount] = await Promise.all([
    chain.getAccountInfo(gateway), chain.getAccountInfo(hook),
    chain.getAccountInfo(config), chain.getAccountInfo(meta),
  ]);
  if (!gatewayAccount?.executable || !hookAccount?.executable ||
      state?.owner !== gateway || state.data?.length !== 330 ||
      state.data[0] !== 1 || state.data[169] !== 0 ||
      state.data.readBigUInt64LE(322) !== BigInt(configEpoch) ||
      metaAccount?.owner !== hook || metaAccount.data?.length !== 86) throw unavailable();
  for (const [offset, expected] of [[1, vaultAddress], [33, mint],
    [65, treasuryAddress], [97, hook], [129, reserveAddress],
    [290, attestorAddress]]) {
    if (!Buffer.from(state.data.subarray(offset, offset + 32))
      .equals(Buffer.from(getAddressEncoder().encode(address(expected))))) throw unavailable();
  }
  return { gateway, hook, mint, config, meta,
    configSha256: createHash('sha256').update(state.data).digest('hex'),
    configStaticSha256: cooperEruStaticConfigSha256(state.data) };
}

// Read-only, internal candidate resolver. It does not attest, sign, expose an
// endpoint, reserve a nonce or make a prepared operation executable.
export function createCooperEruCandidateReader({ pool, chain, cluster,
  expectedGenesisHash, gatewayProgramId, expectedConfigStaticSha256 = null }) {
  if (!pool || typeof pool.query !== 'function' ||
      !chain || ['getGenesisHash', 'getAccountInfo', 'getSlot', 'getBlockHeight',
        'getLatestBlockhash', 'isBlockhashValid'].some(name => typeof chain[name] !== 'function') ||
      !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  if (cluster === 'devnet' && expectedGenesisHash !== DEVNET_GENESIS) throw unavailable();
  const gateway = address(gatewayProgramId);
  const raw = value => getAddressEncoder().encode(address(value));
  const pda = async (...seeds) => (await getProgramDerivedAddress({
    programAddress: gateway, seeds,
  }))[0];
  const read = async (accountId, operationId, binding = null) => {
    if (typeof accountId !== 'string' || !UUID.test(accountId) ||
        typeof operationId !== 'string' || !UUID.test(operationId)) throw unavailable();
    const row = await readPreparedCooperEru(pool, accountId, operationId, cluster);
    const genesisHash = await chain.getGenesisHash();
    if (genesisHash !== expectedGenesisHash) throw unavailable();
    const program = await chain.getAccountInfo(gateway);
    if (!program?.executable) throw unavailable();
    const config = await pda(utf8('eru-config'));
    const configAccount = await chain.getAccountInfo(config);
    if (!configAccount || configAccount.owner !== gateway ||
        !(configAccount.data instanceof Uint8Array)) throw unavailable();
    if (expectedConfigStaticSha256 &&
        cooperEruStaticConfigSha256(configAccount.data) !== expectedConfigStaticSha256)
      throw unavailable();
    const wallet = address(row.wallet_address);
    const replay = await pda(utf8('nonce'), raw(config), raw(wallet));
    const operationReplay = await pda(utf8('cooper-level-up'), raw(config),
      raw(wallet), Buffer.from(operationId.replaceAll('-', ''), 'hex'));
    const replayAccount = await chain.getAccountInfo(replay);
    const usedOperation = await chain.getAccountInfo(operationReplay);
    const prefunded = account => account?.owner === SYSTEM && account.data?.length === 0;
    if ((usedOperation && !prefunded(usedOperation)) || (replayAccount &&
        !prefunded(replayAccount) &&
        (replayAccount.owner !== gateway || replayAccount.data?.length !== 8)))
      throw unavailable();
    const lastNonce = replayAccount && !prefunded(replayAccount)
      ? Buffer.from(replayAccount.data).readBigUInt64LE() : 0n;
    if (lastNonce >= BigInt(Number.MAX_SAFE_INTEGER - 1)) throw unavailable();
    const slot = await chain.getSlot();
    const height = await chain.getBlockHeight();
    const lifetime = await chain.getLatestBlockhash();
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > Number.MAX_SAFE_INTEGER - 600 ||
        !Number.isSafeInteger(height) || height < 0 ||
        !Number.isSafeInteger(lifetime?.lastValidBlockHeight) ||
        lifetime.lastValidBlockHeight <= height ||
        !await chain.isBlockhashValid(lifetime.blockhash)) throw unavailable();
    if (binding && (binding.operation_id !== operationId ||
        binding.account_id !== accountId || binding.reservation_id !== row.reservation_id ||
        binding.wallet_address !== wallet || binding.cluster !== cluster ||
        binding.genesis_hash !== genesisHash || binding.gateway_program_id !== gateway))
      throw unavailable();
    const nonce = binding ? Number(binding.nonce) : Number(lastNonce + 1n);
    const expirySlot = binding ? Number(binding.expiry_slot) : slot + 600;
    if (!Number.isSafeInteger(nonce) || BigInt(nonce) <= lastNonce ||
        !Number.isSafeInteger(expirySlot) || expirySlot <= slot)
      throw unavailable();
    const candidate = await buildCooperEruCandidateMessage({
      preparation: row, cluster, genesisHash, expectedGenesisHash,
      gatewayProgramId: gateway, configOwner: configAccount.owner,
      configData: configAccount.data, blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      nonce, expirySlot,
    });
    // No DB lock is held across RPC. Reject a changed owner/hold/state rather
    // than treating the earlier read as current authorization.
    const latest = await readPreparedCooperEru(pool, accountId, operationId, cluster);
    if (JSON.stringify(latest) !== JSON.stringify(row)) throw unavailable();
    return candidate;
  };
  return { read };
}
