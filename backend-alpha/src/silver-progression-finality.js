import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { readPreparedSilver } from './silver-progression-read.js';
import { buildSilverProgressionMessage } from './silver-progression-intent.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const GATEWAY = 'Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF';
const unavailable = () => new Error('Silver progression finality unavailable');
const raw = value => getAddressEncoder().encode(address(value));
const id = value => Buffer.from(value.replaceAll('-', ''), 'hex');
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];
const signed = (message, signature, signer) => {
  const key = Buffer.from(bs58.decode(signer));
  return key.length === 32 && verify(null, message, createPublicKey({
    key: Buffer.concat([SPKI, key]), format: 'der', type: 'spki',
  }), signature);
};

// A signature/receipt alone is not ERT settlement. The finalized transaction,
// two distinct signatures, exact instruction and immutable replay account must
// all agree with the held Alpha operation. RPC absence leaves the hold UNKNOWN.
export function createSilverProgressionFinality({ pool, chain, programId, issuerAddress }) {
  if (typeof pool?.query !== 'function' ||
      ['getGenesisHash', 'getSignatureStatus', 'getTransaction', 'getAccountInfo']
        .some(name => typeof chain?.[name] !== 'function')) throw unavailable();
  return {
    async verify(accountId, operationId, signature) {
      if (typeof signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
          bs58.decode(signature).length !== 64) throw unavailable();
      const submitted = (await pool.query(`SELECT * FROM alpha_silver_progression_submissions
        WHERE account_id = $1 AND operation_id = $2 AND signature = $3`,
      [accountId, operationId, signature])).rows[0];
      if (!submitted || await chain.getGenesisHash() !== GENESIS) throw unavailable();
      const preparation = await readPreparedSilver(pool, accountId, operationId);
      const status = await chain.getSignatureStatus(signature);
      if (status?.confirmationStatus !== 'finalized' || status.err !== null)
        return { status: 'unknown' };
      const tx = await chain.getTransaction(signature);
      if (!tx?.transaction?.[0] || tx.meta?.err !== null ||
          !Number.isSafeInteger(Number(tx.slot)) || Number(tx.slot) < 1)
        return { status: 'unknown' };
      const bytes = Buffer.from(tx.transaction[0], 'base64');
      if (bytes.toString('base64') !== tx.transaction[0] || bytes.length > 1232 ||
          bytes[0] !== 2 || bytes.length < 130 ||
          !Buffer.from(bs58.decode(signature)).equals(bytes.subarray(1, 65)))
        throw unavailable();
      const message = bytes.subarray(129);
      if (message.toString('base64') !== submitted.message_base64 ||
          bytes.subarray(65, 129).toString('base64') !== submitted.issuer_signature_base64)
        throw unavailable();
      const decoded = getCompiledTransactionMessageDecoder().decode(message);
      if (decoded.header.numSignerAccounts !== 2 ||
          decoded.staticAccounts[0] !== preparation.wallet_address ||
          decoded.staticAccounts[1] !== issuerAddress ||
          !signed(message, bytes.subarray(1, 65), preparation.wallet_address) ||
          !signed(message, bytes.subarray(65, 129), issuerAddress)) throw unavailable();
      const instructions = getInstructionsFromCompiledTransactionMessage(decoded);
      const paid = [5, 20].includes(preparation.target_level);
      if (instructions.length !== 2 || instructions[0].programAddress !== COMPUTE ||
          !Buffer.from(instructions[0].data).equals(Buffer.from(paid ?
            [2, 0, 0x35, 0x0c, 0] : [2, 0xe0, 0x93, 0x04, 0])) ||
          instructions[1].programAddress !== programId) throw unavailable();
      const instruction = instructions[1];
      const data = Buffer.from(instruction.data);
      const digest = createHash('sha256').update(instruction.data).update(Buffer.from(
        instruction.accounts.map(({ address: key, role }) => `${key}:${role}`).join('|'))).digest('hex');
      const mint = preparation.mint_address;
      const config = await pda(programId, new TextEncoder().encode('silver-config'));
      const ring = await pda(programId, new TextEncoder().encode('silver-ring-state'), raw(mint));
      const replay = await pda(programId, new TextEncoder().encode('silver-progress'),
        raw(mint), id(operationId));
      const accounts = instruction.accounts.map(item => item.address);
      if (digest !== submitted.intent_digest ||
          data.length !== (paid ? 83 : 59) || data[0] !== (paid ? 18 : 16) ||
          data[1] !== preparation.expected_level || data[2] !== preparation.target_level ||
          !data.subarray(3, 19).equals(id(operationId)) ||
          !data.subarray(19, 35).equals(id(preparation.reservation_id)) ||
          !data.subarray(35, 51).equals(id(accountId)) ||
          data.readBigUInt64LE(51) !== BigInt(5 * (preparation.target_level + 1)) ||
          accounts.length !== (paid ? 20 : 8) ||
          accounts[0] !== preparation.wallet_address ||
          accounts[1] !== issuerAddress || accounts[2] !== config ||
          accounts[3] !== mint || accounts[4] !== ring ||
          accounts[6] !== replay || accounts[7] !== SYSTEM)
        throw unavailable();
      let gatewayReplay = null;
      if (paid) {
        const configBytes = Buffer.from(submitted.gateway_config_base64 ?? '', 'base64');
        if (configBytes.length !== 330 ||
            configBytes.toString('base64') !== submitted.gateway_config_base64 ||
            data.readBigUInt64LE(59) > BigInt(Number.MAX_SAFE_INTEGER) ||
            data.readBigUInt64LE(67) > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
        const rebuilt = await buildSilverProgressionMessage({ preparation, programId,
          issuerAddress, tokenAddress: accounts[5], cluster: 'devnet',
          genesisHash: GENESIS, blockhash: decoded.lifetimeToken,
          lastValidBlockHeight: 1, gatewayConfigData: configBytes,
          nonce: Number(data.readBigUInt64LE(59)),
          expirySlot: Number(data.readBigUInt64LE(67)) });
        if (rebuilt.messageBase64 !== submitted.message_base64 ||
            rebuilt.intentDigest !== submitted.intent_digest ||
            accounts[8] !== GATEWAY ||
            data.readBigUInt64LE(75) !== BigInt(rebuilt.configEpoch))
          throw unavailable();
        const principal = preparation.target_level === 5 ? 38_000_000_000n : 75_000_000_000n;
        const u64 = number => {
          const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(number); return bytes;
        };
        const gatewayArgs = Buffer.concat([u64(principal), data.subarray(59, 75),
          data.subarray(3, 35), Buffer.from(raw(mint)), data.subarray(35, 51),
          data.subarray(1, 3), data.subarray(51, 59),
          Buffer.from([1]), data.subarray(75, 83)]);
        gatewayReplay = await chain.getAccountInfo(accounts[18]);
        if (gatewayArgs.length !== 123 || gatewayReplay?.owner !== GATEWAY ||
            gatewayReplay.data?.length !== 32 ||
            !gatewayReplay.data.equals(createHash('sha256').update(gatewayArgs).digest()))
          throw unavailable();
      } else if (submitted.gateway_config_base64 !== null) throw unavailable();
      const [replayState, ringState] = await Promise.all([
        chain.getAccountInfo(replay), chain.getAccountInfo(ring),
      ]);
      if (replayState?.owner !== programId || replayState.data?.length !== 128 ||
          !replayState.data.subarray(0, 8).equals(Buffer.from('ERSPRV1\0')) ||
          replayState.data[8] !== preparation.expected_level ||
          replayState.data[9] !== preparation.target_level ||
          !replayState.data.subarray(16, 48).equals(Buffer.from(raw(mint))) ||
          !replayState.data.subarray(48, 80).equals(Buffer.from(raw(preparation.wallet_address))) ||
          !replayState.data.subarray(80, 96).equals(id(operationId)) ||
          !replayState.data.subarray(96, 112).equals(id(preparation.reservation_id)) ||
          !replayState.data.subarray(112, 128).equals(id(accountId)) ||
          ringState?.owner !== programId || ringState.data?.length !== 576 ||
          !ringState.data.subarray(0, 8).equals(Buffer.from('ERSRGV1\0')) ||
          !ringState.data.subarray(16, 48).equals(Buffer.from(raw(mint))) ||
          ringState.data[290] !== preparation.target_level)
        throw unavailable();
      return { status: 'verified', accountId, operationId, signature,
        slot: Number(tx.slot), intentDigest: submitted.intent_digest,
        transactionDigest: createHash('sha256').update(bytes).digest('hex'),
        replayDigest: createHash('sha256').update(replayState.data).digest('hex') };
    },
  };
}
