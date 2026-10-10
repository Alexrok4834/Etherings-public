import { address, getAddressEncoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { verifyCooperEruDevnetConfig } from './cooper-eru-candidate-reader.js';

const SQL = `SELECT family, state, count(*)::text AS count,
    min(created_at) FILTER (WHERE unresolved) AS oldest_unresolved_at
  FROM (
    SELECT 'eru_send_' || intent_namespace AS family, status AS state, created_at,
      status IN ('pending', 'unknown') AS unresolved
    FROM alpha_eru_intents WHERE cluster = 'devnet'
    UNION ALL
    SELECT 'hybrid_' || operation_type, status, created_at,
      status IN ('pending', 'unknown')
    FROM alpha_hybrid_operations WHERE cluster = 'devnet'
    UNION ALL
    SELECT 'silver_first_entry', status, created_at,
      status IN ('pending', 'unknown')
    FROM alpha_silver_first_entry WHERE cluster = 'devnet'
    UNION ALL
    SELECT 'draw_' || lower(f.reward_type), lower(f.state), r.created_at,
      f.state IN ('PENDING', 'UNKNOWN')
    FROM alpha_draw_fulfillments f
    JOIN alpha_draw_results r ON r.id = f.result_id
  ) operations GROUP BY family, state ORDER BY family, state`;

function amount(account, mint, owner = null) {
  const encoded = Buffer.from(getAddressEncoder().encode(address(mint)));
  if (account?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
      account.data?.length < 165 || account.data[108] !== 1 ||
      !account.data.subarray(0, 32).equals(encoded) ||
      (owner && !account.data.subarray(32, 64).equals(
        Buffer.from(getAddressEncoder().encode(address(owner))))))
    throw new Error('Canonical ERU token account unavailable');
  return account.data.readBigUInt64LE(64).toString();
}

export function createAdminOperationalStats({ pool, auth, chain, deployment }) {
  if (!pool?.query || !auth?.me || !chain || !deployment)
    throw new Error('Operational statistics configuration missing');
  return { async read(token) {
    const session = await auth.me(token);
    if (session.status !== 200) return session;
    const actor = (await pool.query(
      'SELECT is_admin, verified_at FROM alpha_accounts WHERE id = $1',
      [session.body.id])).rows[0];
    if (!actor?.is_admin || !actor.verified_at)
      return { status: 403, body: { code: 'ADMIN_REQUIRED' } };

    const [rows, verified] = await Promise.all([
      pool.query(SQL), verifyCooperEruDevnetConfig({ chain, ...deployment }),
    ]);
    const [mint, reserve, treasury] = await Promise.all([
      chain.getAccountInfo(verified.mint),
      chain.getAccountInfo(deployment.reserveAddress),
      chain.getAccountInfo(deployment.treasuryAddress),
    ]);
    if (mint?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
        mint.data?.length < 82 || mint.data[44] !== 9 || mint.data[45] !== 1)
      throw new Error('Canonical ERU mint unavailable');
    const operations = {};
    for (const row of rows.rows) {
      const group = operations[row.family] ??= { states: {}, oldestUnresolvedAt: null };
      group.states[row.state] = row.count;
      if (row.oldest_unresolved_at) {
        const at = new Date(row.oldest_unresolved_at).toISOString();
        if (!group.oldestUnresolvedAt || at < group.oldestUnresolvedAt)
          group.oldestUnresolvedAt = at;
      }
    }
    return { status: 200, body: {
      operations,
      canonicalEru: {
        cluster: 'devnet', commitment: 'confirmed', decimals: 9,
        mintAddress: String(verified.mint),
        supplyBaseUnits: mint.data.readBigUInt64LE(36).toString(),
        reserveAddress: deployment.reserveAddress,
        reserveBaseUnits: amount(reserve, verified.mint, deployment.vaultAddress),
        treasuryAddress: deployment.treasuryAddress,
        treasuryBaseUnits: amount(treasury, verified.mint),
        gateway: { healthy: true, programId: String(verified.gateway),
          hookProgramId: String(verified.hook), configAddress: String(verified.config),
          configEpoch: deployment.configEpoch, configSha256: verified.configSha256 },
      },
    } };
  } };
}
