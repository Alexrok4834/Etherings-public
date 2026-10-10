import { address, createSolanaRpc } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UNBOUND = { status: 409, body: { message: 'Verified wallet binding required.' } };

export function createWalletAssets({ wallet, silver, rpcUrl, mint, environment,
  rpc = rpcUrl && createSolanaRpc(rpcUrl) }) {
  if (!wallet || !silver || !rpc || !mint || !environment) {
    throw new Error('Wallet assets require binding, Silver reader and Devnet RPC');
  }
  address(mint);

  return {
    async read(token) {
      const binding = await wallet.current(token);
      if (binding.status !== 200) return binding;
      const walletAddress = binding.body.walletAddress;
      if (!walletAddress || binding.body.environment !== environment) return UNBOUND;
      address(walletAddress);
      if (await rpc.getGenesisHash().send() !== DEVNET_GENESIS) {
        throw new Error('Wallet asset reader cluster mismatch');
      }
      const inventory = await silver.inventory(token);
      if (inventory.status !== 200) return inventory;
      if (!Array.isArray(inventory.body.assets)) throw new Error('Invalid Silver inventory');

      const sol = (await rpc.getBalance(address(walletAddress),
        { commitment: 'finalized' }).send()).value;
      const accounts = (await rpc.getTokenAccountsByOwner(address(walletAddress),
        { mint: address(mint) }, { encoding: 'jsonParsed', commitment: 'finalized' }).send()).value;
      if (typeof sol !== 'bigint' || sol < 0n || !Array.isArray(accounts)) {
        throw new Error('Invalid wallet chain balance');
      }
      let eru = 0n;
      for (const { account } of accounts) {
        const info = account?.data?.parsed?.info;
        const amount = info?.tokenAmount?.amount;
        if (account?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
            account.data.parsed.type !== 'account' || info.owner !== walletAddress ||
            info.mint !== mint || info.tokenAmount.decimals !== 9 ||
            typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount)) {
          throw new Error('Invalid ERU token account');
        }
        eru += BigInt(amount);
      }
      return { status: 200, body: {
        cluster: 'devnet', walletAddress, solLamports: sol.toString(),
        eruBaseUnits: eru.toString(), eruMint: mint, silver: inventory.body.assets,
      } };
    },
  };
}
