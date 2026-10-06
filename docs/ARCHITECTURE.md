# EtheRings Public Alpha: product and technology overview

## Current state

Public Alpha is live as an Android test version on **Solana Devnet**. The earlier off-chain MVP is retired. Public Alpha is not a Mainnet release, and its mechanics and economy may change during testing.

## Player experience

**Move. Play. Collect.** Players register with a verified email, create or restore an embedded self-custodial wallet, and collect Rings. Automatic step tracking produces the off-chain game resource ERT and an activity history. Draw and Ring progression put game resources to use.

The current collection includes Cooper Rings and Solana Devnet Silver Boxes and Silver Rings. Players can level up Cooper and Silver Rings and allocate Points. Breeding two eligible Cooper Rings creates a Silver Box; opening an eligible Box produces a Silver Ring. Eligible Silver Rings and sealed Boxes can be offered through the fixed-price SOL Marketplace. Direct Silver transfers have a 48-hour gameplay cooldown.

## Where game state lives

| Game area | Public Alpha approach |
| --- | --- |
| Steps, ERT and frequent game actions | Handled by the game backend. ERT is an off-chain game resource. |
| Cooper Rings | Game collection and progression without an NFT. |
| ERU and Silver assets | Solana Devnet test assets with on-chain ownership and applicable game rules. |
| Wallet actions | The player reviews and signs approved Solana actions locally in the Android wallet. |
| Completed blockchain actions | The game verifies finalized results before showing their outcome. |

This split keeps step counting and frequent gameplay responsive while giving players ownership of the current Silver and ERU layer. Players use Devnet test SOL for blockchain network fees. Recovery phrase control remains with the player; the game backend does not need it.

## Scope and history

The [current Public Alpha Whitepaper (PDF)](https://etherings.xyz/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) is the detailed public reference. Match-3, staking, gemstones, Gold and Platinum progression and future rarity changes are outside the implemented Public Alpha scope. Mainnet is a separate future release.

The historical `backend/`, `android/` and `programs/` files in this repository are a bounded public source sample. They do not represent the full code for the live game; see the [mirror manifest](../PUBLIC_MIRROR_MANIFEST.md). The [hackathon disclosure](HACKATHON.md) retains its earlier competition-era facts.
