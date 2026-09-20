import { address, createSolanaRpc, getAddressDecoder, getAddressEncoder,
  getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const decode = (bytes) => getAddressDecoder().decode(bytes);
const encode = (value) => getAddressEncoder().encode(address(value));
const text = (value) => new TextEncoder().encode(value);
const uuid = (bytes) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function createSilverChainReader(rpcUrl) {
  if (!rpcUrl) throw new Error('Silver chain reader requires Devnet RPC');
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async readFinalized({ programId, cluster, issuanceId, expectedFinalizedSignature }) {
      if (cluster !== 'devnet' || !/^[a-f0-9]{64}$/.test(issuanceId) ||
          await rpc.getGenesisHash().send() !== DEVNET_GENESIS) {
        throw new Error('Silver chain reader cluster/issuance mismatch');
      }
      const [mint] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-mint'), Buffer.from(issuanceId, 'hex')] });
      const [state] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-state'), encode(mint)] });
      const [collection] = await getProgramDerivedAddress({ programAddress: address(programId),
        seeds: [text('silver-collection')] });
      const rawState = (await rpc.getAccountInfo(address(state), {
        encoding: 'base64', commitment: 'finalized',
      }).send()).value;
      if (!rawState) return null;
      const bytes = Buffer.from(rawState.data[0], 'base64');
      const schema = bytes[0];
      if (rawState.owner !== programId ||
          !((schema === 2 && bytes.length === 188) || (schema === 3 && bytes.length === 204)) ||
          bytes[1] !== 1 || bytes[2] !== 1 || bytes[3] !== 1 ||
          bytes.subarray(4, 36).toString('hex') !== issuanceId ||
          decode(bytes.subarray(36, 68)) !== mint ||
          decode(bytes.subarray(68, 100)) !== collection) return null;
      const issuanceSlot = bytes.readBigUInt64LE(180);
      let lastDirectTransferSlot;
      let cooldownUntilUnixSeconds;
      if (schema === 3) {
        const [extraMetas] = await getProgramDerivedAddress({ programAddress: address(programId),
          seeds: [text('extra-account-metas'), encode(mint)] });
        const rawMetas = (await rpc.getAccountInfo(address(extraMetas), {
          encoding: 'base64', commitment: 'finalized',
        }).send()).value;
        const metaBytes = rawMetas && Buffer.from(rawMetas.data[0], 'base64');
        if (rawMetas?.owner !== programId || metaBytes?.length < 12 ||
            !metaBytes.subarray(0, 8).equals(Buffer.from('692565c54bfb661a', 'hex'))) return null;
        const slot = bytes.readBigUInt64LE(188);
        const until = bytes.readBigInt64LE(196);
        if ((slot === 0n) !== (until === 0n) || until < 0n) return null;
        lastDirectTransferSlot = slot.toString();
        cooldownUntilUnixSeconds = until.toString();
      }

      const owner = decode(bytes.subarray(100, 132));
      const parsedMint = (await rpc.getAccountInfo(address(mint), {
        encoding: 'jsonParsed', commitment: 'finalized',
      }).send()).value;
      const tokenAccounts = (await rpc.getTokenAccountsByOwner(address(owner),
        { mint: address(mint) }, { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      const token = tokenAccounts.find(({ account }) =>
        account.owner === TOKEN_2022_PROGRAM_ADDRESS &&
        account.data.parsed?.info?.mint === mint &&
        account.data.parsed.info.owner === owner &&
        account.data.parsed.info.tokenAmount.amount === '1');
      const mintInfo = parsedMint?.data?.parsed?.info;
      if (parsedMint?.owner !== TOKEN_2022_PROGRAM_ADDRESS || !token ||
          mintInfo?.supply !== '1' || mintInfo.decimals !== 0 ||
          mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) return null;
      let finalizedSignature = expectedFinalizedSignature;
      if (finalizedSignature) {
        const { value } = await rpc.getSignatureStatuses([finalizedSignature],
          { searchTransactionHistory: true }).send();
        if (value[0]?.err !== null || value[0]?.confirmationStatus !== 'finalized' ||
            BigInt(value[0].slot) !== issuanceSlot) return null;
      } else {
        const signatures = await rpc.getSignaturesForAddress(address(state),
          { limit: 1000, commitment: 'finalized' }).send();
        finalizedSignature = signatures.find(item => item.err === null &&
          BigInt(item.slot) === issuanceSlot)?.signature;
        if (!finalizedSignature) return null;
      }
      return { finalized: true, finalizedSignature,
        stateSchemaVersion: schema, programId, stateOwnerProgramId: rawState.owner,
        mintOwnerProgramId: parsedMint.owner,
        tokenAccountOwnerProgramId: token.account.owner,
        collectionId: collection, cluster, issuanceId,
        entitlementDigest: bytes.subarray(132, 164).toString('hex'),
        issuanceSource: 'first-entry', accountId: uuid(bytes.subarray(164, 180)),
        kind: 'SILVER_BOX', lifecycle: 'SEALED', originalRecipient: owner,
        mintAddress: mint, stateAddress: state, stateMint: mint, tokenMint: mint,
        tokenOwner: owner, supply: mintInfo.supply, decimals: mintInfo.decimals,
        tokenAmount: token.account.data.parsed.info.tokenAmount.amount,
        mintAuthority: mintInfo.mintAuthority, freezeAuthority: mintInfo.freezeAuthority,
        ...(schema === 3 ? { lastDirectTransferSlot, cooldownUntilUnixSeconds } : {}) };
    }
  };
}
