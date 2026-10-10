import { createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import bs58 from 'bs58';
import { address, createSolanaRpc, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { buildSilverDirectTransferMessage } from './silver-direct-transfer-intent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const unavailable = () => new Error('Silver direct transfer unavailable');
const same = (a, b) => isDeepStrictEqual(a, b);
const signatureBytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw unavailable();
  return bytes;
};

export function createSilverDirectTransferFlow({ pool, auth, silverReader,
  equipment, silverProgramId, rpcUrl, rpc = createSolanaRpc(rpcUrl) }) {
  if (!pool?.connect || !auth?.me || !silverReader?.listOwnedRings ||
      !silverReader?.listOwnedBoxes || !equipment?.current || !rpcUrl ||
      silverProgramId !== '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX')
    throw unavailable();
  const chain = async () => {
    if (await rpc.getGenesisHash().send() !== GENESIS) throw unavailable();
  };
  const readAccount = async key => (await rpc.getAccountInfo(address(key), {
    encoding: 'base64', commitment: 'finalized',
  }).send()).value;
  const boundOwner = async token => {
    const session = await auth.me(token);
    if (session.status !== 200) return { failure: session };
    const wallet = (await pool.query(`SELECT wallet_address FROM alpha_wallet_bindings
      WHERE account_id = $1`, [session.body.id])).rows[0]?.wallet_address;
    if (!wallet) throw unavailable();
    return { accountId: session.body.id, wallet };
  };
  const check = request => {
    if (!request || !same(Object.keys(request).sort(),
      ['operationId', 'mintAddress', 'recipientAddress'].sort()) ||
      !UUID.test(request.operationId) || !KEY.test(request.mintAddress) ||
      !KEY.test(request.recipientAddress)) throw unavailable();
  };
  const reviewFor = async (bound, request, lifetime = null) => {
    check(request);
    await chain();
    const assets = [
      ...await silverReader.listOwnedBoxes({ programId: silverProgramId,
        cluster: 'devnet', walletAddress: bound.wallet }),
      ...await silverReader.listOwnedRings({ programId: silverProgramId,
        cluster: 'devnet', walletAddress: bound.wallet }),
    ];
    const asset = assets.find(item => item.mintAddress === request.mintAddress &&
      item.tokenOwner === bound.wallet && item.finalized === true &&
      (item.kind === 'SILVER_RING' || item.kind === 'SILVER_BOX' &&
        item.lifecycle === 'SEALED'));
    if (!asset) throw unavailable();
    // No listing-state read or automatic UNLIST. Owner authority remains valid
    // even if a listing is ACTIVE; chain will make that listing stale.
    const sources = (await rpc.getTokenAccountsByOwner(address(bound.wallet),
      { mint: address(request.mintAddress) },
      { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value.filter(
      ({ account }) => account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        account.data.parsed?.info?.owner === bound.wallet &&
        account.data.parsed.info.mint === request.mintAddress &&
        account.data.parsed.info.tokenAmount?.amount === '1');
    if (sources.length !== 1) throw unavailable();
    const block = lifetime ?? (await rpc.getLatestBlockhash({
      commitment: 'confirmed' }).send()).value;
    const candidate = await buildSilverDirectTransferMessage({ rpc, readAccount,
      kind: asset.kind, mintAddress: request.mintAddress,
      sourceTokenAddress: sources[0].pubkey, senderAddress: bound.wallet,
      recipientAddress: request.recipientAddress, blockhash: block.blockhash,
      lastValidBlockHeight: Number(block.lastValidBlockHeight) });
    return { request, terms: { kind: asset.kind, mintAddress: request.mintAddress,
      senderAddress: bound.wallet, recipientAddress: request.recipientAddress,
      sourceTokenAddress: candidate.sourceTokenAddress,
      destinationTokenAddress: candidate.destinationTokenAddress,
      amount: '1', decimals: 0, networkFeePayer: bound.wallet,
      createsRecipientAta: candidate.createsRecipientAta,
      eamAddress: candidate.eamAddress, eamSha256: candidate.eamSha256,
      eamVersion: candidate.eamVersion, marketAware: candidate.marketAware },
    candidate: { ...candidate, walletAddress: bound.wallet,
      mintAddress: request.mintAddress, kind: asset.kind,
      blockhash: block.blockhash,
      lastValidBlockHeight: Number(block.lastValidBlockHeight) } };
  };
  const priorSubmission = async (accountId, operationId) =>
    (await pool.query(`SELECT signature FROM alpha_silver_direct_transfer_submissions
      WHERE account_id = $1 AND operation_id = $2`, [accountId, operationId])).rows[0];
  return {
    async review(token, request) {
      const bound = await boundOwner(token);
      if (bound.failure) return bound.failure;
      check(request);
      if (await priorSubmission(bound.accountId, request.operationId)) throw unavailable();
      return { status: 200, body: await reviewFor(bound, request) };
    },
    async refresh(token, body) {
      const bound = await boundOwner(token);
      if (bound.failure) return bound.failure;
      const approved = body?.approved;
      check(approved?.request);
      if (await priorSubmission(bound.accountId, approved.request.operationId))
        throw unavailable();
      const current = await reviewFor(bound, approved.request);
      if (!same(approved.terms, current.terms) ||
          !same({ ...approved.candidate, messageBase64: null, sizeBytes: null,
            blockhash: null, lastValidBlockHeight: null },
          { ...current.candidate, messageBase64: null, sizeBytes: null,
            blockhash: null, lastValidBlockHeight: null })) throw unavailable();
      return { status: 200, body: current };
    },
    async submit(token, body) {
      const bound = await boundOwner(token);
      if (bound.failure) return bound.failure;
      const refreshed = body?.refreshed;
      check(refreshed?.request);
      const candidate = refreshed?.candidate;
      if (candidate?.walletAddress !== bound.wallet ||
          candidate.mintAddress !== refreshed.request.mintAddress ||
          !Number.isSafeInteger(candidate.lastValidBlockHeight) ||
          candidate.lastValidBlockHeight < 1) throw unavailable();
      const current = await reviewFor(bound, refreshed.request, {
        blockhash: candidate.blockhash,
        lastValidBlockHeight: candidate.lastValidBlockHeight });
      if (!same(refreshed, current)) throw unavailable();
      const message = Buffer.from(candidate.messageBase64, 'base64');
      const signature = signatureBytes(body.userSignatureBase64);
      const publicKey = Buffer.from(bs58.decode(bound.wallet));
      if (publicKey.length !== 32 || !verify(null, message, createPublicKey({
        key: Buffer.concat([SPKI, publicKey]), format: 'der', type: 'spki',
      }), signature) || !(await rpc.isBlockhashValid(address(candidate.blockhash),
        { commitment: 'confirmed' }).send()).value) throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (decoded.header.numSignerAccounts !== 1 ||
          decoded.staticAccounts[0] !== bound.wallet ||
          decoded.lifetimeToken !== candidate.blockhash) throw unavailable();
      const raw = Buffer.concat([Buffer.from([1]), signature, message]);
      if (raw.length !== candidate.sizeBytes || raw.length > 1232) throw unavailable();
      const simulation = (await rpc.simulateTransaction(raw.toString('base64'), {
        encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false,
        commitment: 'confirmed',
      }).send()).value;
      if (simulation?.err !== null) throw unavailable();
      const id = bs58.encode(signature);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT id FROM alpha_accounts
          WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`,
        [bound.accountId])).rows[0];
        const wallet = (await client.query(`SELECT wallet_address FROM alpha_wallet_bindings
          WHERE account_id = $1`, [bound.accountId])).rows[0]?.wallet_address;
        if (!account || wallet !== bound.wallet) throw unavailable();
        await client.query(`INSERT INTO alpha_silver_direct_transfer_submissions
          (signature,account_id,operation_id,wallet_address,mint_address,
           recipient_address,terms,message_base64)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`,
        [id, bound.accountId, refreshed.request.operationId, bound.wallet,
          refreshed.request.mintAddress, refreshed.request.recipientAddress,
          JSON.stringify(refreshed.terms), candidate.messageBase64]);
        const stored = (await client.query(`SELECT * FROM alpha_silver_direct_transfer_submissions
          WHERE account_id = $1 AND operation_id = $2`,
        [bound.accountId, refreshed.request.operationId])).rows[0];
        if (stored?.signature !== id || stored.wallet_address !== bound.wallet ||
            stored.mint_address !== refreshed.request.mintAddress ||
            stored.recipient_address !== refreshed.request.recipientAddress ||
            !same(stored.terms, refreshed.terms) ||
            stored.message_base64 !== candidate.messageBase64) throw unavailable();
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK'); throw cause;
      } finally { client.release(); }
      try {
        await rpc.sendTransaction(raw.toString('base64'), {
          encoding: 'base64', skipPreflight: false,
          preflightCommitment: 'confirmed',
        }).send();
      } catch { /* Persisted signature remains UNKNOWN for status/restart recovery. */ }
      return { status: 200, body: { status: 'unknown', signature: id } };
    },
    async status(token, body) {
      if (!UUID.test(body?.operationId ?? '')) throw unavailable();
      const bound = await boundOwner(token);
      if (bound.failure) return bound.failure;
      await chain();
      const stored = (await pool.query(`SELECT * FROM alpha_silver_direct_transfer_submissions
        WHERE account_id = $1 AND operation_id = $2`,
      [bound.accountId, body.operationId])).rows[0];
      if (!stored) return { status: 200, body: { status: 'not_submitted' } };
      if (stored.wallet_address !== bound.wallet) throw unavailable();
      const transaction = await rpc.getTransaction(stored.signature, {
        encoding: 'base64', commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }).send();
      if (!transaction) return { status: 200, body: { status: 'unknown',
        signature: stored.signature } };
      if (!transaction.meta || !Object.hasOwn(transaction.meta, 'err'))
        throw unavailable();
      const raw = Buffer.from(transaction.transaction?.[0] ?? '', 'base64');
      if (raw[0] !== 1 || raw.length > 1232 ||
          !raw.subarray(1, 65).equals(Buffer.from(bs58.decode(stored.signature))) ||
          raw.subarray(65).toString('base64') !== stored.message_base64)
        throw unavailable();
      const confirmed = transaction.meta.err === null;
      let selectionReconciliation = 'not_applicable';
      if (confirmed && stored.terms.kind === 'SILVER_RING') {
        try {
          const result = await equipment.current(token);
          selectionReconciliation = result.status === 200 ? 'checked' : 'unknown';
        } catch { selectionReconciliation = 'unknown'; }
      }
      return { status: 200, body: { status: confirmed ? 'confirmed' : 'failed',
        signature: stored.signature, mintAddress: stored.mint_address,
        recipientAddress: stored.recipient_address,
        selectionReconciliation } };
    },
  };
}
