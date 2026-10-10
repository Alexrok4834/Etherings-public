import { createHash } from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { canonicalErt } from './m2e-ert-decimal.js';
import { buildCooperBreedingCandidateMessage } from './cooper-breeding-intent.js';
import { breedingBoxIdentity } from './cooper-breeding.js';
import { cooperEruStaticConfigSha256 } from './cooper-eru-candidate-reader.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SYSTEM = '11111111111111111111111111111111';
const unavailable = () => new Error('Cooper breeding candidate unavailable');
const sha = value => createHash('sha256').update(value, 'ascii').digest('hex');
const utf8 = value => new TextEncoder().encode(value);

const QUERY = `SELECT o.*, r.state AS reservation_state,
    h.status AS hybrid_status, x.state AS outbox_state,
    b.wallet_address AS current_wallet,
    a.verified_at,
    f.level AS first_level, f.breeding_uses AS first_current_uses,
    s.level AS second_level, s.breeding_uses AS second_current_uses,
    (SELECT count(*)::int FROM alpha_cooper_breeding_parent_holds p
      WHERE p.operation_id = o.id AND p.released_at IS NULL) AS active_holds
  FROM alpha_cooper_breeding_operations o
  JOIN alpha_ert_reservations r ON r.id = o.reservation_id
  JOIN alpha_hybrid_operations h ON h.id = o.hybrid_operation_id
    AND h.account_id = o.account_id AND h.wallet_address = o.wallet_address
    AND h.cluster = o.cluster AND h.operation_type = 'cooper_breeding'
    AND h.request_digest = o.request_digest AND h.ert_amount = o.ert_cost
  JOIN alpha_hybrid_outbox x ON x.operation_id = h.id
    AND x.payload_digest = o.request_digest
  JOIN alpha_wallet_bindings b ON b.account_id = o.account_id
  JOIN alpha_accounts a ON a.id = o.account_id
  JOIN alpha_cooper_current_state f ON f.account_id = o.account_id
    AND f.ring_id = o.first_ring_id
  JOIN alpha_cooper_current_state s ON s.account_id = o.account_id
    AND s.ring_id = o.second_ring_id
  WHERE o.account_id = $1 AND o.id = $2`;

export async function readPreparedCooperBreeding(client, accountId, operationId) {
  const row = (await client.query(QUERY, [accountId, operationId])).rows[0];
  if (!row || row.cluster !== 'devnet' || !row.verified_at ||
      row.reservation_state !== 'held' || row.hybrid_status !== 'pending' ||
      row.outbox_state !== 'pending' || row.current_wallet !== row.wallet_address ||
      row.first_level !== 20 || row.second_level !== 20 ||
      row.first_current_uses !== row.first_uses ||
      row.second_current_uses !== row.second_uses || row.active_holds !== 2)
    throw unavailable();
  const expectedFingerprint = sha(JSON.stringify({ accountId,
    firstRingId: row.first_ring_id, secondRingId: row.second_ring_id,
    rulesVersion: 'cooper-breeding-v1' }));
  const identity = breedingBoxIdentity(accountId, row.wallet_address, operationId,
    row.first_ring_id, row.second_ring_id, row.first_uses, row.second_uses);
  const expectedDigest = sha(JSON.stringify({ rulesVersion: 'cooper-breeding-v1',
    operationId, hybridOperationId: row.hybrid_operation_id, accountId,
    walletAddress: row.wallet_address, cluster: 'devnet',
    firstRingId: row.first_ring_id, secondRingId: row.second_ring_id,
    firstLevel: 20, secondLevel: 20, firstUses: row.first_uses,
    secondUses: row.second_uses, ertExact: canonicalErt(row.ert_cost),
    eruPrincipalExact: canonicalErt(row.eru_principal),
    eruFeeExact: canonicalErt(row.eru_fee), issuanceId: identity.issuanceId,
    entitlementDigest: identity.entitlementDigest }));
  if (row.request_fingerprint !== expectedFingerprint ||
      row.request_digest !== expectedDigest ||
      row.issuance_id !== identity.issuanceId ||
      row.entitlement_digest !== identity.entitlementDigest) throw unavailable();
  return row;
}

export function createCooperBreedingCandidateReader({ pool, chain,
  gatewayProgramId, expectedConfigStaticSha256 }) {
  if (typeof pool?.query !== 'function' ||
      ['getGenesisHash', 'getAccountInfo', 'getSlot', 'getBlockHeight',
        'getLatestBlockhash', 'isBlockhashValid'].some(key =>
        typeof chain?.[key] !== 'function') || !expectedConfigStaticSha256)
    throw unavailable();
  const gateway = address(gatewayProgramId);
  const raw = value => getAddressEncoder().encode(address(value));
  const pda = async (...seeds) => (await getProgramDerivedAddress({
    programAddress: gateway, seeds,
  }))[0];
  return {
    async read(accountId, operationId, binding = null) {
      const row = await readPreparedCooperBreeding(pool, accountId, operationId);
      if (await chain.getGenesisHash() !== GENESIS ||
          !(await chain.getAccountInfo(gateway))?.executable) throw unavailable();
      const config = await pda(utf8('eru-config'));
      const state = await chain.getAccountInfo(config);
      if (state?.owner !== gateway || state.data?.length !== 330 ||
          cooperEruStaticConfigSha256(state.data) !== expectedConfigStaticSha256)
        throw unavailable();
      const wallet = address(row.wallet_address);
      const replay = await pda(utf8('nonce'), raw(config), raw(wallet));
      const operationReplay = await pda(utf8('cooper-breeding'), raw(config),
        raw(wallet), Buffer.from(operationId.replaceAll('-', ''), 'hex'));
      const [nonceState, used] = await Promise.all([
        chain.getAccountInfo(replay), chain.getAccountInfo(operationReplay),
      ]);
      const unfunded = state => !state ||
        (state.owner === SYSTEM && state.data?.length === 0);
      if (!unfunded(used) || (!unfunded(nonceState) &&
          (nonceState.owner !== gateway || nonceState.data?.length !== 8)))
        throw unavailable();
      const previous = unfunded(nonceState) ? 0n :
        Buffer.from(nonceState.data).readBigUInt64LE();
      const [slot, height, lifetime] = await Promise.all([
        chain.getSlot(), chain.getBlockHeight(), chain.getLatestBlockhash(),
      ]);
      if (!Number.isSafeInteger(slot) || slot < 0 ||
          !Number.isSafeInteger(height) || height < 0 ||
          !Number.isSafeInteger(lifetime?.lastValidBlockHeight) ||
          lifetime.lastValidBlockHeight <= height ||
          !await chain.isBlockhashValid(lifetime.blockhash)) throw unavailable();
      if (binding && (binding.operation_id !== operationId ||
          binding.account_id !== accountId ||
          binding.reservation_id !== row.reservation_id ||
          binding.wallet_address !== wallet || binding.genesis_hash !== GENESIS ||
          binding.gateway_program_id !== gateway)) throw unavailable();
      const nonce = binding ? Number(binding.nonce) : Number(previous + 1n);
      const expirySlot = binding ? Number(binding.expiry_slot) : slot + 600;
      if (!Number.isSafeInteger(nonce) || BigInt(nonce) <= previous ||
          !Number.isSafeInteger(expirySlot) || expirySlot <= slot)
        throw unavailable();
      const candidate = await buildCooperBreedingCandidateMessage({ preparation: row,
        gatewayProgramId: gateway, configOwner: state.owner, configData: state.data,
        genesisHash: GENESIS, blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight, nonce, expirySlot });
      const latest = await readPreparedCooperBreeding(pool, accountId, operationId);
      if (JSON.stringify(latest) !== JSON.stringify(row)) throw unavailable();
      return candidate;
    },
  };
}
