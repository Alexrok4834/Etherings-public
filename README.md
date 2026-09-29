# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)
![Hackathon](https://img.shields.io/badge/Colosseum-Crypto%20World's%20Fair%202026-14F195)
![License: MIT](https://img.shields.io/badge/License-MIT-F2C176)

> A mobile game where movement creates resources, Rings connect progression and gameplay, and blockchain makes selected ownership and settlement verifiable.

[Demo Video](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [Website](https://etherings.xyz/) · [X / Twitter](https://x.com/etherings2earn) · [Whitepaper](docs/ETHERINGS_WHITEPAPER_V0_2.md) · [Hackathon disclosure](docs/HACKATHON.md) · [Architecture](docs/ARCHITECTURE.md)

---

## Current Status (2026-09-29)

The first public Alpha test is being prepared. Its launch date and first-build
contents have not been announced. Development builds are not public releases.

The Android MVP is the earlier off-chain version of the same product. Its
shutdown is planned as part of the transition. Any MVP build or APK is not an
Alpha test build; this repository does not provide an Alpha APK. Check the
[official website](https://etherings.xyz/) for confirmed public-test updates.

### Approved product model

- ERT remains an off-chain, backend/PostgreSQL-authoritative game currency.
- MVP ERU records are off-chain and do not migrate; Alpha ERU is the Solana
  token under a separate clean-start transition.
- Cooper is an off-chain game Ring, not an NFT. Alpha Silver Boxes and Silver
  Rings use on-chain identity and ownership.
- The selected Alpha wallet is a classic embedded self-custodial Solana wallet
  with user Ed25519 signing. Devnet/Testnet network fees use user-held test
  SOL; Smart Accounts and mandatory transaction sponsorship are not Alpha
  scope.
- Cooper and Silver Level-Up prices, the additive 2% ERU fee and their
  availability are documented in the [Whitepaper](docs/ETHERINGS_WHITEPAPER_V0_2.md).

Alpha functionality is being added in stages. Mainnet is a separate future
release with its own approval and security gates.

---

## What EtheRings Is

EtheRings is built around one connected loop:

**Move → Earn → Play → Progress → Collect → New Utility**

Movement is the entry point, not the whole product. Rings and the game economy connect Move-to-Earn with progression, Mint, Raffle, Staking, Match-3, Marketplace and future rarity development.

The goal is to make the collection useful across the game instead of treating NFTs as separate pictures or wallet-only assets.

## Problem

Many Move-to-Earn products turn walking into the entire product and make token rewards the primary reason to participate. At the same time, Web3 UX often adds friction before a player can simply enjoy the game.

EtheRings takes a different approach: movement creates resources, gameplay gives those resources purpose, and collecting creates long-term progression and utility.

## Core Game Architecture

EtheRings uses two connected game-economy assets:

- **ERT** — the primary resource generated through Move-to-Earn and used across progression mechanics;
- **ERU** — the blockchain-connected economy asset used in less frequent economic, progression and reward flows.

NFT Rings sit at the center of the system.

~~~text
                         ┌──────────────┐
                         │     ERT      │
                         └──────┬───────┘
                                │
                ┌───────────────┼────────────────┐
                ▼               ▼                ▼
           Level Up            Mint       Rarity Upgrade
                ▲               ▲                ▲
                │               │                │
M2E ──→ ERT     │        ┌──────┴──────┐         │
                │        │     NFT     │─────────┘
                │        └──────┬──────┘
                │               │
                │        ┌──────┼───────────────┬───────────────┐
                │        ▼      ▼               ▼               ▼
                │     Staking  Match-3        Raffle        Marketplace
                │        │      │               │               │
                │        └──┬───┘               │               │
                │           ▼                   │               │
                └────────── ERU ◄───────────────┘               │
                            ▲                                   │
                            └───────────────────────────────────┘
~~~

The exact relationships are mechanic-specific, but the principle is simple:

- **M2E** introduces resources into the game loop;
- **NFTs** connect collecting with gameplay;
- **Mint** and **Level Up** consume game resources to expand and develop the collection;
- **Rarity Upgrade** extends long-term progression;
- **Staking** and **Match-3** give the collection additional utility;
- **Raffle** connects gameplay with rewards and collectible outcomes;
- **Marketplace** enables player-to-player exchange of blockchain assets.

This is why EtheRings is not just a Move-to-Earn app. Movement feeds a broader game economy.

## Why Solana

Solana is used where blockchain creates product value:

- verifiable digital ownership;
- programmable assets and state;
- user-authorized economic actions;
- transfers and marketplace settlement;
- low-cost, fast transactions suitable for a mobile game.

High-frequency gameplay, step validation and anti-cheat remain off-chain.

## What Works Today

### Pre-hackathon product

The project entered the hackathon with an existing Android MVP:

- native Android application;
- automatic durable step tracking;
- backend-authoritative Move-to-Earn;
- off-chain ERT and ERU accounting;
- Draw / Raffle;
- Ring inventory, equipment and progression;
- public Android testing and update infrastructure.

### Demonstrated in the test-only Alpha build

The development build has demonstrated:

- account registration with an email confirmation code;
- Trust Wallet Core 4.8.2 embedded self-custodial wallet;
- Box opening into a Silver NFT with visible attributes;
- Ring inventory and gameplay selection;
- step tracking, ERT earning and activity history;
- Cooper Level-Up, Points allocation and a user-signed ERU payment.

Under the hood, Alpha uses wallet-bound Ed25519 signing, a Token-2022 ERU
Gateway and Transfer Hook, finalized on-chain evidence and backend
reconciliation. The development network uses Squads 2-of-3 governance.
These capabilities are not yet an announced public test build. Silver
Level-Up remains under development; MVP shutdown is a separate transition.

See [docs/HACKATHON.md](docs/HACKATHON.md) for the competition boundary.

## Technical Implementation

The technical architecture implements the game model above without forcing every action on-chain.

~~~text
┌──────────────────────┐
│     Android App      │
│ gameplay + wallet    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    Game Backend      │
│ gameplay / ERT /     │
│ reservations / sync  │
└──────┬────────┬──────┘
       │        │
       │        │ user-reviewed intent
       ▼        ▼
 PostgreSQL   Android local signing
                │
                ▼
         ┌──────────────────┐
         │      Solana      │
         │ ERU / NFT state  │
         │ transfers /      │
         │ settlement       │
         └────────┬─────────┘
                  │ finalized evidence
                  ▼
             reconciliation
~~~

PostgreSQL and Solana are deliberately not presented as one atomic system. Cross-system operations use reservations, explicit pending/unknown states, finality validation and reconciliation.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| backend/ | Historical curated Alpha auth, wallet binding, economy and Silver first-entry source; not the complete current backend |
| programs/ | Historical curated ERU and Silver program source; not the complete current on-chain code |
| android/ | Curated wallet/signing source; see the module README for included boundaries |
| docs/ | Product/technical architecture, security model, hackathon disclosure and Whitepaper |
| assets/ | Public project media |

This is a curated public submission mirror. Operational evidence, private deployment material, credentials and internal development records remain in the private engineering repository.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Android | Java · Android Keystore · Trust Wallet Core 4.8.2 |
| Backend | Node.js 24 · PostgreSQL · @solana/kit |
| Solana programs | Rust · Solana Program · Token-2022 |
| Governance | Squads V4 2-of-3 on test-only Devnet |
| Email verification | Resend |
| Current network | Solana Devnet |

## Explore the source snapshot

Start with the [mirror manifest](PUBLIC_MIRROR_MANIFEST.md), then read the
[backend](backend/README.md), [program](programs/README.md) and
[Android](android/README.md) notes for the included files. This is a bounded
September 20, 2026 source sample, not a complete or buildable package of the
current Alpha runtime. No setup command here starts the full product.

### Solana program source

The public `programs/` directory contains a historical reviewed subset of
the Rust sources. It is not an exact source package for the current deployed
programs. Private deployment scripts, signer material and RPC credentials
are intentionally excluded.

### Android module

The Android directory contains a curated wallet/signing sample, not a full
buildable Android application. The Trust Wallet Core AAR is intentionally not
redistributed here. See [android/README.md](android/README.md).

No APK is linked here: the available historical MVP artifact is not an Alpha
build, and current service availability is not confirmed in this repository.

## Staged Roadmap

### First public Alpha test — preparing

The first public test is being prepared. Its date and contents are not
announced. Launch requires checks for the functions included in that build and
the overall security of the launch; completion of the full roadmap is not a
prerequisite.

### Further Alpha development — incremental

Alpha development continues in stages. Cooper progression is demonstrated in
the development build. Silver progression, Cooper breeding, Draw integration,
marketplace, remaining transfer/recovery behavior and release checks remain
open.

### Mainnet — future separate release

Mainnet is a separate future release with its own approved production model,
security checks, and launch gates. Alpha/Testnet assets and economy do not
automatically migrate.

## Team

**Alexey — Founder / Product / Engineering**

EtheRings is currently founder-built across product design, game economy, Android, backend and Solana integration.

## Source Publication

This repository has independent public Git history. It is populated only through reviewed file-level exports from the private engineering repository. Private Git history, secrets, deployment material and operational evidence are not mirrored.

See [PUBLIC_MIRROR_SYNC_POLICY.md](PUBLIC_MIRROR_SYNC_POLICY.md).

## License

MIT — see [LICENSE](LICENSE).
