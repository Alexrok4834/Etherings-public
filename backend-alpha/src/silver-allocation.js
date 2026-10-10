import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { readOwnedSilver } from './silver-progression.js';
import { silverRingIsListed } from './silver-listed-eligibility.js';
import { recordM2eComfortChange } from './m2e-comfort-epochs.js';
import { buildSilverAllocationMessage, sameSilverAllocationIntent,
  verifySilverAllocationMessage, silverAllocationValues } from './silver-allocation-intent.js';

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const unavailable = () => new Error('Silver Point allocation unavailable');
const fields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');
const sameTerms = (first, second) =>
  fields(first, ['mintAddress', 'walletAddress', 'level', 'allocation',
    'pointsBefore', 'pointsSpent', 'ertExact', 'eruExact']) &&
  fields(second, ['mintAddress', 'walletAddress', 'level', 'allocation',
    'pointsBefore', 'pointsSpent', 'ertExact', 'eruExact']) &&
  ['mintAddress', 'walletAddress', 'level', 'pointsBefore', 'pointsSpent',
    'ertExact', 'eruExact'].every(name => first[name] === second[name]) &&
  ['comfort', 'charm', 'quality', 'luck'].every(name =>
    first.allocation?.[name] === second.allocation?.[name]);
const sigBytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw unavailable();
  return bytes;
};

export function createSilverAllocation({ pool, auth, reader, marketReader = null,
  signer, finalityChain, programId }) {
  if (typeof pool?.connect !== 'function' || typeof auth?.me !== 'function' ||
      typeof reader?.listOwnedRings !== 'function' ||
      ['readOwnedToken', 'latestBlockhash', 'verifyPinnedProgram', 'isBlockhashValid', 'send']
        .some(name => typeof signer?.[name] !== 'function') ||
      ['getGenesisHash', 'getSignatureStatus', 'getTransaction']
        .some(name => typeof finalityChain?.[name] !== 'function')) throw unavailable();
  const owner = async token => {
    const session = await auth.me(token);
    if (session.status !== 200) return { failure: session };
    const wallet = (await pool.query(`SELECT wallet_address FROM alpha_wallet_bindings
      WHERE account_id = $1`, [session.body.id])).rows[0]?.wallet_address;
    if (!wallet) throw unavailable();
    return { accountId: session.body.id, wallet };
  };
  const review = async (token, mint, allocation) => {
    if (!MINT.test(mint ?? '')) throw unavailable();
    const bound = await owner(token);
    if (bound.failure) return bound.failure;
    const ring = await readOwnedSilver({ pool, chain: reader, programId,
      mint, wallet: bound.wallet });
    if (!ring || ring.unspentPoints < 1 || ring.level < 2 ||
        BigInt(ring.cooldownUntilUnixSeconds) > BigInt(Math.floor(Date.now() / 1000)))
      throw unavailable();
    if (await silverRingIsListed(marketReader, mint))
      return { status: 409, body: { code: 'SILVER_RING_LISTED' } };
    const values = silverAllocationValues(allocation, ring.unspentPoints);
    await signer.verifyPinnedProgram();
    const tokenAddress = await signer.readOwnedToken(bound.wallet, mint);
    const latest = await signer.latestBlockhash();
    const candidate = await buildSilverAllocationMessage({ ring,
      walletAddress: bound.wallet, tokenAddress, programId, allocation,
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
    return { status: 200, body: { candidate, terms: {
      mintAddress: mint, walletAddress: bound.wallet, level: ring.level,
      allocation: candidate.allocation, pointsBefore: ring.unspentPoints,
      pointsSpent: values.reduce((sum, value) => sum + value, 0),
      ertExact: '0', eruExact: '0' } } };
  };
  return {
    async review(token, body) {
      if (!fields(body, ['mintAddress', 'allocation'])) throw unavailable();
      return review(token, body.mintAddress, body.allocation);
    },
    async refresh(token, body) {
      if (!fields(body, ['approved'])) throw unavailable();
      const approved = body.approved;
      const current = await review(token, approved?.candidate?.mintAddress,
        approved?.candidate?.allocation);
      if (current.status !== 200) return current;
      if (!sameSilverAllocationIntent(approved.candidate, current.body.candidate) ||
          !sameTerms(approved.terms, current.body.terms))
        throw unavailable();
      return current;
    },
    async submit(token, body) {
      if (!fields(body, ['refreshed', 'userSignatureBase64'])) throw unavailable();
      const candidate = body.refreshed?.candidate;
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      if (!candidate || candidate.walletAddress !== bound.wallet ||
          candidate.programId !== programId) throw unavailable();
      const ring = await readOwnedSilver({ pool, chain: reader, programId,
        mint: candidate.mintAddress, wallet: bound.wallet });
      if (!ring || !await verifySilverAllocationMessage(candidate, ring)) throw unavailable();
      const current = await review(token, candidate.mintAddress, candidate.allocation);
      if (current.status !== 200) return current;
      if (!sameSilverAllocationIntent(candidate, current.body.candidate) ||
          !sameTerms(body.refreshed.terms, current.body.terms))
        throw unavailable();
      const message = Buffer.from(candidate.messageBase64, 'base64');
      const userSignature = sigBytes(body.userSignatureBase64);
      const key = Buffer.from(bs58.decode(bound.wallet));
      if (key.length !== 32 || !verify(null, message, createPublicKey({
        key: Buffer.concat([SPKI, key]), format: 'der', type: 'spki',
      }), userSignature)) throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (!await signer.isBlockhashValid(decoded.lifetimeToken)) throw unavailable();
      const raw = Buffer.concat([Buffer.from([1]), userSignature, message]);
      if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
      const signature = bs58.encode(userSignature);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [bound.accountId])).rows[0];
        const wallet = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
          WHERE account_id = $1`, [bound.accountId])).rows[0]?.wallet_address;
        if (!account || wallet !== bound.wallet) throw unavailable();
        await client.query(`INSERT INTO alpha_silver_allocation_submissions
          (signature,account_id,mint_address,wallet_address,message_base64,
          intent_digest,allocation) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (signature) DO NOTHING`, [signature, bound.accountId,
          candidate.mintAddress, bound.wallet, candidate.messageBase64,
          candidate.intentDigest, JSON.stringify(candidate.allocation)]);
        const stored = (await client.query(`SELECT * FROM alpha_silver_allocation_submissions
          WHERE signature = $1`, [signature])).rows[0];
        if (stored?.account_id !== bound.accountId ||
            stored.mint_address !== candidate.mintAddress ||
            stored.wallet_address !== bound.wallet ||
            stored.message_base64 !== candidate.messageBase64 ||
            stored.intent_digest !== candidate.intentDigest ||
            ['comfort', 'charm', 'quality', 'luck'].some(name =>
              stored.allocation?.[name] !== candidate.allocation[name]))
          throw unavailable();
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
      try {
        const sent = await signer.send({ raw_transaction_base64: raw.toString('base64') });
        if (sent !== signature) throw unavailable();
      } catch { /* Durable signature remains available for readback/retry. */ }
      return { status: 200, body: { status: 'unknown', signature } };
    },
    async status(token, body) {
      if (!fields(body, ['signature']) || !SIGNATURE.test(body.signature ?? ''))
        throw unavailable();
      const bound = await owner(token);
      if (bound.failure) return bound.failure;
      const stored = (await pool.query(`SELECT * FROM alpha_silver_allocation_submissions
        WHERE account_id = $1 AND signature = $2`, [bound.accountId, body.signature])).rows[0];
      if (!stored || stored.wallet_address !== bound.wallet) throw unavailable();
      if (await finalityChain.getGenesisHash() !==
          'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw unavailable();
      const status = await finalityChain.getSignatureStatus(body.signature);
      if (status?.confirmationStatus !== 'finalized' || status.err !== null)
        return { status: 200, body: { status: 'unknown' } };
      const transaction = await finalityChain.getTransaction(body.signature);
      if (!transaction?.transaction?.[0] || transaction.meta?.err !== null)
        return { status: 200, body: { status: 'unknown' } };
      const bytes = Buffer.from(transaction.transaction[0], 'base64');
      if (bytes[0] !== 1 || bytes.length > 1232 ||
          !bytes.subarray(1, 65).equals(Buffer.from(bs58.decode(body.signature))) ||
          bytes.subarray(65).toString('base64') !== stored.message_base64)
        throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(bytes.subarray(65));
      const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
      if (decoded.header.numSignerAccounts !== 1 ||
          decoded.staticAccounts[0] !== bound.wallet || instructions.length !== 1 ||
          instructions[0].programAddress !== programId ||
          Buffer.from(instructions[0].data).length !== 14 ||
          Buffer.from(instructions[0].data)[0] !== 17 ||
          instructions[0].accounts[1].address !== stored.mint_address)
        throw unavailable();
      const instructionData = Buffer.from(instructions[0].data);
      const oldComfort = instructionData[6];
      const newComfort = oldComfort + (stored.allocation?.comfort ??
        (stored.attribute === 'comfort' ? 1 : 0));
      let m2eComfortPending = false;
      if (newComfort !== oldComfort) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const account = (await client.query(`SELECT id FROM alpha_accounts
            WHERE id = $1 FOR UPDATE`, [bound.accountId])).rows[0];
          if (!account) throw unavailable();
          const selection = (await client.query(`SELECT ring_kind, ring_id
            FROM alpha_ring_selection WHERE account_id = $1`, [bound.accountId])).rows[0];
          if (selection?.ring_kind === 'SILVER_RING' &&
              selection.ring_id === stored.mint_address) {
            const blockTime = Number(transaction.blockTime);
            if (!Number.isSafeInteger(blockTime) || blockTime <= 0) throw unavailable();
            await recordM2eComfortChange(client, { accountId: bound.accountId,
              sourceKey: `silver-points:${body.signature}`,
              previous: { kind: 'SILVER_RING', id: stored.mint_address,
                comfort: oldComfort },
              current: { kind: 'SILVER_RING', id: stored.mint_address,
                comfort: newComfort },
              uncertainStartedAt: new Date(blockTime * 1000),
              effectiveAt: new Date((blockTime + 1) * 1000) });
          } else m2eComfortPending = true;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          // The finalized NFT allocation is independent of this derived M2E
          // readback. Its durable submission keeps affected batches pending.
          m2eComfortPending = true;
        }
        finally { client.release(); }
      }
      return { status: 200, body: { status: 'confirmed', signature: body.signature,
        mintAddress: stored.mint_address,
        allocation: stored.allocation ?? { [stored.attribute]: 1 },
        m2eComfortPending } };
    },
  };
}
