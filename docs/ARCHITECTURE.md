# EtheRings Alpha Architecture

## Design principle

EtheRings does not put every game action on-chain.

| Domain | Authority |
| --- | --- |
| Steps / anti-cheat / M2E eligibility | Backend |
| ERT | PostgreSQL ledger |
| Cooper Rings | Backend game state |
| Alpha accounts / reservations / reconciliation | Backend + PostgreSQL |
| ERU | Solana Token-2022 |
| Silver Box / Silver Ring ownership | Solana Token-2022 |
| Silver typed gameplay state | EtheRings Solana program |
| User authorization for on-chain value changes | Embedded self-custodial Android wallet |
| Project program/config administration | Squads V4 2-of-3 on test networks |

## Mobile wallet boundary

Alpha uses a classic embedded self-custodial wallet:

- Trust Wallet Core 4.8.2;
- BIP-39;
- Solana derivation path m/44'/501'/0'/0';
- mnemonic encrypted locally with Android Keystore-backed AES-GCM wrapping;
- ordinary Ed25519 signing;
- backend stores only public wallet binding and signed-operation evidence.

An application login is not wallet signing authority.

## ERU settlement

A fee-bearing ERU operation keeps the mechanic's principal intact and adds a 2% platform commission.

~~~text
principal: 30 ERU
user debit: 30.6 ERU
principal leg: 30 ERU
treasury fee leg: 0.6 ERU
~~~

The Gateway and Transfer Hook enforce the exact operation context. Reward distribution is narrowly exempt from the platform fee.

## Hybrid operations

PostgreSQL and Solana are not one atomic system.

Hybrid operations use:

1. immutable business operation IDs;
2. exact backend reservations;
3. signed on-chain intent;
4. Solana atomicity for required on-chain legs;
5. finality validation;
6. exactly-once local finalization;
7. reconciliation after timeout, process crash or ambiguous RPC results.

Ambiguity is represented as UNKNOWN. It is not treated as proof of failure.

## Silver lifecycle

~~~text
first-entry or approved game entitlement
        ↓
Silver Box
        ↓
Token-2022 ownership + typed Silver state
        ↓
direct transfer → 48h gameplay/listing cooldown
        ↓
Box reveal / no-reroll
        ↓
Silver Ring
        ↓
progression / M2E / marketplace
~~~

A direct non-marketplace transfer between distinct token accounts starts or resets the 48-hour cooldown under the current Alpha rule.

## Governance

User custody and project administration are separate.

- Users control their own wallet keys.
- Project test program/config authority uses Squads V4 with a 2-of-3 threshold.
- A single project signer is insufficient for governed Silver administration.
- Devnet/Testnet identities do not imply Mainnet authority policy.

## Product integration

The Alpha proof modules are not intended to become a second permanent game. Accepted capabilities are integrated into the existing EtheRings Android/backend product while the current production MVP remains live until Alpha release.
