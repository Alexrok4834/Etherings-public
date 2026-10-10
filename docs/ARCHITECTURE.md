# EtheRings Public Alpha: product and technology overview

## Current state

Public Alpha is live as an Android test version on **Solana Devnet**. The earlier off-chain MVP is retired. Public Alpha is not a Mainnet release, and its mechanics and economy may change during testing.

## Player experience

**Move. Play. Collect.** Players register with a verified email, create or restore an embedded self-custodial wallet, and collect Rings. Automatic step tracking produces the off-chain game resource ERT and an activity history. Draw and Ring progression put game resources to use.

The current collection includes Cooper Rings as game items and Silver Box/Ring NFTs on Solana Devnet. Players can level up Cooper and Silver Rings and allocate Points. Breeding two eligible Cooper Rings creates a Silver Box NFT; opening an eligible Box produces a Silver Ring NFT. Eligible Ring NFTs and sealed Box NFTs can be offered through the fixed-price SOL Marketplace. Direct NFT transfers have a 48-hour gameplay cooldown.

## Where game state lives

| Game area | Public Alpha approach |
| --- | --- |
| Steps, ERT and frequent game actions | Handled by the game backend. ERT is an off-chain game resource. |
| Cooper Rings | Game items and progression, not NFTs. |
| ERU | A Solana Devnet test token. |
| Silver Boxes and Rings | Solana Devnet NFTs with player ownership and applicable game rules. |
| Wallet actions | The player reviews and signs approved Solana actions locally in the Android wallet. |
| Completed blockchain actions | The game verifies finalized results before showing their outcome. |

This split keeps step counting and frequent gameplay responsive while giving players ownership of NFT items and control of ERU tokens. Players use Devnet test SOL for blockchain network fees. Recovery phrase control remains with the player; the game backend does not need it.

## Scope and history

The [current Public Alpha Whitepaper (PDF)](EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) is the detailed public reference. Match-3, staking, gemstones, Gold and Platinum progression and future rarity changes are outside the implemented Public Alpha scope. Mainnet is a separate future release.

The [current Cooper rules sample](../current-alpha/README.md) illustrates one small part of today's backend logic. The historical `backend/`, `android/` and `programs/` files are a separate bounded public source sample. Neither represents the full code for the live game; see the [mirror manifest](../PUBLIC_MIRROR_MANIFEST.md). The [hackathon disclosure](HACKATHON.md) retains its earlier competition-era facts.
