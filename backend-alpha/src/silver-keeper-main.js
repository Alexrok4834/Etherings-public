import pg from 'pg';
import { createSilverKeeper } from './silver-keeper.js';
import { createSilverKeeperChain } from './silver-keeper-chain.js';
import { createSilverChainReader } from './silver-chain.js';
import { createSilverEscrowProvisioner } from './silver-escrow-provisioner.js';
import { installKeeperRpcMeter } from './keeper-rpc-meter.js';

if (process.env.ALPHA_SILVER_KEEPER_ENABLED !== 'true' ||
    process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet' ||
    !process.env.ALPHA_DATABASE_URL || !process.env.ALPHA_ERU_PROOF_RPC_URL ||
    !process.env.ALPHA_SILVER_KEEPER_PAYER_FILE)
  throw new Error('Silver keeper requires explicit separate DEV Alpha configuration');

const programId = process.env.ALPHA_SILVER_PROGRAM_ID;
const rpcMeter = process.env.ALPHA_KEEPER_RPC_METRICS_ENABLED === 'true'
  ? installKeeperRpcMeter({ rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL }) : null;
const measure = (name, task) => rpcMeter ? rpcMeter.measure(name, task) : task();
let lastMeterReport = Date.now();
const pool = new pg.Pool({ connectionString: process.env.ALPHA_DATABASE_URL, max: 2 });
try {
  await pool.query('SELECT status FROM alpha_silver_opening_finalizations LIMIT 1');
  const chain = createSilverKeeperChain({ rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
    programId, payerKeyPath: process.env.ALPHA_SILVER_KEEPER_PAYER_FILE,
    expectedProgramSha256: process.env.ALPHA_SILVER_PROGRAM_SHA256,
    expectedProgramSize: Number(process.env.ALPHA_SILVER_PROGRAM_SIZE) });
  const breedingEnabled = process.env.ALPHA_COOPER_BREEDING_ENABLED === 'true';
  const keeper = createSilverKeeper({ pool, chain, programId, breedingEnabled });
  const provisioner = createSilverEscrowProvisioner({ pool, chain,
    reader: createSilverChainReader(process.env.ALPHA_ERU_PROOF_RPC_URL),
    programId, breedingEnabled });
  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { running = false; });
  while (running) {
    try {
      const escrow = await measure('escrow-provisioner', () => provisioner.tick());
      if (escrow.sent > 0) console.log('Silver escrow provisioned', JSON.stringify(escrow));
    } catch (error) {
      console.error('Silver escrow provisioner tick failed', error.code ?? error.name);
    }
    try {
      const result = await measure('silver-keeper', () => keeper.tick());
      if (Object.values(result).some(value => value > 0))
        console.log('Silver keeper tick', JSON.stringify(result));
    } catch (error) {
      console.error('Silver keeper tick failed', error.code ?? error.name);
    }
    if (rpcMeter && Date.now() - lastMeterReport >= 15 * 60_000) {
      console.log('Silver keeper RPC method counts', JSON.stringify(rpcMeter.snapshotAndReset()));
      lastMeterReport = Date.now();
    }
    if (running) await new Promise(resolve => setTimeout(resolve, 15_000));
  }
} finally {
  await pool.end();
}
