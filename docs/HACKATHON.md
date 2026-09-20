# Crypto World's Fair 2026 — EtheRings Hackathon Disclosure

**Move. Play. Collect.**

[Demo Video](https://youtube.com/shorts/-swQa1foF2M?feature=share)

This document separates the product that existed before the competition from implementation performed during the hackathon.

## Pre-hackathon baseline

Before the competition, EtheRings already had a working Android MVP with:

- native Android client;
- automatic background step tracking;
- server-authoritative Move-to-Earn;
- off-chain ERT and ERU accounting;
- Draw / Raffle;
- off-chain Cooper Rings;
- inventory, equipment and progression;
- public Android testing and release/update infrastructure.

The pre-hackathon product was not running on Solana.

Blockchain architecture had been researched and planned before the competition. Pre-existing design is not represented here as competition-period implementation.

## Hackathon implementation

During the competition, the project moved from architecture into a test-only Solana Alpha implementation.

Accepted within their documented test boundaries:

- new verified-email Alpha account flow;
- classic embedded self-custodial wallet using Trust Wallet Core 4.8.2;
- BIP-39 backup/restore and local Android Keystore-encrypted secret storage;
- account-to-wallet challenge binding;
- exact user-signed Solana intents;
- ERU Token-2022 Gateway + Transfer Hook path;
- additive 2% ERU commission with reward and fee-leg exemptions;
- replay isolation and guarded program/config initialization;
- backend durable operation lifecycle and reconciliation;
- UNKNOWN handling for ambiguous RPC outcomes;
- first-entry Silver Box on Devnet;
- Squads V4 2-of-3 governance over Silver upgrade/config authority;
- Silver collection initialization;
- schema-3 Silver transfer state and ExtraAccountMetaList;
- Devnet direct-transfer 48-hour cooldown enforcement;
- fail-closed negative Hook/account/authority checks.

## Current work

The current Silver work area is Box reveal → Silver Ring issuance.

A local reveal/no-reroll foundation is proven, but no production or Mainnet randomness claim is made. Exact oracle/deployment provenance and on-chain reveal transition remain separate acceptance gates.

After the Silver lifecycle, the Alpha plan continues with:

- Cooper → Silver hybrid settlement;
- Silver progression and M2E integration;
- product UI integration;
- fixed-price SOL marketplace;
- integrated security/reconciliation/device acceptance.

## Product integration decision

The current production MVP remains live and unchanged during Alpha development.

Alpha is the next version of the existing EtheRings product. Isolated Alpha Android/backend environments are used for safe proof work, but accepted capabilities must be integrated into the main product before release.

The MVP → Alpha clean start applies to user/economy/runtime state: existing MVP accounts, balances, progress and sessions are not automatically imported into Alpha. It does not require rebuilding the game as a permanent second product.

## Public repository boundary

This public repository is a curated source snapshot for project/hackathon review.

The private engineering repository retains detailed proof reports, operational history, deployment runbooks, private endpoints/credentials, signer/governance operational material and internal workflow files.

## Public source baseline

This publication snapshot was exported from private source commit:

**e6833d64ca6b19d5e6bde5490595a2d56c385fc3**

The public repository intentionally has independent Git history and does not claim shared ancestry with the private repository.
