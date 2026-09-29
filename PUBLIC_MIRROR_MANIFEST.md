# EtheRings Public Mirror

This repository is a curated public project and hackathon-review mirror.

The authoritative engineering repository is maintained privately. Private Git history is not mirrored here.

## Export provenance

The exact private source revision is recorded outside this public mirror.
Private commit identifiers and Git history are intentionally not published.

## Current public allowlist

- README.md and .env.example
- PUBLIC_MIRROR_MANIFEST.md and PUBLIC_MIRROR_SYNC_POLICY.md
- public assets
- current public Whitepaper and hackathon/architecture/security docs
- backend/ selected Alpha source, schemas and local tests
- programs/ selected ERU Gateway, ERU Hook and Silver program source
- android/ selected main-product Alpha wallet/signing source and focused tests

## Explicit exclusions

The mirror does not publish private Git history, production/VPS runbooks, operational blockers/handoffs, agent instructions, private RPC/API credentials, signer/wallet secrets, governance/deployment operational scripts, internal security evidence, raw proof logs, Trust Wallet Core binary artifacts or private user/tester data.

## Synchronization State

Public-facing README, Whitepaper, architecture and hackathon context were
updated on September 29, 2026. They describe the development-build results
and approved economy model, not a released Alpha build.

The curated `backend/`, `programs/` and `android/` source sample remains the
September 20, 2026 submission snapshot. It does **not** include later
Cooper progression, full Silver lifecycle, current ERU governance/runtime,
current Android integration, or the complete build/deployment tree. A
dependency-closed, security-reviewed export of those later changes was not
established in this publication pass; copying individual changed files would
misrepresent an incomplete implementation as current. This limitation is
intentional and the older source is not labeled as today's runtime.

Detailed implementation contracts, operational material, private evidence
and infrastructure information remain outside the public mirror.
