# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**Move. Play. Collect.**

EtheRings is an Android game where your everyday steps help you build a collection of Rings. Walk to earn resources, decide how to use them, try your luck in Draw, and discover collectible Silver Ring NFTs that live in your Solana wallet.

**The Public Alpha is live on Android 9+ and Solana Devnet.** Come play, explore what's working, and help us make the game better.

[**Download Public Alpha**](https://app.etherings.xyz/download/android/etherings.apk) · [**Join our Discord**](https://discord.gg/5jQzegWuhz) · [Latest release](https://github.com/Alexrok4834/Etherings-public/releases/latest) · [Website](https://etherings.xyz/) · [Alpha Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf)

## What can you do in Alpha?

**Walk and earn.** EtheRings tracks activity on your Android phone. Steps accepted by the game earn **ERT**, a resource you can use in gameplay.

**Choose your next move.** Save ERT to level up your Rings, or spend it on **Draw** for a chance to receive more ERT, ERU, a Cooper Ring, or a sealed Silver Box NFT.

**Build your Ring collection.** You start with a **Cooper Ring**. Cooper and Silver Rings can both be leveled up, and leveling gives you Points to improve their attributes. Once your wallet is ready, you can also receive your first **Silver Box NFT** and open it to discover a **Silver Ring NFT**.

**Turn progress into new Rings.** In the current Alpha, two eligible **Level 20 Cooper Rings** can be used to create a sealed Silver Box NFT. Opening it reveals a Silver Ring NFT with its own design and attributes.

**Own and trade NFTs.** Keep eligible Silver Rings and Boxes in your wallet, send them to another player, or list them in the **Marketplace** for a fixed price in test SOL. Transfer restrictions and cooldowns apply; see the [Alpha Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) for the rules.

Walking starts the loop. What you collect, improve, open, and trade is up to you.

## Get started

1. **Download the Android Alpha** (Android 9 or newer) and register with your email.
2. **Confirm your email and set up your wallet.** You can create a new wallet or restore one you already control.
3. **Equip a Ring and explore.** Start walking, check your ERT, try Draw, and see how your collection grows.

Some blockchain actions require **Devnet SOL** for network fees. You can get test SOL from the official Solana Devnet faucet. Never send real Mainnet SOL to a test wallet expecting it to arrive on Devnet.

**Keep your wallet recovery phrase private.** Save it somewhere safe. No one from EtheRings support will ever need it, and we cannot recover it for you.

**Coming from the old MVP?** Uninstall the MVP before installing Alpha. Your MVP account, balances, and progress do not transfer into the new Alpha. Uninstalling the old app also removes unsent local data. If you're already using Public Alpha, install compatible updates over the current app to keep its local data.

## A quick note about the blockchain

You don't need to understand blockchain technology to start playing.

In the current Alpha, **Cooper Rings** are items in your game account. **Silver Rings and sealed Silver Boxes** are NFTs held in your own wallet on **Solana Devnet**. **ERT** is an in-game resource, while **ERU** is a Devnet test token used in selected game actions. Marketplace transactions use Devnet SOL.

**This is a test, not a Mainnet release.** Devnet assets and balances have no real monetary value. The economy and gameplay may change during testing, and Alpha assets or progress are not guaranteed to carry over to Mainnet.

## Help shape EtheRings

We're looking for real player feedback, not just a list of completed downloads. Tell us what feels fun, what feels confusing, what breaks, and what you'd like to do more of.

Join the [EtheRings Discord](https://discord.gg/5jQzegWuhz) for testing updates and bug reports. If you report a wallet-related issue, share only your **public wallet address** — never a seed phrase or private key.

**In Rings We Trust.**

## Explore the project

Want to dig deeper? The [Public Alpha Whitepaper](docs/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf) explains the current game rules, costs, and limits. It describes the Alpha as of **6 October 2026**; some details may have changed in subsequent app updates.

For technical readers and hackathon judges:

- [Build the Android app](docs/BUILD.md)
- [Development and release history](docs/RELEASE_HISTORY.md)
- [Changes in each version](CHANGELOG.md)
- [Known issues](docs/KNOWN_ISSUES.md)
- [Architecture overview](docs/ARCHITECTURE.md) and [security overview](docs/SECURITY_MODEL.md)
- [Hackathon history and disclosure](docs/HACKATHON.md)
- [What is included in the source](PUBLIC_MIRROR_MANIFEST.md)

## Code you can explore

The repository now includes the Android app from the earlier MVP through the current Public Alpha, the MVP and Alpha game servers, the web client, the Solana programs, and their relevant tests. The folders follow the shape of the [hackathon example](https://github.com/Marakaya/colosseum_example): open a part of the product, read its code, then use the [build guide](docs/BUILD.md) to try it yourself.

| Folder | What you will find |
| --- | --- |
| [`android/`](android/) | The player app. Its MVP and Alpha screens live in the same Android project. |
| [`backend/`](backend/) | The earlier MVP game server and shared Alpha rules. |
| [`backend-alpha/`](backend-alpha/) | The current Alpha game server, database changes and tests. |
| [`frontend/`](frontend/) | The MVP web and administration client. |
| [`programs/`](programs/) | Solana program source and development projects. |
| [`android-alpha-prototype/`](android-alpha-prototype/) | The separate Android prototype used during Alpha development. |

Real service passwords, wallet keys, private RPC addresses, deployment settings and player data are not part of the published source. You can build the app with your own local signing key; that build cannot have the signature of the APK we distribute. The [source guide](PUBLIC_MIRROR_MANIFEST.md) describes the boundary precisely.

EtheRings is built by Alexey. Contact: [founder@etherings.com](mailto:founder@etherings.com). Follow development and Alpha updates on [X](https://x.com/etherings2earn).

## License

MIT — see [LICENSE](LICENSE).
