# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

EtheRings is an Android game where movement feeds game resources, Rings connect collecting and progression, and Solana supports ownership and player-approved actions.

[Download Public Alpha for Android](https://app.etherings.xyz/download/android/etherings.apk) · [Website](https://etherings.xyz/) · [Current Whitepaper (PDF)](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) · [Demo video](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [X](https://x.com/etherings2earn)

## Public Alpha is live

The current public test runs on **Solana Devnet**. Its SOL, ERU and Silver assets are test assets. Public Alpha is an evolving test version: mechanics, limits, prices and the economy may change. It is not a Mainnet release.

The earlier Android MVP is historical and retired. It is not the current download. **Uninstall the MVP before installing Public Alpha**; uninstalling removes local MVP data, including any unsent steps. Players who already have Public Alpha can install later compatible builds over their existing installation when instructed.

## What works now

- Verified email registration and sign-in.
- An embedded self-custodial wallet that players can create or restore; the wallet signs approved Solana actions locally.
- Cooper Rings, Silver Boxes and Silver Rings in the collection.
- Automatic step tracking, ERT earning and activity history.
- Draw.
- Cooper Level-Up and Points; Silver Level-Up and Points.
- Cooper breeding that creates a Silver Box, and opening a Silver Box into a Silver Ring.
- Direct transfer of eligible Silver assets, with a 48-hour cooldown after a direct transfer.
- A fixed-price SOL Marketplace for eligible Silver Rings and sealed Silver Boxes.

**ERT** is an off-chain game resource. **ERU** and Silver assets use Solana Devnet. The game verifies finalized blockchain results before reflecting them in play. Players need Devnet test SOL for blockchain network fees.

The current [Public Alpha Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) describes the test version in more detail. Future ideas such as Match-3, staking, gemstones, Gold and Platinum progression, and further rarity changes are not presented as available Alpha features.

## About this repository

This is a curated public project and hackathon-review mirror, with independent Git history. Its `backend/`, `android/` and `programs/` directories are an **older, bounded source sample**, not the complete code for the live Public Alpha. The public documentation above describes the current product; the sample code remains historical. No command in this repository starts the full current game.

See the [mirror manifest](PUBLIC_MIRROR_MANIFEST.md), [architecture overview](docs/ARCHITECTURE.md), [hackathon disclosure](docs/HACKATHON.md) and [security overview](docs/SECURITY_MODEL.md). The superseded Whitepaper v0.2 remains in Git history, outside the current document tree.

EtheRings is founder-built by Alexey. Mainnet and additional game modes are future work and require separate decisions.

## License

MIT — see [LICENSE](LICENSE).
