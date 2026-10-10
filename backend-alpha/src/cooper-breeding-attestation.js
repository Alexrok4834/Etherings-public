import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { readPreparedCooperBreeding } from './cooper-breeding-candidate-reader.js';
import { verifyCooperBreedingCandidateEnvelope } from './cooper-breeding-intent.js';
import { loadDevnetAttestorSigner } from './cooper-eru-attestation.js';

const unavailable = () => new Error('Cooper breeding attestation unavailable');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function createCooperBreedingDevnetAttestation({ pool, issuance,
  candidateReader, attestorKeyPath, expectedAttestorAddress }) {
  return createCooperBreedingAttestation({ pool, issuance, candidateReader,
    signer: loadDevnetAttestorSigner(attestorKeyPath, expectedAttestorAddress) });
}

// The existing pinned Devnet attestor signs only after chain and DB revalidation;
// the user signature is a separate signer on the same immutable message.
export function createCooperBreedingAttestation({ pool, issuance, candidateReader, signer }) {
  if (typeof pool?.connect !== 'function' ||
      typeof issuance?.issue !== 'function' ||
      typeof candidateReader?.read !== 'function' ||
      typeof signer?.sign !== 'function' || !signer.address) throw unavailable();
  return {
    async attest(accountId, operationId) {
      const issued = await issuance.issue(accountId, operationId);
      const binding = (await pool.query(`SELECT * FROM alpha_cooper_breeding_issuances
        WHERE account_id = $1 AND operation_id = $2`, [accountId, operationId])).rows[0];
      if (!binding || binding.attestor_address !== signer.address ||
          binding.intent_digest !== issued.intentDigest) throw unavailable();
      const candidate = await candidateReader.read(accountId, operationId, binding);
      if (!verifyCooperBreedingCandidateEnvelope(candidate) ||
          candidate.intentDigest !== binding.intent_digest ||
          candidate.attestorAddress !== signer.address ||
          candidate.reservationId !== binding.reservation_id ||
          candidate.walletAddress !== binding.wallet_address ||
          candidate.genesisHash !== binding.genesis_hash ||
          candidate.gatewayProgramId !== binding.gateway_program_id ||
          candidate.nonce !== Number(binding.nonce) ||
          candidate.configEpoch !== String(binding.config_epoch) ||
          candidate.expirySlot !== Number(binding.expiry_slot)) throw unavailable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        const latest = (await client.query(`SELECT * FROM alpha_cooper_breeding_issuances
          WHERE account_id = $1 AND operation_id = $2 FOR UPDATE`,
        [accountId, operationId])).rows[0];
        if (!account || !latest || Object.keys(binding).some(key =>
          String(latest[key]) !== String(binding[key]))) throw unavailable();
        const prepared = await readPreparedCooperBreeding(client, accountId, operationId);
        if (prepared.reservation_id !== candidate.reservationId ||
            prepared.wallet_address !== candidate.walletAddress) throw unavailable();
        const message = Buffer.from(candidate.messageBase64, 'base64');
        const signature = signer.sign(message);
        const key = bs58.decode(signer.address);
        if (!(signature instanceof Uint8Array) || signature.length !== 64 ||
            key.length !== 32 || !verify(null, message, createPublicKey({
              key: Buffer.concat([SPKI, key]), format: 'der', type: 'spki',
            }), signature)) throw unavailable();
        await client.query('COMMIT');
        return { candidate, attestorSignatureBase64: Buffer.from(signature).toString('base64') };
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
    },
  };
}
