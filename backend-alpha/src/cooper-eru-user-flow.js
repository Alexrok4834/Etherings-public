import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { sameCooperEruIntent, verifyCooperEruCandidateEnvelope } from './cooper-eru-intent.js';

const unavailable = () => new Error('Cooper ERU user intent unavailable');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const signatureBytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw unavailable();
  return bytes;
};
const signedBy = (message, signature, owner) => {
  const key = bs58.decode(owner);
  return key.length === 32 && verify(null, message, createPublicKey({
    key: Buffer.concat([SPKI, key]), format: 'der', type: 'spki',
  }), signature);
};

export function assembleCooperEruSignedTransaction(review, userSignatureBase64) {
  const candidate = review?.candidate;
  if (!verifyCooperEruCandidateEnvelope(candidate)) throw unavailable();
  const message = Buffer.from(candidate.messageBase64, 'base64');
  const userSignature = signatureBytes(userSignatureBase64);
  const attestorSignature = signatureBytes(review.attestorSignatureBase64);
  if (!signedBy(message, userSignature, candidate.walletAddress) ||
      !signedBy(message, attestorSignature, candidate.attestorAddress)) throw unavailable();
  const raw = Buffer.concat([Buffer.from([2]), userSignature, attestorSignature, message]);
  if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
  return { raw, signature: bs58.encode(userSignature) };
}

function terms(candidate) {
  const message = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  const ix = getInstructionsFromCompiledTransactionMessage(message)[1];
  const data = Buffer.from(ix.data);
  const principal = data.readBigUInt64LE(1);
  const fee = (principal * 200n + 9_999n) / 10_000n;
  const exact = value => `${value / 1_000_000_000n}.${(value % 1_000_000_000n)
    .toString().padStart(9, '0')}`;
  return { ringId:
    [data.subarray(57, 61).toString('hex'), data.subarray(61, 63).toString('hex'),
      data.subarray(63, 65).toString('hex'), data.subarray(65, 67).toString('hex'),
      data.subarray(67, 73).toString('hex')].join('-'),
  currentLevel: data[89], targetLevel: data[90],
  ertExact: data.readBigUInt64LE(91).toString(),
  eruPrincipalExact: exact(principal), eruFeeExact: exact(fee),
  walletAddress: candidate.walletAddress, treasuryAddress: ix.accounts[2].address,
  mintAddress: ix.accounts[1].address, operationId: candidate.operationId,
  reservationId: candidate.reservationId, intentDigest: candidate.intentDigest };
}

// Internal integration: auth/HTTP/Android are not mounted here. The user signs
// only the returned exact message; the backend attestor signature is separate.
export function createCooperEruUserFlow({ attestation, reconciliation, chain }) {
  if (typeof attestation?.attest !== 'function' ||
      typeof reconciliation?.recordSubmission !== 'function' ||
      typeof reconciliation?.reconcile !== 'function' ||
      ['getSlot', 'getBlockHeight', 'isBlockhashValid', 'sendRawTransaction']
        .some(name => typeof chain?.[name] !== 'function')) throw unavailable();
  const review = async (accountId, operationId) => {
    const result = await attestation.attest(accountId, operationId);
    if (!verifyCooperEruCandidateEnvelope(result.candidate)) throw unavailable();
    return { ...result, terms: terms(result.candidate) };
  };
  return {
    review,
    status: (accountId, operationId) => reconciliation.reconcile(accountId, operationId),
    async refresh(accountId, operationId, approved) {
      if (!verifyCooperEruCandidateEnvelope(approved?.candidate) ||
          approved.candidate.operationId !== operationId) throw unavailable();
      const current = await review(accountId, operationId);
      if (!sameCooperEruIntent(approved.candidate, current.candidate) ||
          JSON.stringify(approved.terms) !== JSON.stringify(current.terms)) throw unavailable();
      return current;
    },
    async submit(accountId, operationId, refreshed, userSignatureBase64) {
      if (!verifyCooperEruCandidateEnvelope(refreshed?.candidate) ||
          refreshed.candidate.operationId !== operationId) throw unavailable();
      const { raw, signature } = assembleCooperEruSignedTransaction(
        refreshed, userSignatureBase64);
      const current = await review(accountId, operationId);
      if (!sameCooperEruIntent(refreshed.candidate, current.candidate) ||
          JSON.stringify(refreshed.terms) !== JSON.stringify(current.terms))
        throw unavailable();
      const message = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(refreshed.candidate.messageBase64, 'base64'));
      if (Number(await chain.getSlot()) > refreshed.candidate.expirySlot ||
          Number(await chain.getBlockHeight()) > refreshed.candidate.lastValidBlockHeight ||
          !await chain.isBlockhashValid(message.lifetimeToken)) throw unavailable();
      const recorded = await reconciliation.recordSubmission(accountId, operationId, signature);
      if (recorded.replay) {
        try {
          const prior = await reconciliation.reconcile(accountId, operationId);
          if (prior.status === 'confirmed') return { status: 'confirmed', signature };
        } catch { return { status: 'unknown', signature }; }
      }
      try {
        const sent = await chain.sendRawTransaction(raw);
        if (sent !== signature) throw unavailable();
      } catch { /* Recorded signature stays UNKNOWN for reconciliation. */ }
      return { status: 'unknown', signature };
    },
  };
}
