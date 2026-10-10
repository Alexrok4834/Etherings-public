import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import bs58 from 'bs58';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { buildSilverOpeningCandidateMessage,
  verifySilverOpeningCandidateMessage } from './silver-opening-intent.js';

const UNAVAILABLE = { status: 409, body: { message: 'Silver opening unavailable.' } };
const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const validAddress = value => {
  if (typeof value !== 'string') return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  }
  catch { return false; }
};

export function createSilverOpeningCandidateIntent({ pool, preflight, chain, programId,
  cluster = 'local-validator', expectedGenesisHash, signingEnabled = false,
  now = () => Date.now() }) {
  if (!pool || typeof preflight?.preflight !== 'function' ||
      typeof chain?.readCandidateOpeningSnapshot !== 'function' ||
      typeof chain?.isCandidateRequestAbsent !== 'function' ||
      typeof chain?.getCandidateBlockhash !== 'function' ||
      !validAddress(programId) || !validAddress(expectedGenesisHash) ||
      !['local-validator', 'devnet'].includes(cluster) ||
      (cluster === 'devnet') !== (expectedGenesisHash === DEVNET_GENESIS)) {
    throw new Error('Candidate Silver intent requires exact cluster readers');
  }

  const identity = async (client, token) => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (await client.query(`SELECT a.id AS account_id, b.wallet_address
      FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
      JOIN alpha_wallet_bindings b ON b.account_id = a.id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
    [createHash('sha256').update(token).digest('hex'), new Date(now())])).rows[0];
  };
  const candidate = async (client, mint, lock = false) =>
    (await client.query(`SELECT * FROM alpha_silver_opening_candidate_intents
      WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3 AND mint_address = $4
      ${lock ? 'FOR UPDATE' : ''}`,
    [cluster, expectedGenesisHash, programId, mint])).rows[0];
  const submission = async (client, mint) =>
    (await client.query(`SELECT * FROM alpha_silver_opening_submissions
      WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3 AND mint_address = $4`,
    [cluster, expectedGenesisHash, programId, mint])).rows[0];
  const settlement = async (token, mint) => {
    const user = await identity(pool, token);
    if (!user) return UNAUTHORIZED;
    const row = await candidate(pool, mint);
    const signed = await submission(pool, mint);
    if (!row || row.account_id !== user.account_id ||
        row.wallet_address !== user.wallet_address ||
        (signed && (signed.account_id !== user.account_id ||
          signed.wallet_address !== user.wallet_address)))
      return UNAVAILABLE;
    if (!signed) return { status: 404, body: { message: 'No Silver opening submission.' } };
    if (signed.status !== 'unknown') return { status: 200,
      body: { status: signed.status, transactionSignature: signed.signature } };
    const status = await chain.openingSignatureStatus(signed.signature);
    if (status?.confirmationStatus !== 'finalized') return { status: 503,
      body: { status: 'unknown', transactionSignature: signed.signature } };
    const tx = await chain.openingTransaction(signed.signature);
    const raw = Buffer.concat([Buffer.from([1]), bs58.decode(signed.signature),
      Buffer.from(signed.message_base64, 'base64')]);
    if (!tx?.transaction?.[0] || !Buffer.from(tx.transaction[0], 'base64').equals(raw) ||
        (status.err === null) !== (tx.meta?.err === null)) return { status: 503,
      body: { status: 'unknown', transactionSignature: signed.signature } };
    if (status.err === null) {
      const decoded = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(signed.message_base64, 'base64'));
      const balance = (rows, key) => {
        const index = decoded.staticAccounts.indexOf(key);
        return rows?.find(item => Number(item.accountIndex) === index &&
          item.mint === mint)?.uiTokenAmount?.amount;
      };
      const srcBefore = balance(tx.meta.preTokenBalances, row.source_token_address);
      const srcAfter = balance(tx.meta.postTokenBalances, row.source_token_address);
      const dstBefore = balance(tx.meta.preTokenBalances, row.escrow_address);
      const dstAfter = balance(tx.meta.postTokenBalances, row.escrow_address);
      const built = await buildSilverOpeningCandidateMessage({ cluster, programId,
        walletAddress: row.wallet_address, mintAddress: mint,
        userTokenAddress: row.source_token_address, escrowAddress: row.escrow_address,
        nextOperation: Number(row.next_operation), designVersion: Number(row.design_version),
        oraoTreasury: row.orao_treasury, seed: Buffer.from(row.seed_hex, 'hex'),
        blockhash: signed.blockhash, lastValidBlockHeight: Number(signed.last_valid_block_height) });
      if (srcBefore !== '1' || srcAfter !== '0' || dstBefore !== '0' || dstAfter !== '1' ||
          !await chain.readOpeningOperation({ programId, mintAddress: mint,
            walletAddress: row.wallet_address, escrowAddress: row.escrow_address,
            requestAddress: built.request, seed: Buffer.from(row.seed_hex, 'hex'),
            nextOperation: row.next_operation, designVersion: row.design_version,
            designCommitment: row.design_commitment })) return { status: 503,
        body: { status: 'unknown', transactionSignature: signed.signature } };
    }
    const next = status.err === null ? 'confirmed' : 'failed';
    await pool.query(`UPDATE alpha_silver_opening_submissions
      SET status = $5, settled_at = now()
      WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3 AND mint_address = $4
        AND status = 'unknown' AND signature = $6`,
    [cluster, expectedGenesisHash, programId, mint, next, signed.signature]);
    return { status: next === 'confirmed' ? 200 : 409,
      body: { status: next, transactionSignature: signed.signature } };
  };
  return {
    reconcile: async (token, { mintAddress } = {}) =>
      !await identity(pool, token) ? UNAUTHORIZED :
        validAddress(mintAddress) ? settlement(token, mintAddress) : UNAVAILABLE,
    async submit(token, body = {}) {
      if (!signingEnabled || cluster !== 'devnet') return UNAVAILABLE;
      if (!await identity(pool, token)) return UNAUTHORIZED;
      const { mintAddress, messageBase64, blockhash, lastValidBlockHeight,
        signatureBase64 } = body;
      if (!validAddress(mintAddress) || !validAddress(blockhash) ||
          !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 ||
          typeof messageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(messageBase64) ||
          typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64))
        return UNAVAILABLE;
      const message = Buffer.from(messageBase64, 'base64');
      const signature = Buffer.from(signatureBase64, 'base64');
      if (message.length > 1232 || message.toString('base64') !== messageBase64 ||
          signature.length !== 64 || signature.toString('base64') !== signatureBase64)
        return UNAVAILABLE;
      const client = await pool.connect();
      let row;
      let existing;
      try {
        await client.query('BEGIN');
        const user = await identity(client, token);
        if (!user) { await client.query('ROLLBACK'); return UNAUTHORIZED; }
        row = await candidate(client, mintAddress, true);
        if (!row || row.account_id !== user.account_id ||
            row.wallet_address !== user.wallet_address) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        existing = await submission(client, mintAddress);
        const signatureAddress = bs58.encode(signature);
        if (existing) {
          await client.query('COMMIT');
          if (existing.signature !== signatureAddress || existing.message_base64 !== messageBase64 ||
              existing.blockhash !== blockhash ||
              Number(existing.last_valid_block_height) !== lastValidBlockHeight)
            return UNAVAILABLE;
        } else {
        const snapshot = await chain.readCandidateOpeningSnapshot({ programId,
          mintAddress, walletAddress: row.wallet_address,
          escrowAddress: row.escrow_address });
        if (snapshot?.finalized !== true || snapshot.cluster !== cluster ||
            snapshot.genesisHash !== expectedGenesisHash || snapshot.programId !== programId ||
            snapshot.mintAddress !== mintAddress ||
            snapshot.walletAddress !== row.wallet_address ||
            snapshot.sourceTokenAddress !== row.source_token_address ||
            snapshot.escrowAddress !== row.escrow_address ||
            snapshot.lifecycle !== 'SEALED' || snapshot.boxAmount !== '1' ||
            snapshot.escrowAmount !== '0' || snapshot.designFrozen !== true ||
            BigInt(snapshot.nextOperation) !== BigInt(row.next_operation) ||
            BigInt(snapshot.designVersion) !== BigInt(row.design_version) ||
            snapshot.designCommitment !== row.design_commitment ||
            snapshot.oraoTreasury !== row.orao_treasury) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        const expected = { cluster, programId, walletAddress: row.wallet_address,
          mintAddress, userTokenAddress: row.source_token_address,
          escrowAddress: row.escrow_address, nextOperation: Number(row.next_operation),
          designVersion: Number(row.design_version), oraoTreasury: row.orao_treasury,
          seed: Buffer.from(row.seed_hex, 'hex'), blockhash, lastValidBlockHeight,
          marketProgramId: snapshot.marketProgramId ?? null };
        const publicKey = createPublicKey({ key: Buffer.concat([SPKI,
          Buffer.from(getAddressEncoder().encode(address(row.wallet_address)))]),
        format: 'der', type: 'spki' });
        if (!await verifySilverOpeningCandidateMessage(expected, messageBase64) ||
            !verify(null, message, publicKey, signature) ||
            lastValidBlockHeight < await chain.openingBlockHeight() ||
            !await chain.isOpeningBlockhashValid(blockhash)) {
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        const simulation = await chain.simulateOpeningTransaction(
          Buffer.concat([Buffer.from([1]), signature, message]));
        if (simulation?.err !== null) {
          console.error('Silver opening simulation rejected', JSON.stringify({
            err: simulation?.err,
            logs: Array.isArray(simulation?.logs) ? simulation.logs.filter(line =>
              /^Program (?:[1-9A-HJ-NP-Za-km-z]+ (?:invoke|success|failed)|log:)/.test(line)) : [],
          }, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
          await client.query('ROLLBACK'); return UNAVAILABLE;
        }
        await client.query(`INSERT INTO alpha_silver_opening_submissions
          (cluster,genesis_hash,program_id,mint_address,account_id,wallet_address,
           message_base64,blockhash,last_valid_block_height,signature)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cluster, expectedGenesisHash, programId, mintAddress, user.account_id,
          user.wallet_address, messageBase64, blockhash, lastValidBlockHeight,
          signatureAddress]);
        await client.query('COMMIT');
        }
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      try {
        if ((existing?.status ?? 'unknown') !== 'unknown' ||
            lastValidBlockHeight < await chain.openingBlockHeight() ||
            !await chain.isOpeningBlockhashValid(blockhash)) return settlement(token, mintAddress);
        const raw = Buffer.concat([Buffer.from([1]), signature, message]);
        const sent = await chain.sendOpeningTransaction(raw);
        if (sent !== bs58.encode(signature)) throw new Error('Silver signature mismatch');
      } catch { /* Persisted signature remains UNKNOWN until finalized chain evidence. */ }
      return settlement(token, mintAddress);
    },
    async issue(token, body) {
      const approved = await preflight.preflight(token, body);
      if (approved.status !== 200) return approved;
      if (approved.body.cluster !== cluster) return UNAVAILABLE;
      const { walletAddress, mintAddress, escrowAddress } = approved.body;
      const session = (await pool.query(`SELECT a.id AS account_id, b.wallet_address
        FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
        JOIN alpha_wallet_bindings b ON b.account_id = a.id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
      [createHash('sha256').update(token).digest('hex'), new Date(now())])).rows[0];
      if (!session) return UNAUTHORIZED;
      if (session.wallet_address !== walletAddress) return UNAVAILABLE;

      const snapshot = await chain.readCandidateOpeningSnapshot({ programId,
        mintAddress, walletAddress, escrowAddress });
      if (snapshot?.finalized !== true || snapshot.cluster !== cluster ||
          snapshot.genesisHash !== expectedGenesisHash || snapshot.programId !== programId ||
          snapshot.mintAddress !== mintAddress || snapshot.walletAddress !== walletAddress ||
          snapshot.escrowAddress !== escrowAddress || snapshot.boxAmount !== '1' ||
          snapshot.escrowAmount !== '0' || snapshot.lifecycle !== 'SEALED' ||
          snapshot.designFrozen !== true ||
          !Number.isSafeInteger(snapshot.nextOperation) || snapshot.nextOperation < 1 ||
          !Number.isSafeInteger(snapshot.designVersion) || snapshot.designVersion < 1 ||
          !/^[a-f0-9]{64}$/.test(snapshot.designCommitment ?? '') ||
          !validAddress(snapshot.sourceTokenAddress) ||
          !validAddress(snapshot.oraoTreasury)) return UNAVAILABLE;

      const seedHex = randomBytes(32).toString('hex');
      const client = await pool.connect();
      let row;
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO alpha_silver_opening_candidate_intents
          (cluster, genesis_hash, program_id, mint_address, account_id, wallet_address,
           source_token_address, escrow_address, next_operation, design_version,
           design_commitment, orao_treasury, seed_hex)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (cluster, genesis_hash, program_id, mint_address) DO NOTHING`,
        [cluster, expectedGenesisHash, programId, mintAddress, session.account_id, walletAddress,
          snapshot.sourceTokenAddress, escrowAddress, snapshot.nextOperation,
          snapshot.designVersion, snapshot.designCommitment, snapshot.oraoTreasury, seedHex]);
        row = (await client.query(`SELECT * FROM alpha_silver_opening_candidate_intents
          WHERE cluster = $1 AND genesis_hash = $2 AND program_id = $3
          AND mint_address = $4 FOR UPDATE`,
        [cluster, expectedGenesisHash, programId, mintAddress])).rows[0];
        if (!row || row.account_id !== session.account_id ||
            row.wallet_address !== walletAddress ||
            row.source_token_address !== snapshot.sourceTokenAddress ||
            row.escrow_address !== escrowAddress ||
            BigInt(row.next_operation) !== BigInt(snapshot.nextOperation) ||
            BigInt(row.design_version) !== BigInt(snapshot.designVersion) ||
            row.design_commitment !== snapshot.designCommitment ||
            row.orao_treasury !== snapshot.oraoTreasury) {
          await client.query('ROLLBACK');
          return UNAVAILABLE;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }

      const seed = Buffer.from(row.seed_hex, 'hex');
      if (!await chain.isCandidateRequestAbsent({ programId, mintAddress,
        nextOperation: snapshot.nextOperation, seed })) return UNAVAILABLE;
      const lifetime = await chain.getCandidateBlockhash();
      if (lifetime.genesisHash !== expectedGenesisHash ||
          !Number.isSafeInteger(lifetime.lastValidBlockHeight)) return UNAVAILABLE;
      const fresh = await preflight.preflight(token, body);
      if (fresh.status !== 200 || fresh.body.walletAddress !== walletAddress ||
          fresh.body.escrowAddress !== escrowAddress) return UNAVAILABLE;
      const intent = await buildSilverOpeningCandidateMessage({ cluster,
        programId, walletAddress, mintAddress,
        userTokenAddress: row.source_token_address, escrowAddress,
        nextOperation: snapshot.nextOperation, designVersion: snapshot.designVersion,
        oraoTreasury: snapshot.oraoTreasury, seed, blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        marketProgramId: snapshot.marketProgramId ?? null });
      return { status: 200, body: { testOnly: true, cluster,
        walletAddress, mintAddress, operation: intent.operation, request: intent.request,
        seedHex: row.seed_hex, messageBase64: intent.messageBase64,
        blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight } };
    },
  };
}
