# EtheRings Product & Technical Architecture

## 1. Product Architecture

EtheRings is a connected game economy built around movement, Rings, progression and collection utility.

Movement creates resources, but the long-term loop is driven by what players can do with their Rings and resources after they earn them.

### Core systems

- **M2E** — real-world movement feeds the game economy.
- **ERT** — primary game resource used throughout progression and gameplay.
- **ERU** — blockchain-connected economy asset used for selected economic, progression and reward flows.
- **NFT Rings** — the core collectible/gameplay asset.
- **Mint** — expands the collection through resource-driven creation mechanics.
- **Level Up** — develops Rings and their attributes.
- **Rarity Upgrade** — extends long-term collection progression.
- **Staking** — gives owned NFTs passive collection utility.
- **Match-3** — uses Rings and their attributes in active gameplay.
- **Raffle** — connects game resources with rewards and collectible outcomes.
- **Marketplace** — enables player-to-player exchange of blockchain assets.

### Economy map

~~~text
M2E
 │
 ▼
ERT ───────────────┬───────────────┬─────────────────┐
                   │               │                 │
                   ▼               ▼                 ▼
               Level Up           Mint        Rarity Upgrade
                   ▲               ▲                 ▲
                   │               │                 │
                   └───────────┐   │   ┌─────────────┘
                               │   │   │
                            ┌──┴───┴───┴──┐
                            │     NFT     │
                            └──┬────┬───┬─┘
                               │    │   │
                 ┌─────────────┘    │   └───────────────┐
                 ▼                  ▼                   ▼
              Staking            Match-3             Raffle
                 │                  │                   │
                 └──────────┬───────┘                   │
                            ▼                           │
                           ERU ◄────────────────────────┘

NFT ↔ Marketplace
~~~

This diagram is intentionally product-level. Exact costs, rewards and mechanic-specific settlement rules are defined separately.

### Core design principle

EtheRings is not a "walk for a token" product.

The intended loop is:

**Move → Earn → Play → Progress → Collect → New Utility → Repeat**

Movement introduces resources. The collection creates the long-term reason to keep playing.

---

## 2. Blockchain Role

Blockchain is used selectively.

### Off-chain

These remain server-authoritative because they are frequent, real-world, or anti-abuse-sensitive:

- step evidence;
- activity validation;
- anti-cheat;
- high-frequency gameplay logic;
- ERT accounting;
- selected game-state reservations and reconciliation.

### On-chain

Solana is used where verifiability and user ownership matter:

- ERU;
- NFT identity and ownership;
- selected NFT gameplay state;
- transfer restrictions;
- user-authorized economic actions;
- marketplace settlement;
- provenance.

This keeps blockchain complexity out of actions that do not benefit from it.

---

## 3. Player Flow

From the player's perspective, Web3 should remain mostly invisible.

~~~text
Create account
     ↓
Play / Move
     ↓
Earn resources
     ↓
Develop collection
     ↓
Use Rings in game mechanics
     ↓
Trade / collect / progress
~~~

When an on-chain value-changing action is required:

~~~text
Game action
    ↓
Exact intent prepared
    ↓
Player reviews intent
    ↓
Embedded wallet signs locally
    ↓
Solana execution
    ↓
Backend verifies finality
    ↓
Game state reconciles
~~~

The backend never needs the user's mnemonic or private key.

---

## 4. Technical Architecture

~~~text
┌─────────────────────────┐
│       Android App       │
│                         │
│ UI / gameplay / steps   │
│ embedded wallet         │
│ local transaction review│
└────────────┬────────────┘
             │ HTTPS
             ▼
┌─────────────────────────┐
│      Game Backend       │
│                         │
│ auth                    │
│ M2E                     │
│ ERT                     │
│ game state              │
│ reservations            │
│ reconciliation          │
└───────┬─────────┬───────┘
        │         │
        ▼         │ exact operation
  PostgreSQL      │
                  ▼
         ┌─────────────────┐
         │ Android Wallet  │
         │ local signing   │
         └────────┬────────┘
                  │ signed transaction
                  ▼
         ┌─────────────────┐
         │     Solana      │
         │                 │
         │ ERU             │
         │ NFT assets      │
         │ transfer rules  │
         │ settlement      │
         └────────┬────────┘
                  │ finalized chain evidence
                  ▼
           Backend reconciliation
~~~

---

## 5. Wallet Boundary

Alpha uses a classic embedded self-custodial Solana wallet:

- Trust Wallet Core 4.8.2;
- BIP-39;
- derivation path `m/44'/501'/0'/0'`;
- mnemonic encrypted locally with Android Keystore-backed AES-GCM;
- Ed25519 user signing;
- backend stores public binding/evidence, not the wallet secret.

Application login alone is not signing authority.

---

## 6. ERU Settlement

A fee-bearing ERU operation preserves the mechanic's principal and adds the platform commission separately.

~~~text
principal: 30 ERU
user debit: 30.6 ERU
principal: 30 ERU
platform fee: 0.6 ERU
~~~

The current Alpha implementation uses a Gateway + Token-2022 Transfer Hook enforcement model.

Rewards use a narrowly defined exemption so the player receives the full stated reward.

---

## 7. Hybrid Operations

PostgreSQL and Solana do not form one atomic transaction.

Cross-system actions use:

1. immutable operation identity;
2. exact backend reservation;
3. user-signed on-chain intent;
4. atomic Solana legs where required;
5. finality validation;
6. exactly-once backend finalization;
7. reconciliation after timeout or ambiguous RPC outcomes.

An ambiguous result is represented as **UNKNOWN**, not silently treated as failure.

---

## 8. NFT Transfer State

NFT transfer rules are enforced by the on-chain asset program rather than only by Android UI.

For the current Alpha model, a qualifying direct transfer starts or resets a **48-hour gameplay/listing cooldown**.

This gives ownership transfers a game-state consequence that is verifiable independently of the client.

Marketplace transfers use a separately authenticated settlement context.

---

## 9. Governance

User custody and project administration are different trust boundaries.

- Players control their own wallet keys.
- Test program/config administration uses Squads V4 with a 2-of-3 threshold.
- One project signer alone is insufficient for governed program/config changes.
- Devnet governance is not automatically the Mainnet governance model.

---

## 10. Product Integration

The blockchain Alpha is not intended to become a permanent second EtheRings product.

The current MVP remains live while Alpha functionality is developed and proven in isolation.

Accepted Alpha capabilities are integrated into the existing Android/backend product so the released Alpha becomes the next version of EtheRings.
