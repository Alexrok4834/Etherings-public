import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import bs58 from 'bs58';
import { address, createSolanaRpc, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { readPreparedCooperEru } from './cooper-eru-candidate-reader.js';
import { verifyCooperEruCandidateEnvelope } from './cooper-eru-intent.js';

const unavailable = () => new Error('Cooper ERU finality unavailable');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const units = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value))
    throw unavailable();
  const [whole, fraction = ''] = value.split('.');
  const exact = fraction.padEnd(18, '0');
  if (exact.slice(9) !== '000000000') throw unavailable();
  return BigInt(whole) * 1_000_000_000n + BigInt(exact.slice(0, 9));
};
const uuid = value => Buffer.from(value.replaceAll('-', ''), 'hex');
const raw = key => getAddressEncoder().encode(address(key));
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(programAddress), seeds,
}))[0];

export function createCooperEruFinalityChainReader({ rpcUrl, cluster }) {
  if ((cluster === 'local-validator' && rpcUrl !== 'http://127.0.0.1:18889') ||
      (cluster === 'devnet' && (() => {
        try { const url = new URL(rpcUrl); return url.protocol !== 'https:' ||
          url.hostname !== 'solana-devnet.g.alchemy.com'; }
        catch { return true; }
      })()) || !['local-validator', 'devnet'].includes(cluster)) throw unavailable();
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async getGenesisHash() { return rpc.getGenesisHash().send(); },
    async getSignatureStatus(signature) {
      return (await rpc.getSignatureStatuses([signature],
        { searchTransactionHistory: true }).send()).value[0];
    },
    async getTransaction(signature) {
      return rpc.getTransaction(signature, { encoding: 'base64', commitment: 'finalized',
        maxSupportedTransactionVersion: 0 }).send();
    },
    async getAccountInfo(key) {
      const { value } = await rpc.getAccountInfo(address(key), {
        encoding: 'base64', commitment: 'finalized',
      }).send();
      return value && { owner: value.owner, data: Buffer.from(value.data[0], 'base64') };
    },
  };
}

// Read-only pre-settlement verifier. Null/failed/delayed observations remain
// UNKNOWN; no ERT hold is released and no Cooper state is changed here.
export function createCooperEruFinalityReader({ pool, chain, cluster, expectedGenesisHash }) {
  if (!pool || typeof pool.query !== 'function' || !chain ||
      ['getGenesisHash', 'getSignatureStatus', 'getTransaction', 'getAccountInfo']
        .some(name => typeof chain[name] !== 'function') ||
      !['local-validator', 'devnet'].includes(cluster) ||
      (cluster === 'devnet' && expectedGenesisHash !== DEVNET_GENESIS)) throw unavailable();
  return {
    async verify(accountId, operationId, signature) {
      if (!SIGNATURE.test(signature ?? '') || bs58.decode(signature).length !== 64)
        throw unavailable();
      const binding = (await pool.query(`SELECT * FROM alpha_cooper_level_eru_issuances
        WHERE operation_id = $1 AND account_id = $2`, [operationId, accountId])).rows[0];
      if (!binding || binding.cluster !== cluster ||
          await chain.getGenesisHash() !== expectedGenesisHash ||
          binding.genesis_hash !== expectedGenesisHash) throw unavailable();
      const prepared = await readPreparedCooperEru(pool, accountId, operationId, cluster);
      if (binding.reservation_id !== prepared.reservation_id ||
          binding.wallet_address !== prepared.wallet_address) throw unavailable();
      const status = await chain.getSignatureStatus(signature);
      if (status?.confirmationStatus !== 'finalized' || status.err !== null)
        return { status: 'unknown' };
      const tx = await chain.getTransaction(signature);
      if (!tx?.transaction?.[0] || !tx.meta || tx.meta.err !== null ||
          !Number.isSafeInteger(Number(tx.slot)) || Number(tx.slot) < 1)
        return { status: 'unknown' };
      const bytes = Buffer.from(tx.transaction[0], 'base64');
      if (bytes.toString('base64') !== tx.transaction[0] || bytes[0] !== 2 ||
          bytes.length < 130 || bytes.length > 1232 ||
          !Buffer.from(bs58.decode(signature)).equals(bytes.subarray(1, 65)))
        throw unavailable();
      const messageBytes = bytes.subarray(129);
      const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
      const candidate = { messageBase64: messageBytes.toString('base64'),
        sizeBytes: bytes.length, operationId, reservationId: binding.reservation_id,
        walletAddress: binding.wallet_address, attestorAddress: binding.attestor_address,
        gatewayProgramId: binding.gateway_program_id, nonce: Number(binding.nonce),
        configEpoch: String(binding.config_epoch), expirySlot: Number(binding.expiry_slot),
        intentDigest: binding.intent_digest };
      if (!verifyCooperEruCandidateEnvelope(candidate)) throw unavailable();
      for (let index = 0; index < 2; index++) {
        const key = bs58.decode(decoded.staticAccounts[index]);
        if (key.length !== 32 || !verifySignature(null, messageBytes,
          createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]),
            format: 'der', type: 'spki' }), bytes.subarray(1 + index * 64, 65 + index * 64)))
          throw unavailable();
      }
      const ix = getInstructionsFromCompiledTransactionMessage(decoded)[1];
      const data = Buffer.from(ix.data);
      if (!data.subarray(57, 73).equals(uuid(prepared.ring_id)) ||
          !data.subarray(73, 89).equals(uuid(accountId)) ||
          data[89] !== prepared.expected_level || data[90] !== prepared.target_level ||
          data.readBigUInt64LE(1) !== units(prepared.eru_principal) ||
          data.readBigUInt64LE(91) !== BigInt(prepared.ert_cost.split('.')[0]) ||
          units(prepared.eru_fee) !==
            (units(prepared.eru_principal) * 200n + 9_999n) / 10_000n ||
          ix.accounts[9].address !== TOKEN_2022_PROGRAM_ADDRESS ||
          ix.accounts[2].address !== ix.accounts[3].address ||
          ix.accounts[0].address === ix.accounts[2].address) throw unavailable();
      const balance = (rows, key) => {
        const index = decoded.staticAccounts.indexOf(key);
        const matches = rows?.filter(item => item.accountIndex === index &&
          item.mint === ix.accounts[1].address &&
          item.programId === TOKEN_2022_PROGRAM_ADDRESS);
        if (index < 0 || matches?.length !== 1 ||
            !/^(?:0|[1-9][0-9]*)$/.test(matches[0].uiTokenAmount?.amount ?? ''))
          throw unavailable();
        return BigInt(matches[0].uiTokenAmount.amount);
      };
      const source = ix.accounts[0].address;
      const treasury = ix.accounts[2].address;
      const principal = units(prepared.eru_principal);
      const fee = units(prepared.eru_fee);
      if (balance(tx.meta.preTokenBalances, source) -
            balance(tx.meta.postTokenBalances, source) !== principal + fee ||
          balance(tx.meta.postTokenBalances, treasury) -
            balance(tx.meta.preTokenBalances, treasury) !== fee) throw unavailable();
      const config = ix.accounts[6].address;
      const replay = await pda(binding.gateway_program_id,
        new TextEncoder().encode('nonce'), raw(config), raw(binding.wallet_address));
      const operationReplay = await pda(binding.gateway_program_id,
        new TextEncoder().encode('cooper-level-up'), raw(config),
        raw(binding.wallet_address), uuid(operationId));
      if (ix.accounts[11].address !== replay || ix.accounts[14].address !== operationReplay)
        throw unavailable();
      const [replayState, operationState] = await Promise.all([
        chain.getAccountInfo(replay), chain.getAccountInfo(operationReplay),
      ]);
      const expectedOperationHash = createHash('sha256').update(data.subarray(1)).digest();
      if (replayState?.owner !== binding.gateway_program_id ||
          replayState.data?.length !== 8 ||
          Buffer.from(replayState.data).readBigUInt64LE() < BigInt(binding.nonce) ||
          operationState?.owner !== binding.gateway_program_id ||
          operationState.data?.length !== 32 ||
          !Buffer.from(operationState.data).equals(expectedOperationHash)) throw unavailable();
      // A caller must revalidate this evidence and the hold under its DB lock
      // before an eventual exactly-once ERT/Level settlement transaction.
      return { status: 'verified', operationId, accountId, signature,
        slot: Number(tx.slot), intentDigest: binding.intent_digest,
        transactionDigest: createHash('sha256').update(bytes).digest('hex'),
        operationReplayDigest: expectedOperationHash.toString('hex') };
    },
  };
}
