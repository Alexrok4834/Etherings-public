# EtheRings

![EtheRings logo](assets/etherings-logo-gold.png)

**In Rings We Trust**

*Move. Play. Collect.*

EtheRings is one mobile game developed through successive versions. Real-world
movement feeds progression, Rings connect gameplay and collecting, and selected
assets use a verifiable on-chain ownership model.

## Current status — 2026-09-28

The first public Alpha test is being prepared. Its launch date and first-build
contents have not been announced. Do not infer public availability from
development builds, local checks, or Devnet validation.

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
- Silver Level-Up prices, the additive 2% ERU fee, +6 Points, and their
  implementation status are documented in the [Whitepaper](docs/ETHERINGS_WHITEPAPER_V0_2.md).

These rules describe the full approved model, not a claim that every mechanic
is available to public testers. Alpha functionality is being added and checked
in stages. Checks for features included in the first build and overall launch
security remain required. Mainnet is a separate future release with its own
approval and launch gates.

## Documents

- [EtheRings Whitepaper v0.2](docs/ETHERINGS_WHITEPAPER_V0_2.md)
- [Crypto World's Fair 2026 disclosure](docs/HACKATHON.md) — historical
  submission context; consult the current status above and the Whitepaper.

## License Notice

Source and materials in this repository are provided for project review.
No open-source license is granted unless a LICENSE file explicitly states
otherwise.
