import { readPreparedCooperBreeding } from './cooper-breeding-candidate-reader.js';
import { verifyCooperBreedingCandidateEnvelope } from './cooper-breeding-intent.js';

const unavailable = () => new Error('Cooper breeding issuance unavailable');

// Immutable unsigned binding; no signature or broadcast is produced here.
export function createCooperBreedingIssuance({ pool, candidateReader }) {
  if (typeof pool?.connect !== 'function' ||
      typeof candidateReader?.read !== 'function') throw unavailable();
  return {
    async issue(accountId, operationId) {
      const existing = (await pool.query(`SELECT * FROM alpha_cooper_breeding_issuances
        WHERE account_id = $1 AND operation_id = $2`, [accountId, operationId])).rows[0];
      const candidate = await candidateReader.read(accountId, operationId, existing);
      if (!verifyCooperBreedingCandidateEnvelope(candidate) ||
          candidate.operationId !== operationId) throw unavailable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!account) throw unavailable();
        const prepared = await readPreparedCooperBreeding(client, accountId, operationId);
        if (candidate.reservationId !== prepared.reservation_id ||
            candidate.walletAddress !== prepared.wallet_address ||
            candidate.issuanceId !== prepared.issuance_id) throw unavailable();
        await client.query(`INSERT INTO alpha_cooper_breeding_issuances
          (operation_id,account_id,reservation_id,wallet_address,cluster,genesis_hash,
           gateway_program_id,attestor_address,intent_digest,nonce,config_epoch,expiry_slot)
          VALUES ($1,$2,$3,$4,'devnet',$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (operation_id) DO NOTHING`,
        [operationId, accountId, prepared.reservation_id, prepared.wallet_address,
          candidate.genesisHash, candidate.gatewayProgramId,
          candidate.attestorAddress, candidate.intentDigest, candidate.nonce,
          candidate.configEpoch, candidate.expirySlot]);
        const stored = (await client.query(`SELECT * FROM alpha_cooper_breeding_issuances
          WHERE operation_id = $1 FOR UPDATE`, [operationId])).rows[0];
        const expected = { operation_id: operationId, account_id: accountId,
          reservation_id: prepared.reservation_id, wallet_address: prepared.wallet_address,
          cluster: 'devnet', genesis_hash: candidate.genesisHash,
          gateway_program_id: candidate.gatewayProgramId,
          attestor_address: candidate.attestorAddress,
          intent_digest: candidate.intentDigest, nonce: String(candidate.nonce),
          config_epoch: candidate.configEpoch, expiry_slot: String(candidate.expirySlot) };
        if (!stored || Object.entries(expected).some(([key, value]) =>
          String(stored[key]) !== value)) throw unavailable();
        await client.query('COMMIT');
        return { candidate, intentDigest: stored.intent_digest };
      } catch (cause) {
        await client.query('ROLLBACK');
        if (cause.code === '23505' || cause.code === '23514') throw unavailable();
        throw cause;
      } finally { client.release(); }
    },
  };
}
