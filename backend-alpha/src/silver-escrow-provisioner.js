import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { drawBoxIdentity } from './draw-box-identity.js';
import { breedingBoxIdentity } from './cooper-breeding.js';
import { adminBoxIdentity } from './admin-box-identity.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const READY_RECHECK_MS = 5 * 60_000;
const MAX_READY_CACHE = 10_000;

export function createSilverEscrowProvisioner({ pool, chain, reader, programId,
  breedingEnabled = false, now = () => performance.now() }) {
  if (!pool || typeof chain?.provisionEscrow !== 'function' ||
      typeof reader?.readFinalized !== 'function' || typeof reader?.readEscrow !== 'function' ||
      !programId) throw new Error('Silver escrow provisioner configuration missing');

  let offset = 0;
  const readyCache = new Map();
  return {
    async tick() {
      const rows = (await pool.query(`SELECT issued.* FROM (
        SELECT e.account_id, e.wallet_address,
          e.issuance_id::text, e.entitlement_digest::text, e.mint_address,
          e.finalized_signature, NULL::uuid AS draw_result_id,
          'first-entry'::text AS issuance_source, e.confirmed_at AS issued_at,
          NULL::uuid AS breeding_operation_id, NULL::uuid AS first_ring_id,
          NULL::uuid AS second_ring_id, NULL::integer AS first_uses,
          NULL::integer AS second_uses, NULL::uuid AS admin_operation_id
        FROM alpha_silver_first_entry e
        JOIN alpha_accounts a ON a.id = e.account_id AND a.verified_at IS NOT NULL
        JOIN alpha_wallet_bindings b ON b.account_id = e.account_id
          AND b.wallet_address = e.wallet_address
        WHERE e.cluster = 'devnet' AND e.status = 'confirmed'
        UNION ALL
        SELECT r.account_id, o.wallet_address, NULL::text, NULL::text,
          f.chain_asset_address, f.chain_signature, r.id, 'draw', r.created_at,
          NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer,
          NULL::uuid
        FROM alpha_draw_results r
        JOIN alpha_draw_operations o ON o.id = r.operation_id
        JOIN alpha_draw_fulfillments f ON f.result_id = r.id
        JOIN alpha_accounts a ON a.id = r.account_id AND a.verified_at IS NOT NULL
        JOIN alpha_wallet_bindings b ON b.account_id = r.account_id
          AND b.wallet_address = o.wallet_address
        JOIN alpha_ert_ledger l ON l.account_id = r.account_id
          AND l.event_key = 'draw-entry:' || o.id::text AND l.amount = -5
        WHERE r.selected_reward_type = 'SILVER_BOX' AND f.state = 'CONFIRMED'
        ${breedingEnabled ? `UNION ALL
        SELECT o.account_id, o.wallet_address, o.issuance_id::text,
          o.entitlement_digest::text, s.box_mint, s.signature, NULL::uuid,
          'cooper-breeding', s.settled_at, o.id, o.first_ring_id,
          o.second_ring_id, o.first_uses, o.second_uses, NULL::uuid
        FROM alpha_cooper_breeding_operations o
        JOIN alpha_cooper_breeding_settlements s ON s.operation_id = o.id
        JOIN alpha_accounts a ON a.id = o.account_id AND a.verified_at IS NOT NULL
        JOIN alpha_wallet_bindings b ON b.account_id = o.account_id
          AND b.wallet_address = o.wallet_address
        WHERE o.cluster = 'devnet'` : ''}
        UNION ALL
        SELECT g.account_id, g.wallet_address, g.issuance_id::text,
          g.entitlement_digest::text, g.mint_address, g.confirmed_signature,
          NULL::uuid, 'admin-grant', g.settled_at,
          NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer,
          g.id
        FROM alpha_admin_box_grants g
        JOIN alpha_accounts a ON a.id = g.account_id AND a.verified_at IS NOT NULL
        JOIN alpha_wallet_bindings b ON b.account_id = g.account_id
          AND b.wallet_address = g.wallet_address
        WHERE g.state = 'CONFIRMED'
        ) issued
        -- A confirmed opening has consumed its Box; no escrow can be provisioned again.
        WHERE NOT EXISTS (SELECT 1 FROM alpha_silver_opening_finalizations f
          WHERE f.cluster = 'devnet' AND f.genesis_hash = $3 AND f.program_id = $2
            AND f.mint_address = issued.mint_address
            AND f.account_id = issued.account_id
            AND f.wallet_address = issued.wallet_address
            AND f.status = 'confirmed')
        ORDER BY issued.issued_at DESC, issued.mint_address LIMIT 20 OFFSET $1`,
      [offset, programId, DEVNET_GENESIS])).rows;
      const result = { ready: 0, sent: 0, skipped: 0 };
      for (const row of rows) {
        const fingerprint = JSON.stringify([row.account_id, row.wallet_address,
          row.issuance_id, row.entitlement_digest, row.mint_address,
          row.finalized_signature, row.issuance_source, row.issued_at,
          row.draw_result_id, row.breeding_operation_id, row.first_ring_id,
          row.second_ring_id, row.first_uses, row.second_uses,
          row.admin_operation_id]);
        // Only a finalized ready escrow is cached. Asset actions still verify chain state.
        const cached = readyCache.get(row.mint_address);
        const cacheAge = cached && now() - cached.checkedAt;
        if (cached?.fingerprint === fingerprint &&
            cacheAge >= 0 && cacheAge < READY_RECHECK_MS) {
          result.ready++;
          continue;
        }
        readyCache.delete(row.mint_address);
        const identity = row.issuance_source === 'admin-grant'
          ? adminBoxIdentity(row.account_id, row.wallet_address,
            row.admin_operation_id)
          : row.issuance_source === 'cooper-breeding'
          ? breedingBoxIdentity(row.account_id, row.wallet_address,
            row.breeding_operation_id, row.first_ring_id, row.second_ring_id,
            row.first_uses, row.second_uses)
          : row.issuance_source === 'draw'
          ? drawBoxIdentity(row.account_id, row.wallet_address, row.draw_result_id)
          : { issuanceId: row.issuance_id, entitlementDigest: row.entitlement_digest };
        const box = await reader.readFinalized({ programId, cluster: 'devnet',
          issuanceId: identity.issuanceId, walletAddress: row.wallet_address,
          expectedFinalizedSignature: row.finalized_signature,
          expectedIssuanceSource: row.issuance_source ?? 'first-entry',
          expectedDrawResultId: row.draw_result_id ?? null,
          expectedAdminOperationId: row.admin_operation_id ?? null,
          expectedBreeding: row.issuance_source === 'cooper-breeding' ? {
            operationId: row.breeding_operation_id,
            firstRingId: row.first_ring_id, secondRingId: row.second_ring_id,
            firstUses: row.first_uses, secondUses: row.second_uses,
          } : null });
        if (!box || !box.finalized || box.programId !== programId ||
            box.cluster !== 'devnet' || box.kind !== 'SILVER_BOX' ||
            box.lifecycle !== 'SEALED' || box.accountId !== row.account_id ||
            box.issuanceId !== identity.issuanceId ||
            box.entitlementDigest !== identity.entitlementDigest ||
            (row.issuance_source === 'draw' &&
              (box.issuanceSource !== 'draw' || box.drawResultId !== row.draw_result_id)) ||
            (row.issuance_source === 'admin-grant' &&
              (box.issuanceSource !== 'admin-grant' ||
                box.adminOperationId !== row.admin_operation_id)) ||
            (row.issuance_source === 'cooper-breeding' &&
              (box.issuanceSource !== 'cooper-breeding' ||
                box.breedingOperationId !== row.breeding_operation_id)) ||
            box.mintAddress !== row.mint_address ||
            box.originalRecipient !== row.wallet_address ||
            box.tokenOwner !== row.wallet_address || box.tokenAmount !== '1' ||
            !/^[1-9][0-9]*$/.test(box.serial ?? '')) {
          result.skipped++;
          continue;
        }
        const [escrowAuthority] = await getProgramDerivedAddress({
          programAddress: address(programId),
          seeds: [new TextEncoder().encode('silver-escrow'),
            getAddressEncoder().encode(address(row.mint_address))],
        });
        const [escrowAddress] = await findAssociatedTokenPda({
          mint: address(row.mint_address), owner: address(escrowAuthority),
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const escrow = await reader.readEscrow({ cluster: 'devnet', programId,
          mintAddress: row.mint_address, escrowAddress, escrowAuthority });
        if (escrow) {
          if (!escrow.finalized || escrow.programOwner !== TOKEN_2022_PROGRAM_ADDRESS ||
              escrow.address !== escrowAddress || escrow.mintAddress !== row.mint_address ||
              escrow.authority !== escrowAuthority || escrow.amount !== '0')
            throw new Error('Silver escrow account mismatch');
          readyCache.set(row.mint_address, { fingerprint, checkedAt: now() });
          result.ready++;
          continue;
        }
        await chain.provisionEscrow({ mintAddress: row.mint_address,
          escrowAddress, escrowAuthority });
        readyCache.set(row.mint_address, { fingerprint, checkedAt: now() });
        result.sent++;
      }
      while (readyCache.size > MAX_READY_CACHE)
        readyCache.delete(readyCache.keys().next().value);
      offset = rows.length < 20 ? 0 : offset + rows.length;
      return result;
    },
  };
}
