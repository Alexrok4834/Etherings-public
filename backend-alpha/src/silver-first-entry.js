import { createHash } from 'node:crypto';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { drawBoxIdentity } from './draw-box-identity.js';
import { breedingBoxIdentity } from './cooper-breeding.js';

const UNAUTHORIZED = { status: 401, body: { message: 'Authentication required.' } };
const UNBOUND = { status: 409, body: { message: 'Verified wallet binding required.' } };
const hash = (value) => createHash('sha256').update(value, 'ascii').digest('hex');
const tokenHash = (value) => hash(value);
function solanaAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch { return false; }
}

export function firstEntryIdentity(accountId, walletAddress, cluster) {
  const issuanceId = hash(`EtheRings:first-entry:issuance:v1\n${cluster}\n${accountId}\n`);
  const entitlementDigest = hash(
    `EtheRings:first-entry:entitlement:v1\n${cluster}\n${accountId}\n${walletAddress}\n${issuanceId}\n`
  );
  return { issuanceId, entitlementDigest };
}

export function createSilverFirstEntry({ pool, chain, cluster, programId, collectionId,
  walletEnvironment, openingProjectionEnabled = false, drawInventoryEnabled = false,
  breedingInventoryEnabled = false,
  now = () => new Date() }) {
  if (!pool || typeof chain?.readFinalized !== 'function' ||
      typeof chain?.listOwnedRings !== 'function' ||
      !['local-validator', 'devnet'].includes(cluster) || !solanaAddress(programId) ||
      !solanaAddress(collectionId) || !/^[a-z][a-z0-9-]{2,31}$/.test(walletEnvironment ?? '')) {
    throw new Error('Silver first-entry requires isolated PostgreSQL, chain reader and exact environment');
  }

  async function binding(client, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (await client.query(
      `SELECT a.id AS account_id, b.wallet_address, b.environment
       FROM alpha_sessions s JOIN alpha_accounts a ON a.id = s.account_id
       LEFT JOIN alpha_wallet_bindings b ON b.account_id = a.id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
      [tokenHash(token), now()]
    )).rows[0] ?? null;
  }

  async function entitlement(token) {
    const user = await binding(pool, token);
    if (!user) return { error: UNAUTHORIZED };
    if (!user.wallet_address || user.environment !== walletEnvironment) return { error: UNBOUND };
    const expected = firstEntryIdentity(user.account_id, user.wallet_address, cluster);
    return { user, expected };
  }

  async function inventoryResponse(accountId, walletAddress, assets) {
    if (breedingInventoryEnabled) {
      const bred = (await pool.query(`SELECT o.id, o.first_ring_id, o.second_ring_id,
        o.first_uses, o.second_uses, o.issuance_id, o.entitlement_digest,
        s.signature, s.box_mint
      FROM alpha_cooper_breeding_operations o
      JOIN alpha_cooper_breeding_settlements s ON s.operation_id = o.id
      WHERE o.account_id = $1 AND o.wallet_address = $2 AND o.cluster = $3`,
    [accountId, walletAddress, cluster])).rows;
    const seenBred = new Set();
    for (const box of bred) {
      const identity = breedingBoxIdentity(accountId, walletAddress, box.id,
        box.first_ring_id, box.second_ring_id, box.first_uses, box.second_uses, cluster);
      if (identity.issuanceId !== box.issuance_id ||
          identity.entitlementDigest !== box.entitlement_digest) continue;
      const asset = await chain.readFinalized({ programId, cluster,
        issuanceId: identity.issuanceId, walletAddress,
        expectedIssuanceSource: 'cooper-breeding',
        expectedBreeding: { operationId: box.id, firstRingId: box.first_ring_id,
          secondRingId: box.second_ring_id, firstUses: box.first_uses,
          secondUses: box.second_uses },
        expectedFinalizedSignature: box.signature });
      if (!asset || asset.finalized !== true || asset.kind !== 'SILVER_BOX' ||
          asset.lifecycle !== 'SEALED' || asset.accountId !== accountId ||
          asset.originalRecipient !== walletAddress || asset.tokenOwner !== walletAddress ||
          asset.entitlementDigest !== identity.entitlementDigest ||
          asset.mintAddress !== box.box_mint ||
          !/^[1-9][0-9]{0,19}$/.test(asset.serial ?? '') ||
          seenBred.has(asset.mintAddress)) continue;
      seenBred.add(asset.mintAddress);
      assets.push({ kind: 'SILVER_BOX', mintAddress: asset.mintAddress,
        issuanceId: identity.issuanceId, serial: asset.serial,
        lifecycle: 'SEALED', cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
        ...(asset.uri && asset.contentHash ?
          { uri: asset.uri, contentHash: asset.contentHash } : {}) });
    }
    }
    if (drawInventoryEnabled) {
      const boxes = (await pool.query(`SELECT r.id AS result_id,
        r.account_id, o.wallet_address, f.chain_signature, f.chain_asset_address
        FROM alpha_draw_results r
        JOIN alpha_draw_operations o ON o.id = r.operation_id
        JOIN alpha_draw_fulfillments f ON f.result_id = r.id
        WHERE r.account_id = $1 AND o.wallet_address = $2
          AND r.selected_reward_type = 'SILVER_BOX'
          AND f.state = 'CONFIRMED'`, [accountId, walletAddress])).rows;
      const seenDraw = new Set();
      for (const box of boxes) {
        const identity = drawBoxIdentity(accountId, walletAddress, box.result_id);
        const asset = await chain.readFinalized({ programId, cluster,
          issuanceId: identity.issuanceId, walletAddress,
          expectedIssuanceSource: 'draw', expectedDrawResultId: box.result_id,
          expectedFinalizedSignature: box.chain_signature });
        if (!asset || asset.finalized !== true || asset.kind !== 'SILVER_BOX' ||
            asset.lifecycle !== 'SEALED' || asset.accountId !== accountId ||
            asset.originalRecipient !== walletAddress ||
            asset.tokenOwner !== walletAddress ||
            asset.entitlementDigest !== identity.entitlementDigest ||
            asset.mintAddress !== box.chain_asset_address ||
            !/^[1-9][0-9]{0,19}$/.test(asset.serial ?? '') ||
            seenDraw.has(asset.mintAddress)) continue;
        seenDraw.add(asset.mintAddress);
        assets.push({ kind: 'SILVER_BOX', mintAddress: asset.mintAddress,
          issuanceId: identity.issuanceId, serial: asset.serial,
          lifecycle: 'SEALED', cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
          ...(asset.uri && asset.contentHash ?
            { uri: asset.uri, contentHash: asset.contentHash } : {}) });
      }
    }
    const seen = new Set(assets.map(asset => asset.mintAddress));
    const [ownedBoxes, transferred] = typeof chain.listOwnedAssets === 'function'
      ? await chain.listOwnedAssets({ programId, cluster, walletAddress })
      : await Promise.all([
        typeof chain.listOwnedBoxes === 'function'
          ? chain.listOwnedBoxes({ programId, cluster, walletAddress }) : [],
        chain.listOwnedRings({ programId, cluster, walletAddress }),
      ]);
    for (const box of ownedBoxes) {
      if (box.finalized !== true || box.kind !== 'SILVER_BOX' ||
          box.programId !== programId || box.cluster !== cluster ||
          box.collectionId !== collectionId || box.tokenOwner !== walletAddress ||
          box.lifecycle !== 'SEALED' ||
          !/^[1-9][0-9]{0,19}$/.test(box.serial ?? '') ||
          seen.has(box.mintAddress)) continue;
      assets.push({ kind: 'SILVER_BOX', mintAddress: box.mintAddress,
        issuanceId: box.issuanceId, serial: box.serial, lifecycle: 'SEALED',
        cooldownUntilUnixSeconds: box.cooldownUntilUnixSeconds,
        ...(box.uri && box.contentHash ?
          { uri: box.uri, contentHash: box.contentHash } : {}) });
      seen.add(box.mintAddress);
    }
    for (const ring of transferred) {
      if (ring.finalized !== true || ring.kind !== 'SILVER_RING' ||
          ring.programId !== programId || ring.cluster !== cluster ||
          ring.collectionId !== collectionId || ring.tokenOwner !== walletAddress ||
          !/^[1-9][0-9]{0,19}$/.test(ring.serial ?? '') ||
          seen.has(ring.mintAddress)) continue;
      assets.push({ kind: 'SILVER_RING', mintAddress: ring.mintAddress,
        boxMint: ring.boxMint, designId: ring.designId, uri: ring.uri,
        contentHash: ring.contentHash, serial: ring.serial,
        level: ring.level, shine: ring.shine, unspentPoints: ring.unspentPoints,
        comfort: ring.comfort, charm: ring.charm, quality: ring.quality, luck: ring.luck,
        lastDirectTransferSlot: ring.lastDirectTransferSlot,
        cooldownUntilUnixSeconds: ring.cooldownUntilUnixSeconds });
      seen.add(ring.mintAddress);
    }
    return { status: 200, body: { assets } };
  }

  return {
    async reserve(token) {
      const context = await entitlement(token);
      if (context.error) return context.error;
      const { user, expected } = context;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO alpha_silver_first_entry
           (account_id, wallet_address, cluster, issuance_id, entitlement_digest)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id, cluster) DO NOTHING`,
          [user.account_id, user.wallet_address, cluster, expected.issuanceId, expected.entitlementDigest]
        );
        const row = (await client.query(
          'SELECT * FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = $2 FOR UPDATE',
          [user.account_id, cluster]
        )).rows[0];
        if (row.wallet_address !== user.wallet_address || row.cluster !== cluster ||
            row.issuance_source !== 'first-entry' || row.issuance_id !== expected.issuanceId ||
            row.entitlement_digest !== expected.entitlementDigest) {
          await client.query('ROLLBACK');
          return { status: 409, body: { message: 'Entitlement binding conflict.' } };
        }
        await client.query('COMMIT');
        return { status: 200, body: { issuanceId: row.issuance_id,
          entitlementDigest: row.entitlement_digest, status: row.status } };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async inventory(token) {
      const context = await entitlement(token);
      if (context.error) return context.error;
      const { user, expected } = context;
      const row = (await pool.query(
        'SELECT * FROM alpha_silver_first_entry WHERE account_id = $1 AND cluster = $2',
        [user.account_id, cluster]
      )).rows[0];
      if (!row) return inventoryResponse(user.account_id, user.wallet_address, []);
      if (row.wallet_address !== user.wallet_address || row.cluster !== cluster ||
          row.issuance_source !== 'first-entry' ||
          row.issuance_id !== expected.issuanceId ||
          row.entitlement_digest !== expected.entitlementDigest) {
        return { status: 409, body: { message: 'Entitlement binding conflict.' } };
      }
      const asset = await chain.readFinalized({ programId, cluster, issuanceId: row.issuance_id,
        walletAddress: user.wallet_address, expectedFinalizedSignature: row.finalized_signature });
      if (!asset) {
        if (row.status !== 'confirmed' || typeof chain.readRingForIssuance !== 'function') {
          return inventoryResponse(user.account_id, user.wallet_address, []);
        }
        const ring = await chain.readRingForIssuance({ programId, cluster,
          issuanceId: row.issuance_id, walletAddress: user.wallet_address });
        if (!ring) {
          if (openingProjectionEnabled && row.status === 'confirmed' &&
              typeof chain.readOpeningInventory === 'function') {
            const opening = (await pool.query(`SELECT c.* FROM alpha_silver_opening_candidate_intents c
              JOIN alpha_silver_opening_submissions s USING
                (cluster, genesis_hash, program_id, mint_address)
              WHERE c.cluster = $1 AND c.program_id = $2 AND c.mint_address = $3
                AND c.account_id = $4 AND c.wallet_address = $5
                AND s.status IN ('unknown', 'confirmed')`,
            [cluster, programId, row.mint_address, user.account_id, user.wallet_address])).rows[0];
            if (opening && await chain.readOpeningInventory({ programId,
              mintAddress: row.mint_address, walletAddress: row.wallet_address,
              sourceTokenAddress: opening.source_token_address,
              escrowAddress: opening.escrow_address,
              seed: Buffer.from(opening.seed_hex, 'hex'),
              nextOperation: opening.next_operation,
              designVersion: opening.design_version,
              designCommitment: opening.design_commitment,
              issuanceId: row.issuance_id })) {
              const media = typeof chain.readBoxMedia === 'function' ?
                await chain.readBoxMedia({ programId, cluster, mintAddress: row.mint_address,
                  issuanceId: row.issuance_id, collectionId }) : {};
              if (!media.serial) return inventoryResponse(user.account_id, user.wallet_address, []);
              return inventoryResponse(user.account_id, user.wallet_address, [{ kind: 'SILVER_BOX',
                mintAddress: row.mint_address, issuanceId: row.issuance_id,
                lifecycle: 'OPENING', custody: 'PROGRAM_ESCROW', openingStatus: 'pending',
                cooldownUntilUnixSeconds: '0', ...media }]);
            }
          }
          return inventoryResponse(user.account_id, user.wallet_address, []);
        }
        if (ring.finalized !== true || ring.kind !== 'SILVER_RING' ||
            ring.programId !== programId || ring.cluster !== cluster ||
            !/^[1-9][0-9]{0,19}$/.test(ring.serial ?? '') ||
            ring.issuanceId !== row.issuance_id ||
            ring.entitlementDigest !== row.entitlement_digest ||
            ring.accountId !== user.account_id ||
            ring.originalRecipient !== row.wallet_address ||
            ring.boxMint !== row.mint_address ||
            ring.collectionId !== collectionId ||
            ring.tokenOwner !== user.wallet_address) {
          return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
        }
        const opening = openingProjectionEnabled && (await pool.query(`SELECT c.mint_address
          FROM alpha_silver_opening_candidate_intents c
          JOIN alpha_silver_opening_submissions s USING
            (cluster, genesis_hash, program_id, mint_address)
          WHERE c.cluster = $1 AND c.program_id = $2 AND c.mint_address = $3
            AND c.account_id = $4 AND c.wallet_address = $5 AND s.status = 'confirmed'`,
        [cluster, programId, ring.boxMint, user.account_id, user.wallet_address])).rows[0];
        return inventoryResponse(user.account_id, user.wallet_address, [{ kind: 'SILVER_RING',
          mintAddress: ring.mintAddress, boxMint: ring.boxMint,
          designId: ring.designId, uri: ring.uri, contentHash: ring.contentHash,
          serial: ring.serial, level: ring.level, shine: ring.shine,
          unspentPoints: ring.unspentPoints, comfort: ring.comfort, charm: ring.charm,
          quality: ring.quality, luck: ring.luck,
          lastDirectTransferSlot: ring.lastDirectTransferSlot,
          cooldownUntilUnixSeconds: ring.cooldownUntilUnixSeconds,
          ...(opening ? { openingStatus: 'confirmed' } : {}) }]);
      }
      const [expectedMint] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [new TextEncoder().encode('silver-mint'), Buffer.from(row.issuance_id, 'hex')]
      });
      const [expectedState] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [new TextEncoder().encode('silver-state'), bs58.decode(expectedMint)]
      });
      const [expectedLifecycle] = await getProgramDerivedAddress({
        programAddress: address(programId),
        seeds: [new TextEncoder().encode('silver-lifecycle'), bs58.decode(expectedMint)]
      });
      if (asset.finalized !== true || asset.stateSchemaVersion !== 3 ||
          asset.programId !== programId || asset.stateOwnerProgramId !== programId ||
          asset.mintOwnerProgramId !== TOKEN_2022_PROGRAM_ADDRESS ||
          asset.tokenAccountOwnerProgramId !== TOKEN_2022_PROGRAM_ADDRESS ||
          asset.collectionId !== collectionId || asset.cluster !== cluster ||
          asset.issuanceId !== row.issuance_id || asset.entitlementDigest !== row.entitlement_digest ||
          asset.issuanceSource !== 'first-entry' || asset.accountId !== user.account_id ||
          asset.kind !== 'SILVER_BOX' || asset.lifecycle !== 'SEALED' ||
          asset.lifecycleAddress !== expectedLifecycle || asset.lifecycleVersion !== 1 ||
          asset.lifecyclePhase !== 'SEALED' || asset.lifecycleNextOperation !== '1' ||
          !/^[1-9][0-9]*$/.test(asset.lifecycleMigrationSlot) ||
          asset.originalRecipient !== user.wallet_address ||
          asset.mintAddress !== expectedMint || asset.stateAddress !== expectedState ||
          asset.stateMint !== asset.mintAddress || asset.tokenMint !== asset.mintAddress ||
          asset.supply !== '1' || asset.decimals !== 0 || asset.tokenAmount !== '1' ||
          asset.mintAuthority !== null || asset.freezeAuthority !== null ||
          !asset.mintAddress || !/^[1-9][0-9]*$/.test(asset.issuanceSlot)) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (!/^(0|[1-9][0-9]*)$/.test(asset.lastDirectTransferSlot) ||
          !/^(0|[1-9][0-9]*)$/.test(asset.cooldownUntilUnixSeconds) ||
          (asset.lastDirectTransferSlot === '0') !==
            (asset.cooldownUntilUnixSeconds === '0')) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (row.status !== 'confirmed') {
        await pool.query(
          `UPDATE alpha_silver_first_entry SET status = 'confirmed', mint_address = $2,
           confirmation_slot = $3, finalized_signature = $4, confirmed_at = $5
           WHERE account_id = $1 AND cluster = $6 AND status IN ('pending', 'unknown')`,
          [user.account_id, asset.mintAddress, asset.issuanceSlot,
            asset.finalizedSignature, now(), cluster]
        );
      }
      const finalized = (await pool.query(
        `SELECT status, mint_address, finalized_signature, confirmation_slot
         FROM alpha_silver_first_entry
         WHERE account_id = $1 AND cluster = $2`, [user.account_id, cluster]
      )).rows[0];
      if (finalized?.status !== 'confirmed' || finalized.mint_address !== asset.mintAddress ||
          finalized.finalized_signature !== asset.finalizedSignature ||
          (finalized.confirmation_slot !== null &&
            finalized.confirmation_slot !== asset.issuanceSlot)) {
        return { status: 409, body: { message: 'Silver chain identity mismatch.' } };
      }
      if (asset.tokenOwner !== user.wallet_address ||
          !/^[1-9][0-9]{0,19}$/.test(asset.serial ?? ''))
        return inventoryResponse(user.account_id, user.wallet_address, []);
      return inventoryResponse(user.account_id, user.wallet_address, [{ kind: 'SILVER_BOX', mintAddress: asset.mintAddress,
        issuanceId: row.issuance_id, serial: asset.serial, lifecycle: 'SEALED',
        cooldownUntilUnixSeconds: asset.cooldownUntilUnixSeconds,
        ...(asset.uri && asset.contentHash ? { uri: asset.uri, contentHash: asset.contentHash } : {}) }]);
    }
  };
}
