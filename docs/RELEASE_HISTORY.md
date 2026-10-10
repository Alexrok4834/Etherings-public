# From MVP to Public Alpha

This timeline comes from the project's development Git records and release receipts. The public repository has its **own** Git history: dates below describe when work happened or an APK was published, and are not backdated public commits. Earlier source snapshots are not represented as if they were current releases.

| Date | Milestone | What it meant for players |
| --- | --- | --- |
| Before September 2026 | Android MVP | Walking, game balances, Draw and Cooper Rings worked without Solana assets. Its app and server code are in `android/` and `backend/`. |
| 9 September 2026 | Alpha development began | The team recorded the shift toward Solana wallet actions and NFT game items. The separate Android Alpha prototype and Solana program projects show parts of that work. |
| 20 September 2026 | Hackathon snapshot | Alpha work was in progress. [The hackathon disclosure](HACKATHON.md) separates earlier MVP work from work done during the event. |
| 4 October 2026 | Public Alpha **1.0** | First publicly downloadable Alpha APK, with the new account, wallet and playable Alpha loop. |
| 7 October 2026 | **1.1a** | Improved Wallet and Rings inventory loading and returning from a Ring detail screen. |
| 7 October 2026 | **1.1.2a** | Screens reused verified images and recent content while refreshing. Ring and Box reads improved, although slow first loads remained. Marketplace listing was repaired. |
| 7 October 2026 | **1.1.2.1a** | The app checked for a new version when brought to the foreground instead of waiting on an old cached result. |
| 8 October 2026 | **1.2a** | Improved step timing and delivery on affected Android devices. Existing Alpha data stayed in place during update. Real walking on the affected models still needed further observation. |
| 9 October 2026 | **1.2.1a** | Improved recovery when a Silver Ring action takes too long to confirm, clearer guidance when test SOL is insufficient, and automatic retry of a newly awarded Box's opening readiness. |

The signed **1.1.1a** build was used on test devices on 7 October for Box and artwork corrections. It was **not** published as a public release. The current published version is **1.2.1a**; see the [latest release](https://github.com/Alexrok4834/Etherings-public/releases/latest) and [download page](https://app.etherings.xyz/download/android/etherings.apk).

Each entry describes a released change, not a promise that every related bug is resolved on every device. See [known issues](KNOWN_ISSUES.md) for what still needs observation. The full source export was added to this public repository after the 1.2.1a release; the earlier GitHub release tag retains its historical limited source snapshot.
