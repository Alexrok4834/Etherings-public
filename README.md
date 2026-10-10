# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

EtheRings is an Android game where movement feeds game resources, Rings connect collecting and progression, and Solana supports ownership and player-approved actions.

[Download Public Alpha for Android](https://app.etherings.xyz/download/android/etherings.apk) · [Website](https://etherings.xyz/) · [Current Whitepaper (PDF)](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) · [Demo video](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [X](https://x.com/etherings2earn)

## The game in one minute

1. Walk with the Android app. Accepted activity earns ERT, a game resource.
2. Use game resources in Draw and Ring progression. Collect and improve Cooper Rings.
3. Breed eligible Cooper Rings to create a Silver Box, then open the Box to receive a Silver Ring. Silver Boxes can also arrive through other available game rewards.
4. Own eligible Silver assets in your wallet. You can transfer them or offer them in the fixed-price Marketplace, subject to the game's rules.

The goal is to connect everyday movement, collection and progression with player-controlled digital items. Solana is used for Silver ownership and approved wallet actions; frequent steps and game accounting remain in the game backend. See the [product and technology overview](docs/ARCHITECTURE.md) for the boundary between the two.

**Start here:** [watch the demo](https://youtube.com/shorts/-swQa1foF2M?feature=share), [try the Android Alpha](https://app.etherings.xyz/download/android/etherings.apk), then read the [Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) for the rules and planned direction.

## Public Alpha is live

The current public test runs on **Solana Devnet**. Its SOL, ERU and Silver assets are test assets. Public Alpha is an evolving test version: mechanics, limits, prices and the economy may change. It is not a Mainnet release.

The earlier Android MVP is historical and retired. It is not the current download. **Uninstall the MVP before installing Public Alpha**; uninstalling removes local MVP data, including any unsent steps. Players who already have Public Alpha can install later compatible builds over their existing installation when instructed.

To try the Alpha, install the Android app, register and verify an email address, and create or restore a wallet. Keep the wallet recovery phrase safe: the project cannot restore it for you. Blockchain actions need Devnet test SOL for network fees; Devnet assets have no Mainnet value. The game is still in public testing, so an available feature may have a reported bug.

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

This is a curated public project and hackathon-review mirror, with independent Git history. [`current-alpha/`](current-alpha/README.md) contains a small runnable sample of current Cooper rules. The `backend/`, `android/` and `programs/` directories are an **older, bounded source sample**, not the complete code for the live Public Alpha. No command in this repository starts the full current game.

See the [mirror manifest](PUBLIC_MIRROR_MANIFEST.md), [architecture overview](docs/ARCHITECTURE.md), [hackathon disclosure](docs/HACKATHON.md) and [security overview](docs/SECURITY_MODEL.md). The superseded Whitepaper v0.2 remains in Git history, outside the current document tree.

| Looking for | Where to go |
| --- | --- |
| What players can do now | This README and the [current Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) |
| How game state and Solana fit together | [Architecture overview](docs/ARCHITECTURE.md) |
| Wallet and transaction safety | [Security overview](docs/SECURITY_MODEL.md) |
| What predates the hackathon | [Hackathon disclosure](docs/HACKATHON.md) |
| What source is published | [Current Cooper sample](current-alpha/README.md), [mirror manifest](PUBLIC_MIRROR_MANIFEST.md) and the README in each code directory |

The current Cooper sample has [local test instructions](current-alpha/README.md) and needs no network or database. The historical backend sample also has [local test instructions](backend/README.md), but requires a disposable PostgreSQL database. The Android and Solana code directories are selected source samples, not standalone builds of the current release. There is currently no full-app quick-start command in this mirror; the downloadable APK and the Whitepaper are the ways to review the current Alpha.

EtheRings is founder-built by Alexey. Mainnet and additional game modes are future work and require separate decisions.

## License

MIT — see [LICENSE](LICENSE).
