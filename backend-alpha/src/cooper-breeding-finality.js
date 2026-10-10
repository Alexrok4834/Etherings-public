import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import bs58 from 'bs58';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { readPreparedCooperBreeding } from './cooper-breeding-candidate-reader.js';
import { verifyCooperBreedingCandidateEnvelope } from './cooper-breeding-intent.js';
import { cooperBreedingPrice } from './cooper-breeding-price.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const unavailable = () => new Error('Cooper breeding finality unavailable');
const uuid = value => Buffer.from(value.replaceAll('-', ''), 'hex');
const raw = value => getAddressEncoder().encode(address(value));
const utf8 = value => new TextEncoder().encode(value);
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({
  programAddress: address(program), seeds,
}))[0];

// Read-only verification; a signature or chain account alone cannot settle ERT.
export function createCooperBreedingFinalityReader({ pool, chain, silverChain,
  silverProgramId }) {
  if (typeof pool?.query !== 'function' ||
      ['getGenesisHash', 'getSignatureStatus', 'getTransaction', 'getAccountInfo']
        .some(name => typeof chain?.[name] !== 'function') ||
      typeof silverChain?.readIssuedBreedingBox !== 'function') throw unavailable();
  return {
    async verify(accountId, operationId, signature) {
      if (typeof signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
          bs58.decode(signature).length !== 64) throw unavailable();
      const binding = (await pool.query(`SELECT * FROM alpha_cooper_breeding_issuances
        WHERE account_id = $1 AND operation_id = $2`, [accountId, operationId])).rows[0];
      if (!binding || binding.cluster !== 'devnet' ||
          binding.genesis_hash !== GENESIS ||
          await chain.getGenesisHash() !== GENESIS) throw unavailable();
      const prepared = await readPreparedCooperBreeding(pool, accountId, operationId);
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
        issuanceId: prepared.issuance_id, walletAddress: binding.wallet_address,
        attestorAddress: binding.attestor_address,
        gatewayProgramId: binding.gateway_program_id, silverProgramId,
        cluster: 'devnet', genesisHash: GENESIS, nonce: Number(binding.nonce),
        configEpoch: String(binding.config_epoch), expirySlot: Number(binding.expiry_slot),
        intentDigest: binding.intent_digest };
      if (!verifyCooperBreedingCandidateEnvelope(candidate)) throw unavailable();
      for (let i = 0; i < 2; i++) {
        const key = bs58.decode(decoded.staticAccounts[i]);
        if (key.length !== 32 || !verifySignature(null, messageBytes,
          createPublicKey({ key: Buffer.concat([SPKI, key]),
            format: 'der', type: 'spki' }), bytes.subarray(1 + i * 64, 65 + i * 64)))
          throw unavailable();
      }
      const ix = getInstructionsFromCompiledTransactionMessage(decoded)[1];
      const data = Buffer.from(ix.data);
      const price = cooperBreedingPrice(prepared.first_uses, prepared.second_uses);
      if (!price || data.readBigUInt64LE(1) !== price.eruPrincipalUnits ||
          data.readBigUInt64LE(107) !== BigInt(price.ertExact) ||
          data.subarray(57, 73).toString('hex') !== accountId.replaceAll('-', '') ||
          data.subarray(73, 89).toString('hex') !== prepared.first_ring_id.replaceAll('-', '') ||
          data.subarray(89, 105).toString('hex') !== prepared.second_ring_id.replaceAll('-', '') ||
          data[105] !== prepared.first_uses || data[106] !== prepared.second_uses ||
          ix.accounts[9].address !== TOKEN_2022_PROGRAM_ADDRESS ||
          ix.accounts[2].address !== ix.accounts[3].address ||
          ix.accounts[4].address !== binding.wallet_address ||
          ix.accounts[5].address !== binding.attestor_address ||
          ix.accounts[12].address !== binding.wallet_address ||
          ix.accounts[16].address !== silverProgramId ||
          ix.accounts[0].address === ix.accounts[2].address) throw unavailable();
      const config = ix.accounts[6].address;
      const replay = await pda(binding.gateway_program_id, utf8('nonce'),
        raw(config), raw(binding.wallet_address));
      const operationReplay = await pda(binding.gateway_program_id,
        utf8('cooper-breeding'), raw(config), raw(binding.wallet_address), uuid(operationId));
      const boxMint = await pda(silverProgramId, utf8('silver-mint'),
        Buffer.from(prepared.issuance_id, 'hex'));
      if (ix.accounts[11].address !== replay ||
          ix.accounts[14].address !== operationReplay ||
          ix.accounts[18].address !== boxMint) throw unavailable();
      const [nonceState, operationState] = await Promise.all([
        chain.getAccountInfo(replay), chain.getAccountInfo(operationReplay),
      ]);
      const operationDigest = createHash('sha256').update(data.subarray(1)).digest();
      if (nonceState?.owner !== binding.gateway_program_id ||
          nonceState.data?.length !== 8 ||
          Buffer.from(nonceState.data).readBigUInt64LE() < BigInt(binding.nonce) ||
          operationState?.owner !== binding.gateway_program_id ||
          operationState.data?.length !== 32 ||
          !Buffer.from(operationState.data).equals(operationDigest)) throw unavailable();
      const balance = (rows, key) => {
        const index = decoded.staticAccounts.indexOf(key);
        const match = rows?.filter(item => item.accountIndex === index &&
          item.mint === ix.accounts[1].address &&
          item.programId === TOKEN_2022_PROGRAM_ADDRESS);
        if (index < 0 || match?.length !== 1 ||
            !/^(?:0|[1-9][0-9]*)$/.test(match[0].uiTokenAmount?.amount ?? ''))
          throw unavailable();
        return BigInt(match[0].uiTokenAmount.amount);
      };
      const source = ix.accounts[0].address;
      const treasury = ix.accounts[2].address;
      if (balance(tx.meta.preTokenBalances, source) -
            balance(tx.meta.postTokenBalances, source) !==
            price.eruPrincipalUnits + price.eruFeeUnits ||
          balance(tx.meta.postTokenBalances, treasury) -
            balance(tx.meta.preTokenBalances, treasury) !== price.eruFeeUnits)
        throw unavailable();
      const boxToken = ix.accounts[20].address;
      const boxTokenIndex = decoded.staticAccounts.indexOf(boxToken);
      const minted = tx.meta.postTokenBalances?.filter(item =>
        item.accountIndex === boxTokenIndex && item.mint === boxMint &&
        item.programId === TOKEN_2022_PROGRAM_ADDRESS &&
        item.owner === prepared.wallet_address &&
        item.uiTokenAmount?.amount === '1');
      if (boxTokenIndex < 0 || minted?.length !== 1 ||
          tx.meta.preTokenBalances?.some(item =>
            item.accountIndex === boxTokenIndex && item.mint === boxMint))
        throw unavailable();
      const box = await silverChain.readIssuedBreedingBox({ programId: silverProgramId,
        cluster: 'devnet', issuanceId: prepared.issuance_id,
        accountId, walletAddress: prepared.wallet_address,
        operationId, firstRingId: prepared.first_ring_id,
        secondRingId: prepared.second_ring_id,
        firstUses: prepared.first_uses, secondUses: prepared.second_uses,
        entitlementDigest: prepared.entitlement_digest,
        issuanceSlot: tx.slot });
      if (!box || box.mintAddress !== boxMint ||
          box.issuanceSlot !== String(tx.slot) ||
          box.accountId !== accountId ||
          box.entitlementDigest !== prepared.entitlement_digest)
        throw unavailable();
      return { status: 'verified', operationId, accountId, signature,
        slot: Number(tx.slot), intentDigest: binding.intent_digest,
        transactionDigest: createHash('sha256').update(bytes).digest('hex'),
        operationReplayDigest: operationDigest.toString('hex'), boxMint };
    },
  };
}
