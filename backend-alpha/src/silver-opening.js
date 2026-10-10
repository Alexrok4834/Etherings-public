import { createHash } from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';

const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const UNAVAILABLE = { status: 409, body: { message: 'Silver opening unavailable.' } };
const INVALID = { status: 400, body: { message: 'Invalid Silver opening request.' } };
const text = value => new TextEncoder().encode(value);

function validAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch { return false; }
}

export function createSilverOpeningPreflight({ pool, silver, chain, cluster, programId,
  walletEnvironment, signingEnabled = false, now = () => Date.now() }) {
  if (!pool || typeof silver?.inventory !== 'function' ||
      typeof chain?.readEscrow !== 'function' ||
      !['local-validator', 'devnet'].includes(cluster) || !validAddress(programId) ||
      !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? '')) {
    throw new Error('Silver opening preflight requires isolated account and chain readers');
  }

  return {
    async preflight(token, body) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return UNAUTHORIZED;
      const session = (await pool.query(
        `SELECT a.id AS account_id, b.wallet_address, b.environment
         FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
         LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
         WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
        [createHash('sha256').update(token).digest('hex'), new Date(now())]
      )).rows[0];
      if (!session) return UNAUTHORIZED;
      if (!validAddress(session.wallet_address) || session.environment !== walletEnvironment) return UNAVAILABLE;
      if (!body || Object.keys(body).length !== 1 || !validAddress(body.mintAddress)) return INVALID;

      const inventory = await silver.inventory(token);
      if (inventory.status !== 200) return inventory;
      if (!Array.isArray(inventory.body?.assets)) return UNAVAILABLE;
      const matching = inventory.body.assets.filter(asset =>
        asset.kind === 'SILVER_BOX' && asset.mintAddress === body.mintAddress &&
        asset.lifecycle === 'SEALED');
      if (matching.length !== 1 ||
          !/^(0|[1-9][0-9]*)$/.test(matching[0].cooldownUntilUnixSeconds) ||
          BigInt(matching[0].cooldownUntilUnixSeconds) > BigInt(Math.floor(now() / 1000))) {
        return UNAVAILABLE;
      }

      const mintAddress = body.mintAddress;
      const [escrowAuthority] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [text('silver-escrow'), getAddressEncoder().encode(address(mintAddress))],
      });
      const [escrowAddress] = await findAssociatedTokenPda({
        mint: address(mintAddress), owner: address(escrowAuthority),
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      const escrow = await chain.readEscrow({ cluster, programId, mintAddress,
        escrowAddress, escrowAuthority });
      if (escrow?.finalized !== true || escrow.cluster !== cluster ||
          escrow.address !== escrowAddress ||
          escrow.programOwner !== TOKEN_2022_PROGRAM_ADDRESS ||
          escrow.mintAddress !== mintAddress || escrow.authority !== escrowAuthority ||
          escrow.amount !== '0') return UNAVAILABLE;

      return { status: 200, body: { cluster, walletAddress: session.wallet_address,
        mintAddress, escrowAddress, signingEnabled } };
    },
  };
}
