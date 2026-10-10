# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

EtheRings is an Android game where walking helps you collect and improve rings. A pair of eligible rings can earn you a sealed box; opening it reveals another ring. Certain items can also be sent or sold to other players.

[Download the Android test app](https://app.etherings.xyz/download/android/etherings.apk) · [Watch the demo](https://youtube.com/shorts/-swQa1foF2M?feature=share) · [Website](https://etherings.xyz/) · [Read the Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf)

## How the game works

The current test has **Cooper** rings, which are game items, and **Silver Ring NFTs**, which belong to your wallet. A sealed **Silver Box NFT** can be opened to receive a ring NFT.

1. Walk with your phone. Steps accepted by the game earn **ERT**, a resource used to play.
2. Collect rings, improve them and try your luck in Draw.
3. Use a pair of eligible game rings to receive a sealed box NFT. Open it to reveal a ring NFT. Boxes can also come from other game rewards.
4. Keep wallet items, send eligible ones to another player or offer them for a fixed price in the Marketplace. A direct transfer starts a 48-hour game cooldown.

Some actions also use **ERU**, a test token. The [Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) explains the rules and costs in detail.

## Try the Public Alpha

The Android app is in public testing on **Solana Devnet**, a test network. All balances and items in this test have no real monetary value. Features and prices may change, and testers may encounter bugs.

Install the app, verify your email and create or restore a wallet. Save your wallet recovery phrase somewhere safe: we cannot recover it for you. Some wallet actions require Devnet test SOL to cover network fees.

If you still have the old EtheRings MVP installed, uninstall it before installing Public Alpha. Uninstalling removes that old app's local data, including steps it has not sent yet. If you already use Public Alpha, follow the app's update instructions to install a newer compatible version over it.

Today you can track activity, use Draw, improve rings, breed eligible pairs, open boxes, transfer eligible items and use the Marketplace. Ideas such as Match-3, staking, gemstones and more kinds of rings are future plans, not features of this test.

## Why Solana?

The game records frequent activity, such as steps, in its own system. Solana records ownership of the NFTs. The player reviews and approves actions involving those items. The [architecture overview](docs/ARCHITECTURE.md) explains the design; the [security overview](docs/SECURITY_MODEL.md) explains how wallet actions are protected.

## What's in this repository?

This repository helps people explore the project. It is **not the complete source code of the current app**.

- [Current ring-rules example](current-alpha/README.md) shows how the game creates an initial ring and calculates the cost of using a pair to create a box.
- The backend, Android and Solana code folders contain selected code from an earlier hackathon stage. They do not build the current app.
- The [Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) describes today's test version. The [hackathon history](docs/HACKATHON.md) separates earlier work from work done during the event.

See the [published-code guide](PUBLIC_MIRROR_MANIFEST.md) for the exact scope. The sample has [simple local test instructions](current-alpha/README.md); there is no command here to start the full game. EtheRings is built by Alexey.

## License

MIT — see [LICENSE](LICENSE).
