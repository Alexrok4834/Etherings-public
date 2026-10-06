# EtheRings Whitepaper v0.2

> **HISTORICAL / SUPERSEDED.** This September 2026 document is retained for
> project history and does not describe the current Public Alpha. Read the
> [current Public Alpha Whitepaper (PDF)](https://etherings.xyz/EtheRings_Public_Alpha_Whitepaper_2026-10.pdf)
> for the live Devnet test version. Future features mentioned below are not
> claims of current availability.
## Move. Play. Collect.

**Version:** 0.2\
**Updated:** September 29, 2026

This version describes the staged MVP-to-Alpha transition. ERT remains
off-chain, while Alpha ERU uses Solana. Account and economy state do not
automatically migrate between MVP, Alpha and a future Mainnet release.
The embedded wallet signs user-approved operations; Silver prices below
describe the approved model, not a claim that Silver progression is available.

---

## Disclaimer and Document Status

This Whitepaper describes the current vision of EtheRings, its product architecture, game mechanics, economy, and development plans as of the publication date of the relevant version.

EtheRings is an evolving product. The project owner reserves the right to amend, expand, clarify, replace, or remove any part of this Whitepaper at any time as the product, technology, game economy, security requirements, legal environment, and development priorities evolve.

Future mechanics, tokenomics, parameters, roadmap items, timelines, integrations, economic rules, and other elements described as planned or in development are not immutable commitments unless explicitly stated otherwise.

Each newly published official version of the Whitepaper supersedes previous versions with respect to the current description of the product.

Historical versions of the Whitepaper may remain publicly available for transparency and to document the evolution of the project; however, only the latest officially published version should be treated as the current description of EtheRings.

---

## 1. Introduction

**EtheRings is a mobile game built around three connected principles: Move. Play. Collect.**

EtheRings combines real-world physical activity, gameplay, progression through a collection of Rings, digital ownership, and a game-asset economy into one connected system.

Movement in EtheRings is not the whole game and not the final goal. It is one of the ways players interact with the game world.

Players receive game resources for real-world activity, use those resources across game mechanics, develop and collect Rings, unlock new utility for their collection, and gradually build persistent long-term progression.

EtheRings is being developed with the lessons of previous generations of Move-to-Earn products in mind. Those projects demonstrated that real-world physical activity can become part of a digital game economy, while also exposing the limitations of models in which financial rewards become the primary reason for participation.

EtheRings takes a different approach:

**Move creates resources.**\
**Play gives those resources purpose.**\
**Collect turns progression into a persistent collection.**
**Blockchain makes ownership, provenance, and exchange of digital assets verifiable.**

---

## 2. EtheRings Vision

The goal of EtheRings is to create a game where movement, gameplay, and collecting do not exist as disconnected systems.

Instead of a "walk for a token" model, EtheRings is designed around a connected game loop:

**Move → Resources → Play → Progress → Collect → New Utility → Repeat**

Rings sit at the center of this system. The same Ring can participate in Move-to-Earn, progression, future game modes, the collection system, marketplace activity, staking mechanics, and lore.

Blockchain is used only where it creates meaningful additional value for the game: verifiable ownership, provenance, scarcity, transfer, settlement, and user-authorized economic actions.

Steps, anti-cheat, and high-frequency game logic should not be moved on-chain merely for the sake of using blockchain.

---

## 3. The Three Product Pillars

### 3.1 Move

A player's physical activity creates game resources and contributes to progression.

EtheRings does not require players to start a dedicated walking session at a specific time. Players move as part of everyday life, and validated activity is used by the game systems.

Move-to-Earn in EtheRings is an entry point into the game economy, not the entire game.

### 3.2 Play

Players use earned resources, Rings, and other items in game mechanics.

The earlier MVP version includes Draw/Raffle. The next major gameplay stage, Beta, expands Play through Match-3, where Rings and other game items directly affect gameplay and rewards.

### 3.3 Collect

Rings and other game assets form a persistent player collection.

The collection matters as more than a set of images or NFTs. It is connected to:

- rarity;
- attributes;
- progression;
- game mechanics;
- marketplace;
- future RingShow / staking;
- blockchain ownership;
- provenance;
- special collections;
- lore.

---

## 4. Product Evolution

EtheRings is developed in stages. Each stage expands the previous one rather than replacing it.

### 4.1 MVP — Earlier Product Version

The Android MVP is the earlier off-chain version of the same EtheRings product. Its planned shutdown is separate from preparing the public Alpha test. Do not treat an MVP build or APK as the Alpha test build. The MVP's availability during the transition must be confirmed from the public service; no MVP APK is designated as Alpha.

Core loop:

**Move → Earn → Draw → Collect → Progress**

The MVP includes:

- Android application;
- automatic step tracking;
- server-authoritative Move-to-Earn validation;
- off-chain ERT and ERU;
- Draw/Raffle;
- off-chain Cooper Rings;
- inventory;
- equip/selection;
- progression;
- public Android testing.

Blockchain runtime in the earlier off-chain MVP version is not the source of ownership or balances for game assets.

### 4.2 Alpha — Staged Development and Public Test

Alpha adds a blockchain layer to the already functioning mobile product.

Alpha starts with new accounts and no inherited user balances/state: MVP users, credentials,
ERT/ERU, Cooper, progression, sessions and other gameplay data do not migrate.
This is a clean start of user/economy/runtime state, not a new permanent product
or a rebuild of the existing game. Alpha is planned as an update of the
existing EtheRings Android application, reusing gameplay, step tracking,
Draw, Rings, profile and update experience while adding blockchain functions.
The development build and service are separate from a public release.
Compatible signing, safe local-state transition and rollback remain release
requirements.
The owner plans to stop MVP service as part of the staged Alpha transition.
Actual service availability and the launch procedure must be confirmed
separately. MVP runtime then becomes frozen historical/baseline evidence; its
production database and artifacts are not deleted by this decision. New Alpha registration
uses a unique email and safely hashed password, one-time expiring email code,
resend/attempt rate limits and enumeration-resistant responses. Only verified
accounts can access gameplay, economy or wallet; email verification is an
anti-abuse layer, not complete Sybil protection.

The goal of Alpha is to validate a complete user-facing blockchain flow rather than build an isolated Web3 prototype outside the game.

**First public Alpha test:** the public test is being prepared. Its launch date
and first-build contents have not been announced. Development builds are not
public releases.

**Further Alpha development:** approved functionality will be added and
validated in stages after the first public test.

**Demonstrated in the test-only Alpha build:** registration with an email
confirmation code, embedded wallet creation, Box opening into a Silver NFT,
Ring attributes and selection, step tracking with ERT credit and activity
history, and Cooper Level-Up with an ERU-paid transition. This is development
status, not the announced contents of the first public build. Silver
Level-Up remains under development.

The full approved Alpha model includes:

- Solana integration;
- off-chain ERT in the Alpha game ledger and on-chain ERU in clean-start Alpha;
- classic embedded self-custodial Solana wallet with user Ed25519 signing;
- user-funded test-SOL network fees on Devnet/Testnet; no mandatory transaction sponsorship;
- Silver Ring Boxes;
- Silver Rings;
- on-chain ownership;
- on-chain Ring gameplay state;
- Cooper → Silver Box test flow;
- Silver progression;
- backend ↔ blockchain reconciliation;
- internal fixed-price SOL marketplace.

### 4.3 Beta — Full Expansion of Play

Beta expands the gameplay layer of EtheRings.

A key Beta feature is Match-3, where Rings, their attributes, and other game items directly affect gameplay.

Beta also connects the product more deeply with lore and expands collection utility beyond Move-to-Earn and progression.

### 4.4 Mainnet / Release

Mainnet release moves EtheRings from a test blockchain architecture into a production economy.

Mainnet is another clean start. No Alpha/Devnet/Testnet account, off-chain or
on-chain balance/state, ERT/ERU, Cooper, Silver Box/Ring/NFT, level, Point,
attribute, progression, wallet binding or test mint/program/collection identity
migrates. There is no bridge, snapshot, `1:1` conversion, redemption,
compensation or default Mainnet-asset entitlement. Mainnet uses a new
production database/state, deployments, mints/collections/program identities
and separate economy. Actual launch/reset needs its own approved procedure;
no MVP, Alpha or test data is deleted now.

At this stage, production rules for ownership, collections, marketplace activity, and rarity progression are expected to be introduced.

Testnet-only Alpha mechanics do not have to remain as production game rules.

---

## 5. Rings — The Core Game Object

Rings are the primary persistent objects in EtheRings.

They connect Move, Play, and Collect.

A Ring has:

- rarity;
- level;
- attributes;
- Points;
- Shine;
- progression history;
- visual identity;
- ownership state;
- utility across different game systems.

Starting from NFT rarities, a Ring can also have blockchain ownership and provenance.

---

## 6. Rarity System

EtheRings uses five Ring rarity tiers.

| Rarity | Attribute range | Points per level | Asset model |
|---|---:|---:|---|
| **Cooper** | 2–20 | +4 | Off-chain game Ring |
| **Silver** | 10–30 | +6 | NFT Ring |
| **Gold** | 20–40 | +8 | NFT Ring |
| **Platinum** | 40–60 | +10 | NFT Ring |
| **Unique** | Individual | Individual | Special lore-linked NFT Ring |

**Cooper** is the canonical name of the base EtheRings rarity.

A Cooper Ring is not an NFT.

Silver, Gold, Platinum, and Unique belong to the NFT collection layer.

Unique is a separate special rarity. The EtheRings lore includes **6 Unique Rings**. Their attributes and utility may be defined individually and do not have to follow the standard ranges used by normal rarities.

Unique is not treated as a normal next step in the standard transformation chain.

---

## 7. Attributes

Each Ring uses five core attributes.

### Comfort

Determines Move-to-Earn efficiency and affects ERT earned from validated physical activity.

### Charm

Connected to the future **RingShow / NFT staking** mechanic.

### Quality

Connected to game modes, particularly future Match-3 gameplay and its reward logic.

### Luck

Connected to chance-based mechanics, including raffle opportunities and the probability of receiving certain game items or rewards in gameplay.

### Shine

Shine represents Ring durability.

The base value of a new Ring is **100**.

Shine decreases when the Ring is used in mechanics that consume durability and can be restored by spending ERT.

Shine cannot exceed 100.

Exact Shine consumption and restoration rules must be published together with the mechanics that use them.

---

## 8. Move-to-Earn

Move-to-Earn connects validated physical activity to the game economy.

### 8.1 Daily Step Limit

Base daily limit:

- 1 Ring → 5,000 steps;
- each additional eligible Ring → +1,000 steps to the daily limit.

The authoritative calculation must be performed by the server according to ownership and eligibility rules.

### 8.2 ERT Earning

ERT earned depends on validated activity and the Comfort attribute of the active Ring.

The complete ERT formula and balancing must be published separately as an approved economy rule and must not be inferred from UI or client-side calculations.

### 8.3 Anti-Cheat

Step evidence, anti-cheat, and reward eligibility remain off-chain and server-authoritative.

Blockchain is not used as a pedometer database.

---

## 9. Ring Progression

The maximum standard Ring level is **Level 20**.

When a Ring levels up, the player receives Points:

- Cooper: +4;
- Silver: +6;
- Gold: +8;
- Platinum: +10.

Points are used to develop the main attributes:

- Comfort;
- Charm;
- Quality;
- Luck.

Shine is not an allocatable attribute Point.

Cooper Level-Up is implemented in the test-only Alpha build. Its approved
transition prices are listed here so players can see the whole model. An ERU
payment includes a separate additive 2% fee. Each Cooper transition grants
four Points.

### 9.1 Cooper Level-Up prices

| Transition | ERT | ERU principal | ERU fee (2%) | Total ERU debit | Points |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1→2 | 12 | 0 | 0 | 0 | +4 |
| 2→3 | 16 | 0 | 0 | 0 | +4 |
| 3→4 | 20 | 0 | 0 | 0 | +4 |
| 4→5 | 24 | 30 | 0.60 | 30.60 | +4 |
| 5→6 | 28 | 0 | 0 | 0 | +4 |
| 6→7 | 32 | 0 | 0 | 0 | +4 |
| 7→8 | 36 | 0 | 0 | 0 | +4 |
| 8→9 | 40 | 0 | 0 | 0 | +4 |
| 9→10 | 44 | 0 | 0 | 0 | +4 |
| 10→11 | 48 | 0 | 0 | 0 | +4 |
| 11→12 | 52 | 0 | 0 | 0 | +4 |
| 12→13 | 56 | 0 | 0 | 0 | +4 |
| 13→14 | 60 | 0 | 0 | 0 | +4 |
| 14→15 | 64 | 0 | 0 | 0 | +4 |
| 15→16 | 68 | 0 | 0 | 0 | +4 |
| 16→17 | 72 | 0 | 0 | 0 | +4 |
| 17→18 | 76 | 0 | 0 | 0 | +4 |
| 18→19 | 80 | 0 | 0 | 0 | +4 |
| 19→20 | 84 | 60 | 1.20 | 61.20 | +4 |

Sequential levels 1→20 cost 912 ERT and 90 ERU principal (91.80 ERU
including fees), granting 76 Points. Earlier signed or completed operations
are not repriced.

### 9.2 Silver Level-Up prices — approved, not yet implemented

Each row is one transition to the target level. ERT is the final approved base price (the prior 25% uplift and half-up rounding are already included; do not apply them again). A 2% ERU fee applies to ERU principal; total ERU debit is principal plus fee. Silver receives +6 Points per successful level transition. Cooper prices and rules are unchanged. Previously signed or executed operations are not repriced.

| Transition | ERT | ERU principal | ERU fee (2%) | Total ERU debit | Points |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1→2 | 15 | 0 | 0 | 0 | +6 |
| 2→3 | 20 | 0 | 0 | 0 | +6 |
| 3→4 | 25 | 0 | 0 | 0 | +6 |
| 4→5 | 30 | 38 | 0.76 | 38.76 | +6 |
| 5→6 | 35 | 0 | 0 | 0 | +6 |
| 6→7 | 40 | 0 | 0 | 0 | +6 |
| 7→8 | 45 | 0 | 0 | 0 | +6 |
| 8→9 | 50 | 0 | 0 | 0 | +6 |
| 9→10 | 55 | 0 | 0 | 0 | +6 |
| 10→11 | 60 | 0 | 0 | 0 | +6 |
| 11→12 | 65 | 0 | 0 | 0 | +6 |
| 12→13 | 70 | 0 | 0 | 0 | +6 |
| 13→14 | 75 | 0 | 0 | 0 | +6 |
| 14→15 | 80 | 0 | 0 | 0 | +6 |
| 15→16 | 85 | 0 | 0 | 0 | +6 |
| 16→17 | 90 | 0 | 0 | 0 | +6 |
| 17→18 | 95 | 0 | 0 | 0 | +6 |
| 18→19 | 100 | 0 | 0 | 0 | +6 |
| 19→20 | 105 | 75 | 1.50 | 76.50 | +6 |

Sequential level 1→5 therefore totals 90 ERT and 38.76 ERU. Levels 1→20
grant 114 Silver Points. This separate table changes Silver prices only;
Cooper prices remain unchanged. Silver progression is still under development
and is not claimed as available to public testers.

---

## 10. Alpha/Testnet: Cooper → Silver Box

Alpha/Testnet uses a special mechanic to transition from an off-chain Cooper asset into an on-chain Silver asset.

**This is a testnet-specific mechanic and is not the intended Mainnet rarity-transformation model.**

### 10.1 Eligibility

The operation requires two Cooper Rings.

Both Rings must:

- belong to the user;
- be **Level 20**;
- have an available use counter;
- not be in a conflicting pending-operation state.

Each Cooper Ring may participate in this Alpha mechanic no more than **2 times during its lifetime**.

Valid pre-operation counters:

- `0`;
- `1`.

If a Ring counter is `2` or greater, the Ring is permanently exhausted for this mechanic.

### 10.2 Cost Matrix

Cost depends on the counters of both Cooper Rings before the operation.

| Counters | ERT principal | ERU principal | ERU fee | Total ERU debit |
|---|---:|---:|---:|---:|
| `0,0` | 150 ERT | 30 ERU | 0.6 ERU | 30.6 ERU |
| `0,1` | 200 ERT | 40 ERU | 0.8 ERU | 40.8 ERU |
| `1,0` | 200 ERT | 40 ERU | 0.8 ERU | 40.8 ERU |
| `1,1` | 250 ERT | 50 ERU | 1.0 ERU | 51.0 ERU |

These are operation-level amounts, not separate charges for each parent. The
ERT principal is reserved and finalized as an exact off-chain ledger debit.
The ERU principal is burned on Solana, and the additional 2% ERU platform
commission is transferred to the project treasury. Network costs are separate
and are not included in this table. The commission is not another breeding use
or an additional mint fee. See
[Fees, Royalties and Transaction Costs](#fees-royalties-and-transaction-costs).

The ERU burn, fee, replay protection, and Box issuance are atomic inside one
Solana transaction. PostgreSQL and Solana do not share one atomic transaction.
After verified chain finality, the ERT debit and both Cooper counters finalize
exactly once through reconciliation. Timeout or one missing-signature response
is an unknown state, not an automatic refund or reservation release.

A valid operation has a **100% success probability** after all eligibility and payment checks pass.

The parent Cooper Rings are not destroyed.

### 10.3 Result

The operation produces:

**2 Cooper Rings → 1 Silver Ring Box**

The Silver Ring Box is an on-chain asset.

Opening the Box creates a Silver Ring NFT.

### 10.4 Purpose of the Alpha Flow

This flow provides one complete vertical scenario for validating:

- off-chain eligibility;
- reconciled off-chain ERT and on-chain ERU settlement;
- user-controlled wallet authorization;
- user-funded test-network transaction flow;
- on-chain Box ownership;
- reveal/mint lifecycle;
- Silver NFT ownership;
- inventory synchronization;
- reconciliation.

---

## 11. Mainnet Ring Transformation

In production/Mainnet, Cooper-to-Silver progression follows a separate **Ring Transformation** system rather than the Alpha two-Cooper test flow.
It applies only to Cooper created under the future Mainnet economy; no MVP/Alpha Cooper or progression migrates into it.

Core transformation chain:

**Cooper → Silver → Gold → Platinum**

### 11.1 Cooper → Silver

For Mainnet, the planned model transforms one Level 20 Cooper Ring into a Silver Ring using the required game resources and alchemical items.

The transformation system includes:

- Alchemical Potion;
- Philosopher's Stone;
- required game tokens/resources;
- rarity-specific success rules.

The exact Mainnet asset-conversion contract, attribute-transfer behavior, treatment of the original Cooper Ring, and final costs must be approved before Mainnet transformation is implemented.

### 11.2 NFT Rarity Transformations

For later rarity transitions, transformation operates within the NFT collection layer:

**Silver → Gold → Platinum**

Transformation probability depends on Ring rarity and the parameter of the Alchemical Potion used.

The Potion is consumed when a transformation attempt is made, including a failed attempt, unless the final Mainnet contract explicitly defines otherwise.

Unique is not part of the standard transformation chain and is governed by separate lore/game rules.

---

## 12. Silver Ring Box

A Silver Ring Box is a separate on-chain collectible asset.

A Box can:

- belong to a user's self-custodial wallet;
- be transferred under blockchain ownership rules;
- be listed on the internal marketplace if its asset state allows it;
- be opened by its owner.

When opened:

- the Box moves to a terminal consumed state;
- exactly one Silver Ring NFT is created;
- the operation must prevent duplicate minting and replay;
- ownership and resulting state must be verifiable.

A new Silver Ring starts with:

- Level 1;
- Shine 100;
- 0 unspent Points;
- Comfort / Charm / Quality / Luck within the Silver rarity range of `10..30` under the approved randomness policy.

---

## 13. Draw / Raffle

Draw is one of the first EtheRings game mechanics and is already present in the MVP.

Players spend game resources to participate and receive a reward according to the configured pool.

In the broader Raffle ecosystem, reward pools may include:

- ERT;
- ERU;
- EtheRings game assets;
- Ring Boxes;
- Gemstones;
- Alchemical Potions;
- special digital collectibles;
- partner/collaboration assets.

On-chain NFT raffle rewards are not automatically considered an active Alpha feature: they require separate mint, ownership, and randomness contracts.

---

## 14. Match-3

Match-3 is a key planned Beta mechanic.

Its purpose is to turn the Ring collection from a passive set of assets into a direct part of gameplay.

The base concept includes:

- Match-3 board;
- use of Rings;
- use of game items;
- Quality affecting gameplay/rewards;
- Luck affecting chance-based rewards/items;
- Shine consumption during game actions;
- PvE/PvP development.

Match-3 should not be a separate mini-game disconnected from the collection.

**The collection must matter in gameplay.**

Exact reward amounts, matchmaking rules, PvP settlement, and balancing will be published together with the Beta specification.

---

## 15. Gemstones

Gemstones are collectible game assets that enhance the corresponding Ring attributes.

Types:

- **Ruby** → Comfort;
- **Emerald** → Charm;
- **Sapphire** → Quality;
- **Diamond** → Luck.

Four Gemstone quality levels are planned.

The historical model uses the following ranges:

- Level 1: 1–5;
- Level 2: 5–10;
- Level 3: 10–15;
- Level 4: 15–20.

The exact interpretation of shared boundaries (`5`, `10`, `15`), distribution, removal/replacement behavior, and final slot rules must be approved before production implementation.

Gemstones are planned as NFT assets.

---

## 16. Alchemical Potions

EtheRings includes four types of Alchemical Potions:

- Red;
- Green;
- Blue;
- White.

A Potion has its own success parameter.

The historical and current concept uses a success-value range from **5% to 90%**.

Potions are used in:

- Ring Transformation;
- Gemstone progression;
- future alchemical mechanics.

Four different Potion types may be used in a combine mechanic, spending ERU to obtain a stronger Potion.

Exact combine costs, output distribution, and production probabilities must be approved before the corresponding mechanic is implemented.

The blockchain/NFT status of Potions themselves is not automatically defined.

---

## 17. RingShow

**RingShow = NFT staking.**

RingShow uses NFT Rings and is connected to the Charm attribute.

The mechanic is intended to provide additional collection utility and support ERU-related economy.

Exact staking duration, reward formula, eligibility, and anti-abuse rules must be published before production activation.

---

## 18. Marketplace

The EtheRings Marketplace is designed for ownership and exchange of blockchain game assets.

The Alpha marketplace focuses on a clear fixed-price flow with SOL settlement.

Key principles:

- the user retains verifiable ownership;
- listings must respect asset eligibility and cooldown/state rules;
- purchases must perform settlement atomically;
- stale listings must not result in invalid sales;
- direct transfers and marketplace purchases may have different gameplay consequences.

In the long term, the marketplace may expand to include:

- EtheRings collections;
- collaborations;
- partner collections;
- selected external assets, where a compatible utility model is defined.

Open integration of third-party collections is a strategic direction, not a commitment to support every external NFT without separate review.

Marketplace price, fee, royalty, rounding, and network-cost treatment are
summarized in
[Fees, Royalties and Transaction Costs](#fees-royalties-and-transaction-costs).

---

## 19. Why Blockchain

EtheRings does not use blockchain merely for the sake of using Web3.

### Off-Chain

The following remain off-chain:

- step evidence;
- anti-cheat;
- high-frequency gameplay;
- eligibility calculations that cannot safely be trusted to the client;
- audit/reconciliation history;
- selected operational logic.

### On-Chain Where It Creates Value

The following are placed on-chain where approved:

- ERU balances/supply in clean-start Alpha;
- NFT ownership;
- Ring/Box asset identity;
- authoritative NFT gameplay state;
- provenance;
- transfer rules;
- marketplace settlement;
- user-authorized economic actions.

This approach reduces blockchain friction for ordinary players while preserving verifiable ownership where it matters.

---

## 20. Why Solana

EtheRings requires blockchain infrastructure suitable for a consumer mobile game.

The product needs:

- low transaction costs;
- fast confirmation;
- programmable assets;
- user-signed transactions;
- practical integration with mobile UX;
- the ability to hide unnecessary Web3 complexity from ordinary users.

Solana is selected as the blockchain foundation for Alpha ERU, Silver assets,
and the future approved on-chain economy. ERT remains an off-chain game
currency in NestJS/PostgreSQL under the current target architecture.

The selected Alpha wallet uses Trust Wallet Core `4.8.2`, BIP-39 recovery,
`m/44'/501'/0'/0'`, Android-only private key/phrase handling, encrypted
local storage and ordinary Ed25519 user signing. User-signed Cooper ERU
progression has been demonstrated in a test-only build. Mainnet wallet/fee
policy and production authorities require separate validation.

---

## 21. Self-Custodial Wallet and UX

The goal of EtheRings is not to require players to become blockchain specialists before they can start playing.

The selected Alpha wallet model is a classic embedded self-custodial Solana wallet. It must provide:

- user-controlled ownership;
- explicit approval for sensitive actions;
- ordinary user Ed25519 signing and test-SOL-funded Devnet/Testnet network fees; transaction sponsorship is not part of the approved Alpha model;
- BIP-39 phrase backup and recovery;
- no backend-custodial authorization-boundary violation of user control.

Application login alone must not grant the server the ability to arbitrarily transfer or sell a user's assets.

---

## 22. ERT and ERU

EtheRings uses two game-economy assets with different roles.

### ERT

ERT is the primary utility resource of the Move/game economy.

ERT remains an exact off-chain game currency in the backend/PostgreSQL
accounting system. Rewards and expenses are audited ledger
credits and debits; an expense is not a Solana token burn. No ERT mint, wrapped
token, bridge, redemption claim, or public trading path is part of this model.
Any future change would require separate approval.

It is used in mechanics such as:

- progression;
- Draw;
- Shine restoration;
- selected gameplay actions;
- economy sinks.

### ERU

ERU is used in less frequent economic and NFT-related actions, including:

- progression;
- transformation;
- selected NFT mechanics;
- gameplay rewards;
- economy settlement/burn flows.

ERU becomes the on-chain Solana token for Alpha. The earlier MVP version has
off-chain ERU records; those are not chain balances. The new Alpha
test-reserve premint remains required. The earlier
requirement to decide legacy-balance treatment, cutover, old-client behavior,
reconciliation and rollback as an MVP-to-Alpha migration is **SUPERSEDED** by
the clean-start decision. No MVP ERU balance is imported or converted to Alpha.
MVP records remain untouched pending a separate launch procedure.

### Fees, Royalties and Transaction Costs

Game principal costs, platform commissions, creator royalties, and blockchain
network costs are separate economic legs. Network-fee payment does not waive a
game principal, platform commission, or creator royalty.

The rules below are approved for the Alpha architecture but are not implemented
as on-chain runtime in the current off-chain MVP. They define test-environment
behavior and do not automatically become final Mainnet policy.

| Operation | Base amount | Additional charge | Payer | Recipient or treatment |
|---|---|---|---|---|
| Covered ERU spending or transfer | ERU principal defined by the mechanic | 2% of ERU principal | User | Full principal reaches its intended recipient or is burned; commission goes separately to project treasury |
| Alpha Cooper breeding | ERT and ERU principal from the approved 2x2 counter matrix | 2% of ERU principal | User | ERT is an off-chain ledger debit; ERU principal is burned and commission goes separately to project treasury |
| Alpha marketplace sale of an EtheRings NFT | Seller's SOL list price | 2% platform commission plus 4% EtheRings creator royalty | Buyer | Seller receives the full list price; platform treasury and royalty recipient receive separate additive payments |
| Free NFT mint or NFT reward issuance | No sale price | No platform commission; no marketplace royalty leg | No monetary platform charge | Network execution cost, if any, remains separate |
| Direct on-chain user-to-user NFT transfer | No sale price | No platform commission; no marketplace royalty leg | No monetary platform charge | Transfer cooldown rules still apply; network execution cost remains separate |
| ERU issuance or reward credit | Stated ERU reward | No ERU platform commission | Reserve/reward path | Player receives the complete stated reward |

For covered ERU operations, the commission is calculated in integer base units
and rounded upward only when the exact percentage is fractional:

```text
feeBaseUnits = ceil(principalBaseUnits * 200 / 10000)
totalDebitBaseUnits = principalBaseUnits + feeBaseUnits
```

Display formatting does not alter this calculation. For example, a `30 ERU`
principal has a `0.6 ERU` commission, so the user is debited `30.6 ERU`. The
principal is delivered or burned according to the mechanic; not every ERU
transfer is a burn. The exact gateway-generated treasury fee leg is not charged
a second commission, but this narrow settlement exemption cannot be selected
for an arbitrary treasury transfer.

For an applicable EtheRings NFT listed at `100 SOL`, the buyer pays `106 SOL`:

- `100 SOL` to the seller;
- `4 SOL` to the EtheRings creator royalty recipient;
- `2 SOL` to the platform treasury.

The 4% royalty and 2% platform commission are each calculated independently
from the seller's list price and rounded upward to a whole lamport when needed:

```text
creatorRoyaltyLamports = ceil(listPriceLamports * 400 / 10000)
platformFeeLamports = ceil(listPriceLamports * 200 / 10000)
```

Neither charge is deducted from seller proceeds, neither percentage compounds
on the other, and the SOL-only marketplace settlement does not add an ERU fee.
This Alpha contract applies to supported EtheRings assets in the internal
marketplace; it does not promise royalty enforcement on external marketplaces.

On Devnet/Testnet, the embedded wallet may pay Solana network fees with test SOL;
this is not a Mainnet fee policy. Network fees remain separate from marketplace
principal, royalty and platform fee. In particular, user-paid network fees do
not change the additive 2% ERU platform commission or any approved exemption.

Free NFT minting, NFT reward issuance, direct on-chain user-to-user NFT
transfer, and ERU issuance/reward credits retain their approved commission
exemptions. Commission-exempt does not mean that no blockchain transaction cost
can exist. A paid mechanic that spends ERU still carries its approved ERU
commission even when the resulting NFT issuance itself is commission-exempt. A
direct NFT transfer remains distinct from a marketplace purchase, and its
cooldown is a gameplay restriction rather than a monetary fee.

The historical product source described third-party royalties in a planned
`6%–20%` range, but no per-collection rate is approved or active. Third-party
collections are outside the Alpha marketplace contract. Fees for Genesis paid
minting, RingShow, Mainnet transformation, third-party collections, and other
undefined mechanics remain unfinalized; an undefined fee is not `0%`.

Detailed internal implementation contracts are maintained in the private
engineering repository and are intentionally not included or linked from this
public mirror.

### Test Environment vs Mainnet Tokenomics

Alpha/Devnet may use a dedicated ERU technical token configuration to validate
contracts, supply controls, burns, fees, and reconciliation. ERT remains in
the isolated off-chain game ledger.

This configuration must not automatically be interpreted as final Mainnet distribution or tokenomics.

Final Mainnet allocation, distribution, sale/liquidity, and treasury rules will be published separately in a production tokenomics document before release.

---

## 23. OG Genesis Box Collection

After Mainnet/Release, EtheRings plans to introduce the **OG Genesis Box Collection**.

Supply:

**1,000 Genesis Boxes**

The collection contains **Gold Rings marked as Genesis**.

Genesis is not a separate rarity. It is a provenance/status designation within the Gold collection layer.

The planned distribution model includes multiple channels:

- community airdrop;
- free mint;
- giveaways;
- collaborations;
- limited paid FCFS mint.

Exact allocation percentages, mint price, and schedule will be approved before Mainnet release.

The Genesis Collection is outside the Alpha/Testnet scope.

---

## 24. Unique Rings and Lore

Lore is part of the long-term identity of EtheRings.

The game world includes **6 Unique Rings** connected to key lore entities/heroes.

Unique Rings should not be treated as another ordinary step in the rarity ladder. They are special lore-linked assets.

Their:

- supply;
- attributes;
- utility;
- acquisition;
- transfer rules;
- gameplay effects

are defined through individual lore/game rules.

---

## 25. Security, Fairness, and Reconciliation

The EtheRings economy must be protected against replay, client-side manipulation, and desynchronization between blockchain and backend state.

Key requirements:

- server-authoritative activity validation;
- idempotent economy operations;
- atomic on-chain token/asset settlement where possible and explicit reconciliation across PostgreSQL/Solana;
- replay protection;
- explicit pending/confirmed/failed states;
- reconciliation between chain and backend;
- no administrative, deployment, reserve, or server secrets/authority keys in the mobile client; the user wallet mnemonic/private key is allowed only in the approved encrypted Android Keystore-backed local lifecycle, never in plaintext storage, the APK, logs, or the backend;
- backend-only records must not be called NFTs before confirmed on-chain identity and ownership exist;
- auditability of critical economy actions.

Randomness-sensitive mechanics require a separate verifiable and fair randomness policy before production activation.

---

## 26. Roadmap

### MVP — Earlier off-chain version

The MVP and Alpha are successive versions of one product. The MVP shutdown is planned as part of the transition; historical MVP operation and artifacts remain distinct from the Alpha public test. Current MVP availability must be checked at the service, not inferred from this document.

The MVP's documented capabilities were:

- Android application;
- automatic step tracking;
- backend-authoritative Move-to-Earn;
- off-chain ERT/ERU;
- Draw;
- Cooper Rings;
- inventory / equip / selection;
- progression;
- basic release and update infrastructure.

### Alpha — staged public test and further development

The first public Alpha test is being prepared. Its date and build contents
have not been announced. Subsequent Alpha development adds functionality in
stages. The test-only build demonstrates the core account, wallet, Silver
Box/Ring, activity and Cooper progression flows described above. Silver
Level-Up and other remaining features are still in development; a development
build is not a public release.

Alpha includes:

- Solana integration;
- classic embedded self-custodial wallet;
- user-funded test-SOL network fees on Devnet/Testnet, without mandatory sponsorship;
- off-chain ERT and on-chain ERU in clean-start Alpha;
- Silver Ring Box;
- Silver NFT;
- on-chain ownership/state;
- testnet-specific Cooper → Silver Box vertical;
- Silver progression;
- internal SOL marketplace;
- backend ↔ blockchain reconciliation.

This is the full approved model, not a claim that every item is implemented. Each capability requires its own confirmed implementation and checks before it is described as available. Alpha remains a test version; Mainnet is a separate future release with separate approval and launch gates.

### ⬜ Beta — Play Expansion / Planned

- Match-3;
- Rings/items affecting gameplay;
- broader utility;
- lore integration;
- deeper progression/gameplay loops.

### ⬜ Mainnet / Release — Planned

- production blockchain economy;
- Mainnet Ring Transformation;
- production marketplace;
- higher NFT rarities;
- collections and provenance systems;
- Genesis Collection when ready.

### ⬜ Post-Release — Further Development

- RingShow / staking;
- Gemstone and alchemy expansion;
- Gold / Platinum systems;
- Unique lore systems;
- collaborations;
- broader collectible/game ecosystem.

Roadmap stages describe product direction and do not guarantee a specific calendar date unless separately announced.

---

## 27. Development Disclosure

Development of EtheRings began before the current blockchain Alpha stage.

Before Solana runtime integration, the following already existed:

- Android MVP;
- step tracking;
- backend-authoritative Move-to-Earn;
- Draw;
- off-chain ERT/ERU;
- Cooper Ring system;
- Ring progression;
- public testing infrastructure.

Blockchain integration is the next development stage of an existing product, not a claim that the entire earlier runtime was already operating on-chain.

This distinction is important for technical transparency and accurate reporting of project progress.

---

## 28. Rule Publication Principle

EtheRings distinguishes between:

1. **Implemented** — already working and supported by runtime evidence.
2. **Approved / Planned** — approved for future scope but not yet implemented.
3. **Concept / TBD** — the direction exists, but exact parameters are not yet approved.

If an exact formula, probability, token cost, supply, or authority model has not been approved, the Whitepaper must not replace a missing decision with an assumption.

---

## 29. EtheRings in One Formula

**EtheRings is a mobile game built around Move. Play. Collect.**

Real-world movement feeds the game economy.\
Rings connect progression, gameplay, and collection.\
Blockchain makes selected assets, ownership, provenance, and settlement verifiable.

**Move. Play. Collect.**

---

## Appendix A — Canonical Terminology

- **Cooper** — the canonical product-facing name of the base rarity.
- **RingShow** — the current name of the NFT staking mechanic.
- **Genesis** — a Gold Ring provenance/status designation, not a separate rarity.
- **Unique** — a separate lore-linked rarity consisting of six special Rings.

---

## Appendix B — Known Open Decisions

Before the final Mainnet Whitepaper, at least the following must be approved separately:

- exact Mainnet transformation formula and asset-conversion semantics;
- final Mainnet ERT/ERU tokenomics;
- Gold/Platinum generation rules;
- Unique Ring mechanics;
- Match-3 balancing/reward formulas;
- Shine consumption/restoration formulas;
- Luck-to-raffle formula;
- RingShow reward formula;
- Gemstone boundary/random-generation semantics;
- Potion combine distribution/costs;
- Mainnet wallet/fee/authority model;
- Mainnet marketplace fee/royalty details if they differ from Alpha contracts;
- Genesis allocation, schedule, and mint economics.
