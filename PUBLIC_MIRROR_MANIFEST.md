# EtheRings Public Mirror

This repository is a curated public project and hackathon-review mirror. Its
public documentation describes the live Solana Devnet Public Alpha. A small
`current-alpha/` Cooper rules sample is current; `backend/`, `android/` and
`programs/` remain older bounded samples.

The authoritative engineering repository is maintained privately. Private Git history is not mirrored here.

## Export provenance

The exact private source revision is recorded outside this public mirror.
Private commit identifiers and Git history are intentionally not published.

## Current public allowlist

- README.md and .env.example
- PUBLIC_MIRROR_MANIFEST.md and PUBLIC_MIRROR_SYNC_POLICY.md
- public assets
- public architecture, security and hackathon docs; current Public Alpha Whitepaper PDF
- backend/ selected Alpha source, schemas and local tests
- programs/ selected ERU Gateway, ERU Hook and Silver program source
- android/ selected main-product Alpha wallet/signing source and focused tests
- current-alpha/ reviewed Cooper generation and breeding-price rules with focused local checks

## Explicit exclusions

The mirror does not publish private Git history, production/VPS runbooks, operational blockers/handoffs, agent instructions, private RPC/API credentials, signer/wallet secrets, governance/deployment operational scripts, internal security evidence, raw proof logs, Trust Wallet Core binary artifacts or private user/tester data.

## Synchronization State

Public-facing README, architecture and current-context hackathon text reflect
the live Public Alpha as of October 2026. The [current Whitepaper PDF](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf)
is included in this public mirror and is also available from the
[official site](https://etherings.xyz/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf).
The superseded Whitepaper v0.2 was removed from the current tree but remains
in Git history; public history was not rewritten.

The curated `backend/`, `programs/` and `android/` source sample remains the
September 20, 2026 submission snapshot. The `current-alpha/` sample was
reviewed and exported from the current shared Cooper rules. Neither sample
includes the complete current game, Android app or on-chain feature set.
Private Git history was not exported. The older sample is not labeled as the
live implementation.

Detailed implementation contracts, operational material, private evidence
and infrastructure information remain outside the public mirror.
