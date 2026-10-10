import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import bs58 from 'bs58';
import { readPreparedCooperEru } from './cooper-eru-candidate-reader.js';
import { sameCooperEruIntent, verifyCooperEruCandidateEnvelope } from './cooper-eru-intent.js';

const unavailable = () => new Error('Cooper ERU attestation unavailable');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

// Construct only the guarded attestation boundary; do not expose a generic
// attestor signing endpoint or the loaded private key to the HTTP layer.
export function createCooperEruDevnetAttestation({ pool, issuance, candidateReader,
  attestorKeyPath, expectedAttestorAddress }) {
  const signer = loadDevnetAttestorSigner(attestorKeyPath, expectedAttestorAddress);
  return createCooperEruAttestation({ pool, issuance, candidateReader, signer,
    cluster: 'devnet' });
}

export function loadDevnetAttestorSigner(attestorKeyPath, expectedAttestorAddress) {
  if (typeof attestorKeyPath !== 'string' || !isAbsolute(attestorKeyPath) ||
      typeof expectedAttestorAddress !== 'string')
    throw unavailable();
  const parent = lstatSync(dirname(attestorKeyPath));
  const file = lstatSync(attestorKeyPath);
  if (!parent.isDirectory() || !file.isFile() || parent.isSymbolicLink() ||
      file.isSymbolicLink() || (process.platform !== 'win32' && (
        (parent.mode & 0o077) !== 0 || (file.mode & 0o777) !== 0o600 ||
        parent.uid !== process.getuid() || file.uid !== process.getuid()))) throw unavailable();
  let secret;
  let encoded;
  try {
    encoded = JSON.parse(readFileSync(attestorKeyPath, 'utf8'));
    if (!Array.isArray(encoded) || encoded.length !== 64 ||
        !encoded.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
      throw unavailable();
    secret = Buffer.from(encoded);
    const privateKey = createPrivateKey({ key: Buffer.concat([
      PKCS8_ED25519, secret.subarray(0, 32),
    ]), format: 'der', type: 'pkcs8' });
    const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
      .subarray(-32);
    if (!secret.subarray(32).equals(publicBytes) ||
        bs58.encode(publicBytes) !== expectedAttestorAddress) throw unavailable();
    return { address: expectedAttestorAddress,
      sign: message => sign(null, message, privateKey) };
  } finally {
    secret?.fill(0);
    if (Array.isArray(encoded)) encoded.fill(0);
  }
}

// Internal guarded boundary. The signer is injected; the Devnet factory above
// loads its external key without mounting an HTTP route or chain submission.
export function createCooperEruAttestation({ pool, issuance, candidateReader, signer, cluster }) {
  if (!pool || typeof pool.connect !== 'function' ||
      typeof issuance?.issue !== 'function' ||
      typeof candidateReader?.read !== 'function' ||
      typeof signer?.sign !== 'function' || typeof signer?.address !== 'string' ||
      !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  return {
    async attest(accountId, operationId) {
      const issued = await issuance.issue(accountId, operationId);
      const binding = (await pool.query(`SELECT * FROM alpha_cooper_level_eru_issuances
        WHERE operation_id = $1 AND account_id = $2`, [operationId, accountId])).rows[0];
      if (!binding || binding.cluster !== cluster ||
          binding.attestor_address !== signer.address ||
          binding.intent_digest !== issued.intentDigest) throw unavailable();
      // Re-read chain config, replay, expiry, blockhash and prepared DB state
      // immediately before the short locked sign step. No RPC under DB lock.
      const candidate = await candidateReader.read(accountId, operationId, binding);
      if (!verifyCooperEruCandidateEnvelope(candidate) ||
          !sameCooperEruIntent(issued.candidate, candidate) ||
          candidate.attestorAddress !== signer.address ||
          candidate.intentDigest !== binding.intent_digest ||
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
        const owner = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
        if (!owner) throw unavailable();
        const latest = (await client.query(`SELECT * FROM alpha_cooper_level_eru_issuances
          WHERE operation_id = $1 AND account_id = $2 FOR UPDATE`,
        [operationId, accountId])).rows[0];
        if (!latest || Object.keys(binding).some(key =>
          String(latest[key]) !== String(binding[key]))) throw unavailable();
        const prepared = await readPreparedCooperEru(client, accountId, operationId, cluster);
        if (prepared.reservation_id !== candidate.reservationId ||
            prepared.wallet_address !== candidate.walletAddress) throw unavailable();
        const message = Buffer.from(candidate.messageBase64, 'base64');
        // A local synchronous signer avoids waiting for RPC/user approval while
        // holding the owner lock. Its signature is checked against the pinned
        // Gateway attestor address before any result can leave this boundary.
        const signed = signer.sign(message);
        if (!(signed instanceof Uint8Array) || signed.length !== 64 ||
            !message.equals(Buffer.from(candidate.messageBase64, 'base64'))) throw unavailable();
        const signature = Buffer.from(signed);
        const publicKeyBytes = bs58.decode(signer.address);
        if (publicKeyBytes.length !== 32 || !verify(null, message,
          createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKeyBytes]),
            format: 'der', type: 'spki' }), signature)) throw unavailable();
        await client.query('COMMIT');
        return { candidate, attestorSignatureBase64: signature.toString('base64') };
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally { client.release(); }
    },
  };
}
