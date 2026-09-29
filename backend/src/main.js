import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createAuth } from './auth.js';
import { createEruProof } from './eru.js';
import { ResendMailTransport } from './mail.js';
import { createAlphaServer } from './server.js';
import { createWalletBinding } from './wallet.js';
import { createSilverFirstEntry } from './silver-first-entry.js';
import { createSilverChainReader } from './silver-chain.js';
import { address, getProgramDerivedAddress } from '@solana/kit';

const required = ['ALPHA_DATABASE_URL', 'ALPHA_CODE_SECRET', 'RESEND_API_KEY', 'ALPHA_EMAIL_FROM', 'ALPHA_WALLET_ENVIRONMENT'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required Alpha configuration: ${name}`);
}
if (process.env.ALPHA_CODE_SECRET.length < 32) throw new Error('Invalid Alpha code secret');

const port = Number(process.env.ALPHA_LISTEN_PORT ?? 9081);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Alpha listen port');
const pool = new pg.Pool({ connectionString: process.env.ALPHA_DATABASE_URL, max: 8 });
const mailer = new ResendMailTransport({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.ALPHA_EMAIL_FROM
});

try {
  await pool.query('SELECT 1 FROM alpha_accounts LIMIT 1');
  await pool.query('SELECT 1 FROM alpha_wallet_bindings LIMIT 1');
  const eru = process.env.ALPHA_ERU_PROOF_POLICY_FILE
    ? createEruProof({ pool,
      policy: JSON.parse(readFileSync(process.env.ALPHA_ERU_PROOF_POLICY_FILE, 'utf8')),
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
      cluster: process.env.ALPHA_ERU_PROOF_CLUSTER ?? 'local-validator' }) : null;
  if (eru) await pool.query('SELECT cluster FROM alpha_eru_intents LIMIT 1');
  const silverProgram = process.env.ALPHA_SILVER_PROGRAM_ID;
  const silver = silverProgram ? await (async () => {
    if (process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet' ||
        !process.env.ALPHA_ERU_PROOF_RPC_URL) {
      throw new Error('Silver requires separate Devnet RPC configuration');
    }
    await pool.query('SELECT status FROM alpha_silver_first_entry LIMIT 1');
    const [collectionId] = await getProgramDerivedAddress({
      programAddress: address(silverProgram),
      seeds: [new TextEncoder().encode('silver-collection')],
    });
    return createSilverFirstEntry({ pool,
      chain: createSilverChainReader(process.env.ALPHA_ERU_PROOF_RPC_URL),
      cluster: 'devnet', programId: silverProgram, collectionId,
      walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT });
  })() : null;
  const server = createAlphaServer(
    createAuth({ pool, mailer, codeSecret: process.env.ALPHA_CODE_SECRET }),
    createWalletBinding({ pool, environment: process.env.ALPHA_WALLET_ENVIRONMENT }), eru, silver
  );
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => pool.end()));
  }
} catch (error) {
  await pool.end();
  throw new Error('Alpha service startup failed', { cause: error.code });
}
