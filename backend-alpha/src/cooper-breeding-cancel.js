// Operator-only cancellation of one expired, unsubmitted Cooper breeding intent.
// Run inside the public API container with explicit operation/account/DB guard.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { postJsonRpc } from './json-rpc.js';
import { readPreparedCooperBreeding } from './cooper-breeding-candidate-reader.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SYSTEM = '11111111111111111111111111111111';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = () => { throw new Error('Cooper breeding cancellation precondition failed'); };
const { ALPHA_DATABASE_URL: databaseUrl, ALPHA_ERU_PROOF_RPC_URL: rpcUrl,
  ALPHA_COOPER_ERU_GATEWAY_PROGRAM_ID: gatewayId,
  ALPHA_CANCEL_EXPECTED_DATABASE: expectedDb,
  ALPHA_CANCEL_ACCOUNT_ID: accountId, ALPHA_CANCEL_OPERATION_ID: operationId,
  ALPHA_CANCEL_REASON: reason } = process.env;

if (!databaseUrl || !expectedDb || !UUID.test(accountId ?? '') ||
    !UUID.test(operationId ?? '') || !reason || reason.length > 512 ||
    !rpcUrl || !gatewayId) fail();
let endpoint;
try { endpoint = new URL(rpcUrl); } catch { fail(); }
if (endpoint.protocol !== 'https:' ||
    endpoint.hostname !== 'solana-devnet.g.alchemy.com') fail();
const gateway = address(gatewayId);
const rpc = (method, params = []) => postJsonRpc({ url: rpcUrl, method, params,
  id: `cooper-cancel-${method}`, label: 'Cooper cancellation Devnet' });
const raw = value => getAddressEncoder().encode(address(value));
const pda = async (...seeds) => (await getProgramDerivedAddress({
  programAddress: gateway, seeds,
}))[0];

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  if ((await client.query('SELECT current_database() AS name')).rows[0].name !== expectedDb)
    fail();
  await client.query('BEGIN');
  const account = (await client.query(`SELECT id FROM alpha_accounts
    WHERE id = $1 AND verified_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
  if (!account) fail();
  const row = await readPreparedCooperBreeding(client, accountId, operationId);
  const binding = (await client.query(`SELECT * FROM alpha_cooper_breeding_issuances
    WHERE operation_id = $1 AND account_id = $2 FOR UPDATE`,
  [operationId, accountId])).rows[0];
  if (!binding || binding.reservation_id !== row.reservation_id ||
      binding.wallet_address !== row.wallet_address ||
      binding.gateway_program_id !== gateway || binding.genesis_hash !== GENESIS ||
      (await client.query(`SELECT 1 FROM alpha_cooper_breeding_submissions
        WHERE operation_id = $1`, [operationId])).rowCount ||
      (await client.query(`SELECT 1 FROM alpha_cooper_breeding_settlements
        WHERE operation_id = $1`, [operationId])).rowCount) fail();

  const config = await pda(new TextEncoder().encode('eru-config'));
  const replay = await pda(new TextEncoder().encode('cooper-breeding'),
    raw(config), raw(row.wallet_address),
    Buffer.from(operationId.replaceAll('-', ''), 'hex'));
  const [genesis, finalizedSlot, observed] = await Promise.all([
    rpc('getGenesisHash'), rpc('getSlot', [{ commitment: 'finalized' }]),
    rpc('getAccountInfo', [replay, { commitment: 'finalized', encoding: 'base64' }]),
  ]);
  if (genesis !== GENESIS || !Number.isSafeInteger(finalizedSlot) ||
      finalizedSlot <= Number(binding.expiry_slot) ||
      (observed?.value && (observed.value.owner !== SYSTEM ||
        observed.value.data?.[0] !== ''))) fail();

  const digest = createHash('sha256').update(JSON.stringify({
    operationId, accountId, reservationId: row.reservation_id,
    walletAddress: row.wallet_address, gatewayProgramId: gateway,
    expirySlot: String(binding.expiry_slot), finalizedSlot,
    replayAddress: replay, replayState: 'uninitialized', genesis,
    reason,
  })).digest('hex');
  await client.query(`INSERT INTO alpha_cooper_breeding_cancellations
    (operation_id, account_id, reservation_id, replay_address,
      finalized_slot, evidence_digest, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [operationId, accountId, row.reservation_id, replay, finalizedSlot, digest, reason]);
  const reservation = await client.query(`UPDATE alpha_ert_reservations
    SET state = 'released', release_evidence_digest = $2
    WHERE id = $1 AND state = 'held'`, [row.reservation_id, digest]);
  const holds = await client.query(`UPDATE alpha_cooper_breeding_parent_holds
    SET released_at = now() WHERE operation_id = $1 AND account_id = $2
      AND released_at IS NULL`, [operationId, accountId]);
  const hybrid = await client.query(`UPDATE alpha_hybrid_operations
    SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
  [row.hybrid_operation_id]);
  const outbox = await client.query(`UPDATE alpha_hybrid_outbox
    SET state = 'done' WHERE operation_id = $1 AND state = 'pending'`,
  [row.hybrid_operation_id]);
  if (reservation.rowCount !== 1 || holds.rowCount !== 2 ||
      hybrid.rowCount !== 1 || outbox.rowCount !== 1) fail();
  await client.query('COMMIT');
  console.log(JSON.stringify({ operationId, status: 'cancelled',
    ertReleased: row.ert_cost, parentsReleased: holds.rowCount,
    finalizedSlot, evidenceDigest: digest }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
