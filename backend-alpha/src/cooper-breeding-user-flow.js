import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { verifyCooperBreedingCandidateEnvelope } from './cooper-breeding-intent.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const unavailable = () => new Error('Cooper breeding user intent unavailable');
const signatureBytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw unavailable();
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
const sameIntent = (a, b) => verifyCooperBreedingCandidateEnvelope(a) &&
  verifyCooperBreedingCandidateEnvelope(b) && [
    'operationId', 'reservationId', 'issuanceId', 'walletAddress',
    'attestorAddress', 'gatewayProgramId', 'silverProgramId', 'cluster',
    'genesisHash', 'nonce', 'configEpoch', 'expirySlot', 'intentDigest',
  ].every(key => a[key] === b[key]);
const uuid = bytes => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const exact = units => `${units / 1_000_000_000n}.${(units % 1_000_000_000n)
  .toString().padStart(9, '0')}`;
const terms = candidate => {
  const decoded = getCompiledTransactionMessageDecoder().decode(
    Buffer.from(candidate.messageBase64, 'base64'));
  const ix = getInstructionsFromCompiledTransactionMessage(decoded)[1];
  const data = Buffer.from(ix.data);
  const principal = data.readBigUInt64LE(1);
  const fee = (principal * 200n + 9_999n) / 10_000n;
  return { operationId: candidate.operationId, reservationId: candidate.reservationId,
    issuanceId: candidate.issuanceId, walletAddress: candidate.walletAddress,
    firstRingId: uuid(data.subarray(73, 89)),
    secondRingId: uuid(data.subarray(89, 105)),
    firstUses: data[105], secondUses: data[106],
    ertExact: data.readBigUInt64LE(107).toString(),
    eruPrincipalExact: exact(principal), eruFeeExact: exact(fee),
    eruTotalExact: exact(principal + fee),
    mintAddress: ix.accounts[1].address,
    treasuryAddress: ix.accounts[2].address,
    intentDigest: candidate.intentDigest };
};

export function createCooperBreedingUserFlow({ attestation, reconciliation, chain }) {
  if (typeof attestation?.attest !== 'function' ||
      typeof reconciliation?.recordSubmission !== 'function' ||
      typeof reconciliation?.reconcile !== 'function' ||
      ['getSlot', 'getBlockHeight', 'isBlockhashValid', 'sendRawTransaction']
        .some(name => typeof chain?.[name] !== 'function')) throw unavailable();
  const review = async (accountId, operationId) => {
    const result = await attestation.attest(accountId, operationId);
    if (!verifyCooperBreedingCandidateEnvelope(result.candidate)) throw unavailable();
    return { ...result, terms: terms(result.candidate) };
  };
  return {
    review,
    status: (accountId, operationId) => reconciliation.reconcile(accountId, operationId),
    async refresh(accountId, operationId, approved) {
      if (!sameIntent(approved?.candidate, approved?.candidate) ||
          approved.candidate.operationId !== operationId) throw unavailable();
      const current = await review(accountId, operationId);
      if (!sameIntent(approved.candidate, current.candidate) ||
          JSON.stringify(approved.terms) !== JSON.stringify(current.terms))
        throw unavailable();
      return current;
    },
    async submit(accountId, operationId, refreshed, userSignatureBase64) {
      if (!verifyCooperBreedingCandidateEnvelope(refreshed?.candidate) ||
          refreshed.candidate.operationId !== operationId) throw unavailable();
      const candidate = refreshed.candidate;
      const message = Buffer.from(candidate.messageBase64, 'base64');
      const userSignature = signatureBytes(userSignatureBase64);
      const attestorSignature = signatureBytes(refreshed.attestorSignatureBase64);
      if (!signedBy(message, userSignature, candidate.walletAddress) ||
          !signedBy(message, attestorSignature, candidate.attestorAddress))
        throw unavailable();
      const current = await review(accountId, operationId);
      if (!sameIntent(candidate, current.candidate) ||
          JSON.stringify(refreshed.terms) !== JSON.stringify(current.terms))
        throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (Number(await chain.getSlot()) > candidate.expirySlot ||
          Number(await chain.getBlockHeight()) > candidate.lastValidBlockHeight ||
          !await chain.isBlockhashValid(decoded.lifetimeToken)) throw unavailable();
      const raw = Buffer.concat([Buffer.from([2]), userSignature,
        attestorSignature, message]);
      if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
      const signature = bs58.encode(userSignature);
      const recorded = await reconciliation.recordSubmission(accountId, operationId,
        signature);
      if (recorded.replay) {
        try {
          const prior = await reconciliation.reconcile(accountId, operationId);
          if (prior.status === 'confirmed') return prior;
        } catch { return { status: 'unknown', signature }; }
      }
      try {
        const sent = await chain.sendRawTransaction(raw);
        if (sent !== signature) throw unavailable();
      } catch { /* Durable signature remains UNKNOWN for retry/restart. */ }
      return { status: 'unknown', signature };
    },
  };
}
