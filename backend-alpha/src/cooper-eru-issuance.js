import { readPreparedCooperEru } from './cooper-eru-candidate-reader.js';
import { verifyCooperEruCandidateEnvelope } from './cooper-eru-intent.js';

const unavailable = () => new Error('Cooper ERU issuance unavailable');
const DIGEST = /^[a-f0-9]{64}$/;

// Internal unsigned checkpoint. Candidate resolution (including RPC) happens
// outside the DB transaction; the owner/hold is revalidated under the account
// lock before one immutable binding is inserted. The local attestation boundary
// may call it; no HTTP route, production signer or chain submission does.
export function createCooperEruUnsignedIssuance({ pool, candidateReader, cluster }) {
  if (!pool || typeof pool.connect !== 'function' ||
      typeof candidateReader?.read !== 'function' ||
      !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  return {
    async issue(accountId, operationId) {
      const existing = (await pool.query(`SELECT * FROM alpha_cooper_level_eru_issuances
        WHERE operation_id = $1 AND account_id = $2`, [operationId, accountId])).rows[0] ?? null;
      const candidate = await candidateReader.read(accountId, operationId, existing);
      if (!verifyCooperEruCandidateEnvelope(candidate) ||
          candidate.operationId !== operationId || candidate.cluster !== cluster ||
          !DIGEST.test(candidate.intentDigest) ||
          !Number.isSafeInteger(candidate.nonce) || candidate.nonce < 1 ||
          !Number.isSafeInteger(candidate.expirySlot) || candidate.expirySlot < 1 ||
          !/^[1-9][0-9]*$/.test(candidate.configEpoch ?? '')) throw unavailable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) throw unavailable();
        const prepared = await readPreparedCooperEru(client, accountId, operationId, cluster);
        if (candidate.reservationId !== prepared.reservation_id ||
            candidate.walletAddress !== prepared.wallet_address) throw unavailable();
        await client.query(`INSERT INTO alpha_cooper_level_eru_issuances
          (operation_id, account_id, reservation_id, wallet_address, cluster,
           genesis_hash, gateway_program_id, attestor_address, intent_digest,
           nonce, config_epoch, expiry_slot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (operation_id) DO NOTHING`,
        [operationId, accountId, prepared.reservation_id, prepared.wallet_address,
          cluster, candidate.genesisHash, candidate.gatewayProgramId,
          candidate.attestorAddress, candidate.intentDigest, candidate.nonce,
          candidate.configEpoch, candidate.expirySlot]);
        const stored = (await client.query(`SELECT * FROM alpha_cooper_level_eru_issuances
          WHERE operation_id = $1 FOR UPDATE`, [operationId])).rows[0];
        const expected = { operation_id: operationId, account_id: accountId,
          reservation_id: prepared.reservation_id, wallet_address: prepared.wallet_address,
          cluster, genesis_hash: candidate.genesisHash,
          gateway_program_id: candidate.gatewayProgramId,
          attestor_address: candidate.attestorAddress,
          intent_digest: candidate.intentDigest, nonce: String(candidate.nonce),
          config_epoch: candidate.configEpoch, expiry_slot: String(candidate.expirySlot) };
        if (!stored || Object.entries(expected).some(([key, value]) =>
          String(stored[key]) !== value)) throw unavailable();
        await client.query('COMMIT');
        return { candidate, operationId, intentDigest: stored.intent_digest };
      } catch (cause) {
        await client.query('ROLLBACK');
        if (cause.code === '23505' || cause.code === '23514') throw unavailable();
        throw cause;
      } finally { client.release(); }
    },
  };
}
