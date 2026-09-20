# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)
![Hackathon](https://img.shields.io/badge/Colosseum-Crypto%20World's%20Fair%202026-14F195)
![License: MIT](https://img.shields.io/badge/License-MIT-F2C176)

> A mobile game where movement creates resources, Rings connect progression and gameplay, and blockchain makes selected ownership and settlement verifiable.

[Demo Video](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [Android MVP](https://app.etherings.xyz/download/android/etherings.apk) · [X / Twitter](https://x.com/etherings2earn) · [Whitepaper](docs/ETHERINGS_WHITEPAPER_V0_2.md) · [Hackathon disclosure](docs/HACKATHON.md) · [Architecture](docs/ARCHITECTURE.md)

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

### Built / proven during the hackathon

Current test-only Alpha evidence includes:

- fresh verified-email Alpha accounts;
- Trust Wallet Core 4.8.2 embedded self-custodial wallet;
- BIP-39 recovery using path `m/44'/501'/0'/0'`;
- Android Keystore-encrypted local mnemonic storage;
- explicit account ↔ wallet binding and user Ed25519 signing;
- Token-2022 ERU Gateway + Transfer Hook enforcement;
- additive 2% ERU platform fee with full principal preserved;
- reward exemption, replay isolation and guarded initialization boundaries;
- backend operation states including pending / confirmed / failed / unknown;
- restart-safe reconciliation after ambiguous RPC outcomes;
- Squads 2-of-3 program/config governance on test-only Devnet;
- on-chain NFT issuance and finalized inventory projection;
- collection initialization and versioned on-chain asset state;
- direct-transfer 48-hour cooldown enforcement through Transfer Hook;
- fail-closed negative Hook/account/authority enforcement.

The current work area is the no-reroll NFT reveal / resulting Ring issuance path. A local lifecycle foundation exists, while oracle/runtime acceptance remains a separate gate.

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
| backend/ | Curated Alpha auth, wallet binding, economy/reconciliation and on-chain read-model source |
| programs/ | ERU and NFT program source used by the Alpha implementation |
| android/ | Curated Alpha wallet/signing module integrated into the main Android codebase |
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

## Quick Start

### Backend checks

Prerequisites: Node.js 24+, npm and a disposable PostgreSQL database.

~~~bash
cd backend
npm ci
export ALPHA_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/etherings_alpha_test'
npm test
npm run build
~~~

The tests create isolated schemas inside the disposable database. Never point `ALPHA_TEST_DATABASE_URL` at production data.

### Solana program source

The public `programs/` directory contains the reviewed Rust program source used by the current Alpha implementation. Private deployment scripts, signer material and RPC credentials are intentionally excluded.

### Android module

The Android directory contains the reviewed Alpha wallet/signing module from the main EtheRings Android codebase. The Trust Wallet Core AAR is intentionally not redistributed here. See [android/README.md](android/README.md).

For the currently published player build, use the [Android MVP APK](https://app.etherings.xyz/download/android/etherings.apk).

## Roadmap To Alpha

- [x] verified-email Alpha account boundary;
- [x] embedded self-custodial wallet and binding;
- [x] ERU Gateway / Transfer Hook proof;
- [x] backend reconciliation and UNKNOWN recovery;
- [x] governed NFT asset program and Devnet ownership path;
- [x] direct-transfer cooldown enforcement;
- [ ] no-reroll reveal → Ring issuance;
- [ ] main-product NFT inventory/reveal UI integration;
- [ ] hybrid game-economy settlement;
- [ ] NFT progression and ownership-aware M2E;
- [ ] fixed-price SOL marketplace;
- [ ] integrated Alpha acceptance and release path.

The current production MVP remains live while Alpha is developed. Alpha is the next version of the existing EtheRings product, not a permanent parallel application.

## Team

**Alexey — Founder / Product / Engineering**

EtheRings is currently founder-built across product design, game economy, Android, backend and Solana integration.

## Source Publication

This repository has independent public Git history. It is populated only through reviewed file-level exports from the private engineering repository. Private Git history, secrets, deployment material and operational evidence are not mirrored.

See [PUBLIC_MIRROR_SYNC_POLICY.md](PUBLIC_MIRROR_SYNC_POLICY.md).

## License

MIT — see [LICENSE](LICENSE).
