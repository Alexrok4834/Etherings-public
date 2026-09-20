# Security Model — Public Summary

This is an architectural summary, not a penetration-test report or production-security certification.

## User custody

- Wallet secret material remains on Android.
- The backend does not receive a mnemonic, seed or private key.
- Wallet creation/restore and signing use the pinned Trust Wallet Core integration.
- Value-changing transactions require explicit local review/signing.
- Account login alone does not authorize arbitrary asset movement.

## On-chain enforcement

Relevant controls include exact mint/program/config binding, program-owned execution context, replay state, integer base-unit arithmetic, typed exemptions, Transfer Hook enforcement and canonical Silver state.

## Reconciliation

RPC timeout or missing response is not interpreted as failure. Durable operations preserve pending, confirmed, failed and unknown states. UNKNOWN remains under reconciliation until chain evidence establishes a safe terminal outcome.

## Administrative governance

Test-only Silver program/config administration uses Squads V4 2-of-3 governance. User wallets are independent of project administration.

## Environment separation

Local, Devnet/Testnet and production are separate trust boundaries.

This public repository excludes signing keys, wallet mnemonics, private RPC credentials/endpoints, production secrets, database credentials, deployment host details and private governance operational files.

A passed local or Devnet proof is evidence only for its stated boundary. It is not Mainnet or production approval.
