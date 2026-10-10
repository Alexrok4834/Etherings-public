# Current Public Alpha source sample

This small, dependency-free sample comes from the shared Cooper rules used by the current Public Alpha backend. Cooper Rings are game items, not NFTs. The sample shows how one receives its initial attributes and how the game calculates an eligible breeding cost with exact integer units.

It is **not** the complete backend, Android app or on-chain program. It cannot start the live game or reproduce its whole economy. The rest of the source directories in this public mirror remain the older September 20 submission sample.

## Run the sample checks

With Node.js 24 or newer:

```sh
cd current-alpha
npm test
```

No account, RPC key, blockchain connection or database is needed. The tests cover this sample's Cooper attribute range and the exact 2-by-2 breeding price matrix; they do not prove the deployed service or end-to-end gameplay.
