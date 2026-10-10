import pg from 'pg';
import { isIP } from 'node:net';
import { createAuth } from './auth.js';
import { createCanonicalEruSend } from './eru-canonical-send.js';
import { ResendMailTransport } from './mail.js';
import { createAlphaServer } from './server.js';
import { createWalletBinding } from './wallet.js';
import { createWalletAssets } from './wallet-assets.js';
import { createReadOnlyRpcRoute, createReadOnlyRpcScope, createScopedReadRpc,
  readRouteMode } from './read-only-rpc-route.js';
import { createSilverFirstEntry } from './silver-first-entry.js';
import { createSilverChainReader } from './silver-chain.js';
import { createSilverOpeningPreflight } from './silver-opening.js';
import { createSilverOpeningCandidateIntent } from './silver-opening-candidate.js';
import { createStarterCooper } from './starter-cooper.js';
import { createCooperPointAllocation } from './cooper-point-allocation.js';
import { createCooperLevelUp } from './cooper-level-up.js';
import { createCooperEruChainReader, createCooperEruCandidateReader,
  verifyCooperEruDevnetConfig } from './cooper-eru-candidate-reader.js';
import { createCooperEruUnsignedIssuance } from './cooper-eru-issuance.js';
import { createCooperEruDevnetAttestation } from './cooper-eru-attestation.js';
import { createCooperEruFinalityChainReader, createCooperEruFinalityReader } from
  './cooper-eru-finality.js';
import { createCooperEruReconciliation } from './cooper-eru-reconciliation.js';
import { createCooperEruUserFlow } from './cooper-eru-user-flow.js';
import { createCooperEruHttp } from './cooper-eru-http.js';
import { createCooperBreeding } from './cooper-breeding.js';
import { createCooperBreedingCandidateReader } from './cooper-breeding-candidate-reader.js';
import { createCooperBreedingIssuance } from './cooper-breeding-issuance.js';
import { createCooperBreedingDevnetAttestation } from './cooper-breeding-attestation.js';
import { createCooperBreedingFinalityReader } from './cooper-breeding-finality.js';
import { createCooperBreedingReconciliation } from './cooper-breeding-reconciliation.js';
import { createCooperBreedingUserFlow } from './cooper-breeding-user-flow.js';
import { createCooperBreedingHttp } from './cooper-breeding-http.js';
import { createRingEquipment } from './ring-equipment.js';
import { createM2eStepSync } from './m2e-step-sync.js';
import { createM2eProfile } from './m2e-profile.js';
import { createM2eBalanceConfig } from './m2e-balance-config.js';
import { resolveM2eDisplayRingCount } from './m2e-ring-inputs.js';
import { createAdminErtCredit } from './admin-ert-credit.js';
import { createAdminOperationalStats } from './admin-operational-stats.js';
import { createAdminEruTransfer } from './admin-eru-transfer.js';
import { createAdminDashboard } from './admin-dashboard.js';
import { createAdminCooperGrant } from './admin-cooper-grant.js';
import { createAdminBoxGrant } from './admin-box-grant.js';
import { createSilverIssuerChain } from './silver-issuer-chain.js';
import { createSilverIssuer } from './silver-issuer.js';
import { createSilverProgression } from './silver-progression.js';
import { createSilverProgressionFinality } from './silver-progression-finality.js';
import { createSilverProgressionFlow } from './silver-progression-flow.js';
import { createSilverProgressionHttp } from './silver-progression-http.js';
import { createSilverAllocation } from './silver-allocation.js';
import { createAlphaDraw } from './draw.js';
import { createDrawBoxIssuer } from './draw-box-issuer.js';
import { createDrawEruChain } from './draw-eru-chain.js';
import { createDrawEruIssuer } from './draw-eru-issuer.js';
import { createSilverMarketplaceReader } from './silver-marketplace-read.js';
import { createSilverMarketplaceHttp } from './silver-marketplace-http.js';
import { createSilverMarketplaceFlow } from './silver-marketplace-flow.js';
import { createSilverDirectTransferFlow } from './silver-direct-transfer-flow.js';
import { address, createSolanaRpc, getProgramDerivedAddress } from '@solana/kit';

const required = ['ALPHA_DATABASE_URL', 'ALPHA_CODE_SECRET', 'RESEND_API_KEY', 'ALPHA_EMAIL_FROM', 'ALPHA_WALLET_ENVIRONMENT'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required Alpha configuration: ${name}`);
}
if (process.env.ALPHA_CODE_SECRET.length < 32) throw new Error('Invalid Alpha code secret');
const m2eStepSyncFlag = process.env.ALPHA_M2E_STEP_SYNC_ENABLED ?? 'false';
if (!['true', 'false'].includes(m2eStepSyncFlag))
  throw new Error('Invalid Alpha M2E step-sync gate');
const cooperEruFlag = process.env.ALPHA_COOPER_ERU_ENABLED ?? 'false';
if (!['true', 'false'].includes(cooperEruFlag))
  throw new Error('Invalid Alpha Cooper ERU gate');
const silverProgressionFlag = process.env.ALPHA_SILVER_PROGRESSION_ENABLED ?? 'false';
if (!['true', 'false'].includes(silverProgressionFlag))
  throw new Error('Invalid Alpha Silver progression gate');
const drawFlag = process.env.ALPHA_DRAW_ENABLED ?? 'false';
if (!['true', 'false'].includes(drawFlag))
  throw new Error('Invalid Alpha Draw gate');
const breedingFlag = process.env.ALPHA_COOPER_BREEDING_ENABLED ?? 'false';
if (!['true', 'false'].includes(breedingFlag))
  throw new Error('Invalid Alpha Cooper breeding gate');
const marketplaceFlag = process.env.ALPHA_MARKETPLACE_ENABLED ?? 'false';
if (!['true', 'false'].includes(marketplaceFlag))
  throw new Error('Invalid Alpha Marketplace gate');

const port = Number(process.env.ALPHA_LISTEN_PORT ?? 9081);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Alpha listen port');
const listenHost = process.env.ALPHA_LISTEN_HOST ?? '127.0.0.1';
if (!isIP(listenHost)) throw new Error('Invalid Alpha listen host');
const pool = new pg.Pool({ connectionString: process.env.ALPHA_DATABASE_URL, max: 8 });
const mailer = new ResendMailTransport({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.ALPHA_EMAIL_FROM
});

try {
  await pool.query('SELECT 1 FROM alpha_accounts LIMIT 1');
  await pool.query('SELECT 1 FROM alpha_wallet_bindings LIMIT 1');
  await pool.query('SELECT ring_id FROM alpha_starter_cooper LIMIT 1');
  await pool.query('SELECT ring_id FROM alpha_admin_cooper_rings LIMIT 1');
  await pool.query('SELECT ring_id FROM alpha_cooper_current_state LIMIT 1');
  await pool.query('SELECT id FROM alpha_cooper_point_allocations LIMIT 1');
  await pool.query('SELECT id FROM alpha_cooper_level_up_operations LIMIT 1');
  await pool.query('SELECT ring_kind, ring_id FROM alpha_ring_selection LIMIT 1');
  await pool.query('SELECT id FROM alpha_ring_equipment_operations LIMIT 1');
  await pool.query('SELECT id FROM alpha_ring_equipment_events LIMIT 1');
  await pool.query('SELECT is_admin FROM alpha_accounts LIMIT 1');
  await pool.query('SELECT id FROM alpha_ert_admin_credits LIMIT 1');
  const sendFlag = process.env.ALPHA_ERU_SEND_ENABLED ?? 'false';
  if (!['true', 'false'].includes(sendFlag))
    throw new Error('Invalid canonical ERU Send flag');
  if (sendFlag === 'true' && (process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet' ||
      !process.env.ALPHA_ERU_PROOF_RPC_URL))
    throw new Error('Canonical ERU Send requires pinned Devnet RPC');
  const eruDeployment = {
    gatewayProgramId: process.env.ALPHA_COOPER_ERU_GATEWAY_PROGRAM_ID,
    hookProgramId: process.env.ALPHA_COOPER_ERU_HOOK_PROGRAM_ID,
    mintAddress: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
    reserveAddress: process.env.ALPHA_COOPER_ERU_RESERVE_ADDRESS,
    treasuryAddress: process.env.ALPHA_COOPER_ERU_TREASURY_ADDRESS,
    vaultAddress: process.env.ALPHA_COOPER_ERU_VAULT_ADDRESS,
    attestorAddress: process.env.ALPHA_COOPER_ERU_ATTESTOR_ADDRESS,
    configEpoch: Number(process.env.ALPHA_COOPER_ERU_CONFIG_EPOCH),
  };
  const eru = sendFlag === 'true' ? createCanonicalEruSend({ pool,
    rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
    walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT,
    deployment: eruDeployment }) : null;
  if (eru) await pool.query('SELECT intent_namespace FROM alpha_eru_intents LIMIT 1');
  const silverProgram = process.env.ALPHA_SILVER_PROGRAM_ID;
  const walletReadMode = readRouteMode(process.env.ALPHA_WALLET_READ_RPC_MODE);
  const marketListReadMode = readRouteMode(process.env.ALPHA_MARKET_LIST_READ_RPC_MODE);
  const alternativeReadNeeded = walletReadMode !== 'primary' ||
    marketListReadMode !== 'primary';
  const readScope = alternativeReadNeeded ? createReadOnlyRpcScope() : null;
  const readRpc = url => createScopedReadRpc(url, readScope, createSolanaRpc);
  const alternativeReadUrl = process.env.ALPHA_ASSET_READ_RPC_URL;
  if (alternativeReadNeeded) {
    let valid = false;
    try {
      const parsed = new URL(alternativeReadUrl);
      valid = parsed.protocol === 'https:' && !!parsed.hostname &&
        !parsed.username && !parsed.password;
    } catch { /* Reject without echoing the credential-bearing URL. */ }
    if (!valid || process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet')
      throw new Error('Independent asset reads require a private Devnet HTTPS RPC');
  }
  const silverChain = silverProgram && process.env.ALPHA_ERU_PROOF_RPC_URL
    ? createSilverChainReader(process.env.ALPHA_ERU_PROOF_RPC_URL) : null;
  const primaryReadChain = alternativeReadNeeded && silverProgram
    ? createSilverChainReader(process.env.ALPHA_ERU_PROOF_RPC_URL,
      { propagateTransientReadErrors: true,
        rpc: readRpc(process.env.ALPHA_ERU_PROOF_RPC_URL) }) : null;
  const alternativeSilverChain = alternativeReadNeeded && silverProgram
    ? createSilverChainReader(alternativeReadUrl,
      { propagateTransientReadErrors: true, rpc: readRpc(alternativeReadUrl) }) : null;
  const marketProgram = process.env.ALPHA_MARKETPLACE_PROGRAM_ID;
  if (marketplaceFlag === 'true' && !marketProgram)
    throw new Error('Enabled Marketplace requires canonical program identity');
  if (marketplaceFlag === 'true' && !process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL)
    throw new Error('Enabled Marketplace requires separate private discovery RPC');
  if (marketProgram && (marketProgram !== 'BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j' ||
      silverProgram !== '3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX' ||
      process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet'))
    throw new Error('Marketplace requires canonical Devnet M/S identities');
  const marketplaceReader = marketProgram ? createSilverMarketplaceReader({
    rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
    discoveryRpcUrl: process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL,
    marketProgramId: marketProgram, silverProgramId: silverProgram }) : null;
  let silverCollectionId = null;
  const silver = silverProgram ? await (async () => {
    if (process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet' ||
        !process.env.ALPHA_ERU_PROOF_RPC_URL) {
      throw new Error('Silver requires separate Devnet RPC configuration');
    }
    await pool.query('SELECT status, confirmation_slot FROM alpha_silver_first_entry LIMIT 1');
    const [collectionId] = await getProgramDerivedAddress({
      programAddress: address(silverProgram),
      seeds: [new TextEncoder().encode('silver-collection')],
    });
    silverCollectionId = collectionId;
    return createSilverFirstEntry({ pool,
      chain: silverChain,
      cluster: 'devnet', programId: silverProgram, collectionId,
      walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT,
      openingProjectionEnabled: process.env.ALPHA_SILVER_OPENING_SUBMIT_ENABLED === 'true',
      drawInventoryEnabled: drawFlag,
      breedingInventoryEnabled: breedingFlag === 'true' });
  })() : null;
  const silverOpening = silver && process.env.ALPHA_SILVER_OPENING_PREFLIGHT_ENABLED === 'true'
    ? createSilverOpeningPreflight({ pool, silver,
    chain: silverChain, cluster: 'devnet', programId: silverProgram,
    walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT,
    signingEnabled: process.env.ALPHA_SILVER_OPENING_SUBMIT_ENABLED === 'true' }) : null;
  let silverCandidateIntent = null;
  if (silverOpening) {
    await pool.query('SELECT cluster FROM alpha_silver_opening_candidate_intents LIMIT 1');
    if (process.env.ALPHA_SILVER_OPENING_SUBMIT_ENABLED === 'true')
      await pool.query('SELECT status FROM alpha_silver_opening_submissions LIMIT 1');
    silverCandidateIntent = createSilverOpeningCandidateIntent({ pool, preflight: silverOpening,
      chain: silverChain, programId: silverProgram, cluster: 'devnet',
      expectedGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      signingEnabled: process.env.ALPHA_SILVER_OPENING_SUBMIT_ENABLED === 'true' });
  }
  const wallet = createWalletBinding({ pool, environment: process.env.ALPHA_WALLET_ENVIRONMENT });
  const starterCooper = createStarterCooper({ pool,
    walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT });
  const equipment = silver ? createRingEquipment({ pool, chain: silverChain,
    marketReader: marketplaceReader, programId: silverProgram, cluster: 'devnet',
    walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT }) : null;
  let m2eStepSync = null;
  let m2eConfig = null;
  if (m2eStepSyncFlag === 'true') {
    m2eConfig = createM2eBalanceConfig();
    if (!silver || !silverChain || !equipment)
      throw new Error('Alpha M2E step-sync requires Devnet Silver and Equip');
    await pool.query('SELECT id FROM alpha_m2e_daily_snapshots LIMIT 1');
    await pool.query('SELECT id FROM alpha_m2e_batches LIMIT 1');
    m2eStepSync = createM2eStepSync({ pool, chain: silverChain,
      marketReader: marketplaceReader, programId: silverProgram, cluster: 'devnet',
      walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT, config: m2eConfig });
  }
  const starterEnabled = process.env.ALPHA_SILVER_STARTER_ENABLED === 'true';
  let silverIssuer = null;
  let drawBoxIssuer = null;
  let adminBoxGrant = null;
  let drawEruIssuer = null;
  let silverProgressionSigner = null;
  if (starterEnabled) {
    if (!silver || process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet')
      throw new Error('Silver starter requires isolated Devnet Silver runtime');
    await pool.query('SELECT signature FROM alpha_silver_issuance_attempts LIMIT 1');
    silverProgressionSigner = createSilverIssuerChain({ rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
        programId: silverProgram,
        issuerKeyPath: process.env.ALPHA_SILVER_ISSUER_KEY_PATH,
        expectedProgramSha256: process.env.ALPHA_SILVER_PROGRAM_SHA256,
        expectedProgramSize: Number(process.env.ALPHA_SILVER_PROGRAM_SIZE),
        progressionPool: pool, progressionReader: silverChain,
        marketReader: marketplaceReader });
    silverIssuer = createSilverIssuer({ pool, reader: silverChain, programId: silverProgram,
      chain: silverProgressionSigner });
    if (drawFlag === 'true')
      drawBoxIssuer = createDrawBoxIssuer({ pool, reader: silverChain,
        programId: silverProgram, chain: silverProgressionSigner });
  }
  let assets = silver && process.env.ALPHA_ERU_PROOF_CLUSTER === 'devnet' &&
    process.env.ALPHA_COOPER_ERU_MINT_ADDRESS
    ? createWalletAssets({ wallet, silver, rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
      mint: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
      environment: process.env.ALPHA_WALLET_ENVIRONMENT }) : null;
  const auth = createAuth({ pool, mailer, codeSecret: process.env.ALPHA_CODE_SECRET,
    onVerified: starterCooper.ensureForAccount });
  if (walletReadMode !== 'primary') {
    if (!assets || !alternativeSilverChain) throw new Error('Wallet read route unavailable');
    const readSilver = chain => createSilverFirstEntry({ pool, chain,
      cluster: 'devnet', programId: silverProgram, collectionId: silverCollectionId,
      walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT,
      openingProjectionEnabled: process.env.ALPHA_SILVER_OPENING_SUBMIT_ENABLED === 'true',
      drawInventoryEnabled: drawFlag,
      breedingInventoryEnabled: breedingFlag === 'true' });
    const primaryReadAssets = createWalletAssets({ wallet, silver: readSilver(primaryReadChain),
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
      rpc: readRpc(process.env.ALPHA_ERU_PROOF_RPC_URL),
      mint: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
      environment: process.env.ALPHA_WALLET_ENVIRONMENT });
    const alternativeAssets = createWalletAssets({ wallet,
      silver: readSilver(alternativeSilverChain),
      rpcUrl: alternativeReadUrl, mint: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
      rpc: readRpc(alternativeReadUrl),
      environment: process.env.ALPHA_WALLET_ENVIRONMENT });
    assets = { read: createReadOnlyRpcRoute({
      primary: token => primaryReadAssets.read(token),
      alternative: token => alternativeAssets.read(token), mode: walletReadMode,
      scope: readScope,
    }) };
  }
  if (process.env.ALPHA_ADMIN_BOX_ENABLED === 'true') {
    if (!silverProgressionSigner || !silverChain)
      throw new Error('Admin Box requires canonical Silver issuer');
    await pool.query('SELECT id FROM alpha_admin_box_grants LIMIT 1');
    await pool.query('SELECT grant_id FROM alpha_admin_box_attempts LIMIT 1');
    adminBoxGrant = createAdminBoxGrant({ pool, auth, chain: silverProgressionSigner,
      reader: silverChain, programId: silverProgram });
  }
  let marketplace = null;
  if (marketplaceReader) {
    const marketEnabled = marketplaceFlag === 'true';
    if (marketEnabled) await pool.query(
      'SELECT signature FROM alpha_silver_marketplace_submissions LIMIT 1');
    marketplace = createSilverMarketplaceHttp({ auth, reader: marketplaceReader,
      silverReader: silverChain, silverProgramId: silverProgram,
      flow: marketEnabled ? createSilverMarketplaceFlow({ pool, auth,
        marketReader: marketplaceReader, silverReader: silverChain, equipment,
        marketProgramId: marketProgram, silverProgramId: silverProgram }) : null });
    if (marketListReadMode !== 'primary') {
      if (!alternativeSilverChain) throw new Error('Marketplace read route unavailable');
      const primaryReadReader = createSilverMarketplaceReader({
        rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
        discoveryRpcUrl: process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL,
        marketProgramId: marketProgram, silverProgramId: silverProgram,
        rpc: readRpc(process.env.ALPHA_ERU_PROOF_RPC_URL),
        discoveryRpc: readRpc(process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL) });
      const primaryReadMarket = createSilverMarketplaceHttp({ auth, reader: primaryReadReader,
        silverReader: primaryReadChain, silverProgramId: silverProgram });
      const alternativeReader = createSilverMarketplaceReader({
        rpcUrl: alternativeReadUrl,
        discoveryRpcUrl: process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL,
        marketProgramId: marketProgram, silverProgramId: silverProgram,
        rpc: readRpc(alternativeReadUrl),
        discoveryRpc: readRpc(process.env.ALPHA_MARKETPLACE_DISCOVERY_RPC_URL) });
      const alternativeMarket = createSilverMarketplaceHttp({ auth, reader: alternativeReader,
        silverReader: alternativeSilverChain, silverProgramId: silverProgram });
      const primaryMarket = marketplace;
      marketplace = { ...primaryMarket,
        listings: createReadOnlyRpcRoute({ primary: token => primaryReadMarket.listings(token),
          alternative: token => alternativeMarket.listings(token), mode: marketListReadMode,
          scope: readScope }),
      };
    }
  }
  if (marketListReadMode !== 'primary' && !marketplaceReader)
    throw new Error('Marketplace read route unavailable');
  const silverDirectTransfer = silverChain && silverProgram && equipment &&
    process.env.ALPHA_ERU_PROOF_CLUSTER === 'devnet' &&
    process.env.ALPHA_SILVER_DIRECT_TRANSFER_ENABLED === 'true' ?
    createSilverDirectTransferFlow({ pool, auth, silverReader: silverChain,
      equipment, silverProgramId: silverProgram,
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL }) : null;
  if (silverDirectTransfer) await pool.query(
    'SELECT signature FROM alpha_silver_direct_transfer_submissions LIMIT 1');
  let draw = null;
  let drawEruChain = null;
  if (drawFlag === 'true') {
    if (!silver || !silverChain || !starterEnabled || cooperEruFlag !== 'true')
      throw new Error('Alpha Draw requires canonical Devnet Silver and ERU runtime');
    for (const table of ['alpha_draw_configurations', 'alpha_draw_configuration_rewards',
      'alpha_draw_operations', 'alpha_draw_results', 'alpha_draw_cooper_rings',
      'alpha_draw_fulfillments'])
      await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
    draw = createAlphaDraw({ pool, auth,
      walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT });
    drawEruChain = createDrawEruChain({
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
      attestorKeyPath: process.env.ALPHA_DRAW_ERU_ATTESTOR_KEY_PATH,
      adminAttestorKeyPath: process.env.ALPHA_ADMIN_ERU_ENABLED === 'true' ?
        process.env.ALPHA_ADMIN_ERU_ATTESTOR_KEY_PATH : null,
      expectedProgramSha256: process.env.ALPHA_DRAW_DISTRIBUTOR_SHA256,
      expectedProgramSize: Number(process.env.ALPHA_DRAW_DISTRIBUTOR_SIZE),
      mint: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
      reserve: process.env.ALPHA_COOPER_ERU_RESERVE_ADDRESS,
      gatewayProgramId: process.env.ALPHA_COOPER_ERU_GATEWAY_PROGRAM_ID,
      hook: process.env.ALPHA_COOPER_ERU_HOOK_PROGRAM_ID,
    });
    await drawEruChain.verifyPinnedProgram();
    drawEruIssuer = createDrawEruIssuer({ pool, chain: drawEruChain });
  }
  let adminEruTransfer = null;
  if (process.env.ALPHA_ADMIN_ERU_ENABLED === 'true') {
    if (!drawEruChain) throw new Error('Admin ERU requires active canonical Draw reserve path');
    await pool.query('SELECT id FROM alpha_admin_eru_transfers LIMIT 1');
    await pool.query('SELECT transfer_id FROM alpha_admin_eru_attempts LIMIT 1');
    await drawEruChain.adminRemaining();
    adminEruTransfer = createAdminEruTransfer({ pool, auth, chain: drawEruChain });
  }
  let adminCooperGrant = null;
  if (process.env.ALPHA_ADMIN_COOPER_ENABLED === 'true') {
    const constraint = (await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname =
      'alpha_admin_cooper_rings_issuance_reason_check'`)).rows[0];
    if (!constraint?.definition?.includes('admin-grant'))
      throw new Error('Repeatable admin Cooper migration unavailable');
    adminCooperGrant = createAdminCooperGrant({ pool, auth });
  }
  const cooperLevelUp = createCooperLevelUp({ pool, auth,
    eruEnabled: cooperEruFlag === 'true' });
  let cooperEru = null;
  let cooperBreeding = null;
  let cooperBreedingFlow = null;
  if (cooperEruFlag === 'true') {
    if (process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet' ||
        !process.env.ALPHA_ERU_PROOF_RPC_URL)
      throw new Error('Cooper ERU requires pinned Devnet RPC');
    for (const table of ['alpha_cooper_level_eru_preparations',
      'alpha_cooper_level_eru_issuances', 'alpha_cooper_level_eru_submissions',
      'alpha_cooper_level_eru_settlements'])
      await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
    const chain = createCooperEruChainReader({
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL, cluster: 'devnet' });
    const genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const deployment = {
      gatewayProgramId: process.env.ALPHA_COOPER_ERU_GATEWAY_PROGRAM_ID,
      hookProgramId: process.env.ALPHA_COOPER_ERU_HOOK_PROGRAM_ID,
      mintAddress: process.env.ALPHA_COOPER_ERU_MINT_ADDRESS,
      reserveAddress: process.env.ALPHA_COOPER_ERU_RESERVE_ADDRESS,
      treasuryAddress: process.env.ALPHA_COOPER_ERU_TREASURY_ADDRESS,
      vaultAddress: process.env.ALPHA_COOPER_ERU_VAULT_ADDRESS,
      attestorAddress: process.env.ALPHA_COOPER_ERU_ATTESTOR_ADDRESS,
      configEpoch: Number(process.env.ALPHA_COOPER_ERU_CONFIG_EPOCH),
    };
    const verifiedDeployment = await verifyCooperEruDevnetConfig({ chain, ...deployment });
    const candidateReader = createCooperEruCandidateReader({ pool, chain,
      cluster: 'devnet', expectedGenesisHash: genesisHash,
      gatewayProgramId: deployment.gatewayProgramId,
      expectedConfigStaticSha256: verifiedDeployment.configStaticSha256 });
    const issuance = createCooperEruUnsignedIssuance({ pool, candidateReader,
      cluster: 'devnet' });
    const attestation = createCooperEruDevnetAttestation({ pool, issuance, candidateReader,
      attestorKeyPath: process.env.ALPHA_COOPER_ERU_ATTESTOR_KEY_PATH,
      expectedAttestorAddress: deployment.attestorAddress });
    const finalityReader = createCooperEruFinalityReader({ pool,
      chain: createCooperEruFinalityChainReader({
        rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL, cluster: 'devnet' }),
      cluster: 'devnet', expectedGenesisHash: genesisHash });
    const reconciliation = createCooperEruReconciliation({ pool, finalityReader,
      cluster: 'devnet' });
    cooperEru = createCooperEruHttp({ auth, levelUp: cooperLevelUp,
      flow: createCooperEruUserFlow({ attestation, reconciliation, chain }) });
    if (breedingFlag === 'true') {
      if (!silver || !silverChain || !silverProgram)
        throw new Error('Cooper breeding requires canonical Silver Devnet runtime');
      for (const table of ['alpha_cooper_breeding_operations',
        'alpha_cooper_breeding_parent_holds', 'alpha_cooper_breeding_issuances',
        'alpha_cooper_breeding_submissions', 'alpha_cooper_breeding_settlements'])
        await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
      const breeding = createCooperBreeding({ pool, auth });
      const breedingCandidate = createCooperBreedingCandidateReader({ pool, chain,
        gatewayProgramId: deployment.gatewayProgramId,
        expectedConfigStaticSha256: verifiedDeployment.configStaticSha256 });
      const breedingIssuance = createCooperBreedingIssuance({ pool,
        candidateReader: breedingCandidate });
      const breedingAttestation = createCooperBreedingDevnetAttestation({ pool,
        issuance: breedingIssuance, candidateReader: breedingCandidate,
        attestorKeyPath: process.env.ALPHA_COOPER_ERU_ATTESTOR_KEY_PATH,
        expectedAttestorAddress: deployment.attestorAddress });
      const breedingFinality = createCooperBreedingFinalityReader({ pool,
        chain: createCooperEruFinalityChainReader({
          rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL, cluster: 'devnet' }),
        silverChain, silverProgramId: silverProgram });
      const breedingReconciliation = createCooperBreedingReconciliation({ pool,
        finalityReader: breedingFinality });
      cooperBreedingFlow = createCooperBreedingUserFlow({
        attestation: breedingAttestation, reconciliation: breedingReconciliation, chain });
      cooperBreeding = createCooperBreedingHttp({ auth, breeding,
        flow: cooperBreedingFlow });
    }
  }
  if (breedingFlag === 'true' && !cooperEru)
    throw new Error('Cooper breeding requires canonical Cooper ERU runtime');
  let silverProgression = null;
  let silverProgressionFlow = null;
  let silverAllocation = null;
  if (silverProgressionFlag === 'true') {
    if (!starterEnabled || !silverProgressionSigner || !silverChain ||
        cooperEruFlag !== 'true' ||
        process.env.ALPHA_ERU_PROOF_CLUSTER !== 'devnet')
      throw new Error('Silver progression requires canonical Devnet issuer and reader');
    await pool.query(`SELECT id, eru_principal, eru_fee
      FROM alpha_silver_progression_operations LIMIT 1`);
    await pool.query(`SELECT signature, gateway_config_base64
      FROM alpha_silver_progression_submissions LIMIT 1`);
    await pool.query('SELECT operation_id FROM alpha_silver_progression_settlements LIMIT 1');
    await pool.query('SELECT signature FROM alpha_silver_allocation_submissions LIMIT 1');
    const progression = createSilverProgression({ pool, auth,
      chain: silverChain, marketReader: marketplaceReader, programId: silverProgram });
    const finalityChain = createCooperEruFinalityChainReader({
      rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL, cluster: 'devnet' });
    const finality = createSilverProgressionFinality({ pool,
      chain: finalityChain,
      programId: silverProgram, issuerAddress: silverProgressionSigner.issuerAddress });
    silverProgressionFlow = createSilverProgressionFlow({ pool,
      signer: silverProgressionSigner, finality, programId: silverProgram });
    silverProgression = createSilverProgressionHttp({ auth, progression,
      flow: silverProgressionFlow });
    silverAllocation = createSilverAllocation({ pool, auth, reader: silverChain,
      marketReader: marketplaceReader,
      signer: silverProgressionSigner, finalityChain, programId: silverProgram });
  }
  const server = createAlphaServer(
    auth,
    wallet, eru, silver, silverOpening, silverCandidateIntent, assets, starterCooper,
    undefined, equipment, m2eStepSync,
    m2eStepSync ? createM2eProfile({ pool, auth, config: m2eConfig,
      resolveEligibleRingCount: async accountId => {
        return resolveM2eDisplayRingCount({ client: pool, accountId,
          walletEnvironment: process.env.ALPHA_WALLET_ENVIRONMENT,
          chain: silverChain, marketReader: marketplaceReader,
          programId: silverProgram, cluster: 'devnet' });
      } }) : null,
    createAdminErtCredit({ pool, auth }),
    createCooperPointAllocation({ pool, auth }),
    cooperLevelUp, cooperEru, silverProgression, silverAllocation, draw,
    undefined, cooperBreeding, marketplace, silverDirectTransfer,
    sendFlag === 'true' ? createAdminOperationalStats({ pool, auth,
      chain: createCooperEruChainReader({ rpcUrl: process.env.ALPHA_ERU_PROOF_RPC_URL,
        cluster: 'devnet' }), deployment: eruDeployment }) : null,
    adminEruTransfer,
    createAdminDashboard({ pool, auth, adminEruEnabled: Boolean(adminEruTransfer),
      adminBoxEnabled: Boolean(adminBoxGrant),
      adminCooperEnabled: Boolean(adminCooperGrant) }),
    adminCooperGrant, adminBoxGrant
  );
  server.listen(port, listenHost);
  if (adminEruTransfer) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await adminEruTransfer.tick(); }
      catch (error) { console.error('Admin ERU tick failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (adminBoxGrant) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await adminBoxGrant.tick(); }
      catch (error) { console.error('Admin Box grant tick failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (silverIssuer) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await silverIssuer.tick(); }
      catch (error) { console.error('Silver starter tick failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (drawBoxIssuer) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await drawBoxIssuer.tick(); }
      catch (error) { console.error('Draw Box issuance failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (drawEruIssuer) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await drawEruIssuer.tick(); }
      catch (error) { console.error('Draw ERU settlement failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (silverProgressionFlow) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const pending = (await pool.query(`SELECT p.account_id, p.id
          FROM alpha_silver_progression_operations p
          WHERE p.status = 'prepared' AND EXISTS (
            SELECT 1 FROM alpha_silver_progression_submissions s
            WHERE s.operation_id = p.id)
          ORDER BY p.created_at LIMIT 10`)).rows;
        for (const row of pending) {
          try { await silverProgressionFlow.status(row.account_id, row.id); }
          catch (error) { console.error('Silver progression reconciliation failed',
            error.code ?? error.name); }
        }
      } catch (error) { console.error('Silver progression scan failed', error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  if (cooperBreedingFlow) {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const pending = (await pool.query(`SELECT o.account_id, o.id
          FROM alpha_cooper_breeding_operations o
          WHERE NOT EXISTS (SELECT 1 FROM alpha_cooper_breeding_settlements x
            WHERE x.operation_id = o.id)
            AND EXISTS (SELECT 1 FROM alpha_cooper_breeding_submissions s
              WHERE s.operation_id = o.id)
          ORDER BY o.created_at LIMIT 10`)).rows;
        for (const row of pending) {
          try { await cooperBreedingFlow.status(row.account_id, row.id); }
          catch (error) { console.error('Cooper breeding reconciliation failed',
            error.code ?? error.name); }
        }
      } catch (error) { console.error('Cooper breeding scan failed',
        error.code ?? error.name); }
      finally { inFlight = false; }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref();
    void tick();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => pool.end()));
  }
} catch (error) {
  await pool.end();
  throw new Error('Alpha service startup failed', { cause: error.code });
}
