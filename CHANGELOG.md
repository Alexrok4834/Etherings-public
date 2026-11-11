# Public Alpha changes

These are the versions players could download. The separate **1.1.1a** build was tested on devices but was not released to everyone.

## 1.3.2a � 11 November 2026

- Home and Rings show saved contents while checking for changes.
- Screens share saved inventory information and avoid duplicate simultaneous reads.
- LISTED stays visible on Ring and Box NFTs during refresh, including after returning from Wallet.
- Fixed recovery from the inventory-loading error found during candidate testing.
- After confirmed Points allocation on a Cooper Ring, its attributes update without reloading the entire NFT inventory. Unclear results still trigger a fresh check.

Checked on Samsung A8: update without clearing app data; Home, Rings and Wallet; listing labels during and after refresh; equipped Ring. No new paid action or walking test was performed in this final pass. No percentage speedup is claimed. Earlier development candidates were not public releases.

Update notices remain enabled for older compatible Alpha builds. The signed release is **1.3.2a/55**.

## 1.3.1a — 8 November 2026

- Home, Rings and Wallet remember the last checked contents, so restarting the app does not always mean staring at an empty screen. A message explains when current information is still being checked.
- Buttons for item actions remain unavailable until that check finishes.
- Returning to a screen does less repeated work when the contents have not changed. Changes made outside the app are still checked.
- Home needs less wallet information to display your balance, and screens opened together can share an inventory check.
- After steps are accepted, the app reuses the information returned with that result instead of requesting it again. Step acceptance and ERT calculation rules are unchanged.
- Saved screen data is kept separate for each account and cleared when signing out or when an operation's result is uncertain.
- Update notices remain enabled on the sign-in and game screens. Compatible earlier Alpha builds can update directly to this version without clearing their app data.

On the Samsung A8 test device, repeat Home and Rings checks completed in about 4.5–6.4 seconds, and repeat Wallet in about 6.4 seconds. The same items and balances were shown before and after the server update. A first full check can still take longer; these are individual observations, not a guarantee for every device or connection. An older-version update dialog and a new walk were not physically checked during this release. No purchase, transfer, Box opening or other paid action was submitted.

## 1.3.0a — 4 November 2026

- Registration asks you to repeat your password and points out a mismatch before creating an account.
- Rings and Boxes offered for sale show **LISTED** in the inventory. The label disappears when the sale listing is no longer active.
- A Cooper Ring in Draw darkens after you actually receive it, so the result is not revealed early.
- When your ERT balance is too low for Draw, the app shows how much is missing and leaves the Draw button inactive.
- When you return to Home with a Silver Ring selected, the app starts checking that Ring alongside other account information, removing one avoidable wait in this case.
- The app continues to check for new versions on the sign-in and game screens. A compatible earlier Public Alpha version can update directly to 1.3.0a.

The signed Android update was installed over 1.2.1a on a Samsung A8 without erasing app data. Home, Rings, Draw, Market and Wallet opened. A consistent speed improvement across all screens has not been measured, and the update prompt was not physically checked on a phone still running an older version. No purchase, transfer, Box opening or other paid action was performed during this release check.

## 1.2.1a — 9 October 2026

- If a Silver Ring action takes longer than expected, the app checks the action already submitted before asking the player to try again.
- A Silver Ring level-up can continue from an unfinished request, and the app explains when the wallet needs more Devnet SOL.
- A newly awarded Silver Box keeps checking whether it is ready to open while the player stays on its screen.
- Update checks remain active when the app comes to the foreground.

Two Points allocations that looked unsuccessful on A8 had actually completed; their results were reconciled without repeating the actions. A new tester transaction has not yet confirmed these improvements in ordinary play.

## 1.2a — 8 October 2026

- Improved the timing and delivery of step records on affected Android phones.
- Existing Alpha accounts, wallets and local data stayed in place during update.

Walking results on HONOR, OnePlus and Xiaomi phones still need follow-up. Previously rejected steps were not restored.

## 1.1.2.1a — 7 October 2026

- The app asks for fresh update information when brought to the foreground, including on sign-in and game screens.
- A new release is no longer hidden by the former six-hour wait in this build.

Phones still running an older APK keep the update behavior built into that APK until they install a newer version.

## 1.1.2a — 7 October 2026

- Home, Rings and Market can show the last verified view while fresh information loads. Actions involving assets wait for the fresh check.
- Images already checked by the app are reused across screen visits and compatible updates.
- Improved Ring and Box loading and repaired a Marketplace listing problem.

First-time loading can still be slow; a consistent threefold improvement was not demonstrated.

## 1.1a — 7 October 2026

- Improved how Wallet and Rings load a player's Silver Boxes and Rings.
- Fixed returning from a Cooper Ring detail screen to the Rings list.

## 1.0 — 4 October 2026

- First publicly downloadable Android Alpha, with a new account, wallet and playable Solana Devnet game loop.

Read the [development timeline](docs/RELEASE_HISTORY.md) for the path from the earlier MVP, and [known issues](docs/KNOWN_ISSUES.md) for reports still under observation.
