# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)
![Hackathon](https://img.shields.io/badge/Colosseum-Crypto%20World's%20Fair%202026-14F195)
![License: MIT](https://img.shields.io/badge/License-MIT-F2C176)

> A mobile game where real-world movement creates resources, gameplay gives them purpose, and collectible Rings connect progression with verifiable digital ownership.

[Demo Video](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [Android MVP](https://app.etherings.xyz/download/android/etherings.apk) · [X / Twitter](https://x.com/etherings2earn) · [Whitepaper](docs/ETHERINGS_WHITEPAPER_V0_2.md) · [Hackathon disclosure](docs/HACKATHON.md) · [Architecture](docs/ARCHITECTURE.md)

---

## What EtheRings Is

EtheRings is built around one loop:

**Move → Resources → Play → Progress → Collect → New Utility**

Movement is not intended to be the whole game. The existing Android MVP already has automatic step tracking, server-authoritative Move-to-Earn, Draw/Raffle, Cooper Rings, inventory, equipment and progression.

The Alpha adds Solana where it creates a clear product benefit: user-controlled ownership, scarce digital assets, transfers and economic settlement.

## Problem

Many Move-to-Earn products turn walking into the entire product and make token rewards the primary reason to participate. At the same time, Web3 UX often asks normal users to understand wallets, gas and blockchain mechanics before they can enjoy the game.

## Approach

EtheRings keeps high-frequency gameplay and real-world activity validation off-chain, while moving selected ownership and settlement boundaries on-chain.

- **ERT and Cooper Rings:** authoritative off-chain game state.
- **ERU:** Token-2022 asset for the Alpha economy.
- **Silver Boxes and Silver Rings:** Token-2022 assets with typed on-chain state.
- **Android wallet:** embedded self-custody with local signing.
- **Backend ↔ Solana:** explicit reconciliation; never represented as one cross-system atomic transaction.

The goal is simple: the player should experience a game first, while blockchain quietly improves ownership and settlement.

## Why Solana

EtheRings needs a chain suitable for a consumer mobile game:

- low transaction cost;
- fast confirmation;
- programmable token and asset state;
- Token-2022 extensions such as Transfer Hook;
- practical mobile signing;
- composable program execution.

Solana is used for the parts that benefit from verifiable ownership and enforcement, not as a database for steps or every game action.

## What Works Today

### Pre-hackathon product

The project entered the hackathon with an existing Android MVP:

- native Android application;
- automatic durable step tracking;
- backend-authoritative Move-to-Earn;
- off-chain ERT and ERU accounting;
- Draw / Raffle;
- Cooper Ring inventory, equipment and progression;
- public Android testing and update infrastructure.

### Built / proven during the hackathon

Current test-only Alpha evidence includes:

- fresh verified-email Alpha accounts;
- Trust Wallet Core 4.8.2 embedded self-custodial wallet;
- BIP-39 recovery using path m/44'/501'/0'/0';
- Android Keystore-encrypted local mnemonic storage;
- explicit account ↔ wallet binding and user Ed25519 signing;
- Token-2022 ERU Gateway + Transfer Hook enforcement;
- additive 2% ERU platform fee with full principal preserved;
- reward exemption, replay isolation and guarded initialization boundaries;
- backend operation states including pending / confirmed / failed / unknown;
- restart-safe reconciliation after ambiguous RPC outcomes;
- Squads 2-of-3 administration for the Silver program;
- first-entry Silver Box issuance and finalized inventory projection on Devnet;
- Silver collection initialization and schema migration;
- Silver Transfer Hook direct-transfer cooldown enforcement on Devnet;
- negative Hook/account/authority enforcement without finalized unauthorized state changes.

Silver Box reveal → Silver Ring issuance is the current work area. A local no-reroll/reveal foundation exists, but an oracle integration is not claimed as accepted yet.

See [docs/HACKATHON.md](docs/HACKATHON.md) for the competition boundary.

## Architecture

~~~text
                     ┌──────────────────────────┐
                     │       Android app        │
                     │  gameplay + local wallet │
                     └────────────┬─────────────┘
                                  │ HTTPS
                                  ▼
                     ┌──────────────────────────┐
                     │       Game backend       │
                     │ auth / ERT / Cooper /    │
                     │ reservations / reconcile │
                     └───────┬──────────┬───────┘
                             │          │
                    PostgreSQL          │ exact intent
                             │          ▼
                             │   ┌──────────────────┐
                             │   │ Android signs    │
                             │   │ locally          │
                             │   └────────┬─────────┘
                             │            │
                             └────────────┼───────────────┐
                                          ▼               │
                               ┌──────────────────────┐    │
                               │       Solana         │    │
                               │ ERU Gateway / Hook   │    │
                               │ Silver program       │    │
                               │ Token-2022 assets    │    │
                               └──────────┬───────────┘    │
                                          │ finalized      │
                                          └────────────────┘
                                             reconcile
~~~

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| backend/ | Curated Alpha auth, wallet binding, ERU/reconciliation and Silver read-model source |
| programs/eru-gateway/ | ERU Gateway program source |
| programs/eru-hook/ | ERU Token-2022 Transfer Hook source |
| programs/silver/ | Silver Box/Ring program source |
| android/ | Curated Alpha wallet/signing module already integrated into the main Android codebase |
| docs/ | Architecture, security model, hackathon disclosure and Whitepaper |
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

The tests create isolated schemas inside the disposable database. Never point ALPHA_TEST_DATABASE_URL at production data.

### Solana program source

~~~bash
cargo test --manifest-path programs/eru-gateway/Cargo.toml
cargo test --manifest-path programs/eru-hook/Cargo.toml
cargo test --manifest-path programs/silver/Cargo.toml
~~~

The public mirror intentionally excludes private deployment scripts, signer material and RPC credentials.

### Android module

The Android directory contains the reviewed Alpha wallet/signing module from the main EtheRings Android codebase. The Trust Wallet Core AAR is intentionally not redistributed here. See [android/README.md](android/README.md).

For the currently published player build, use the [Android MVP APK](https://app.etherings.xyz/download/android/etherings.apk).

## Roadmap To Alpha

- [x] verified-email Alpha account boundary;
- [x] embedded self-custodial wallet and binding;
- [x] ERU Gateway / Transfer Hook proof;
- [x] backend reconciliation and UNKNOWN recovery;
- [x] Silver first-entry Box and Squads-governed Devnet program;
- [x] Silver direct-transfer cooldown enforcement;
- [ ] Box reveal / no-reroll → Silver Ring issuance;
- [ ] main-product Silver inventory/reveal UI integration;
- [ ] Cooper → Silver hybrid settlement;
- [ ] Silver progression and ownership-aware M2E;
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
