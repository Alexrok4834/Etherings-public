# Known Public Alpha issues

This is a player-readable summary of reports through 9 October 2026. It contains no tester account, wallet or device identifier. A report means a player observed a problem; it does not automatically establish a common cause.

| Area | What players reported | Current status |
| --- | --- | --- |
| Steps on some Android phones | Activity sometimes showed fewer accepted steps than the phone had recorded. Reports came from HONOR, OnePlus and Xiaomi devices. | Version 1.2a improved how steps are timed and sent. Ordinary walking on the affected phones still needs comparison with server records. Previously rejected steps were not restored. |
| First screen load | Home, Wallet and Rings can still feel slow on a cold load. | Images and recent verified content are reused where safe. A consistent threefold speedup has not been demonstrated. |
| Draw results | A long sequence of ERT outcomes looked unusual to testers. | Recorded outcomes matched the configured ranges in the reviewed sample. This remains an observation; no change to Draw odds is claimed. |
| Silver Ring level-up | A tester's level 4 to 5 attempt remained pending after signatures were submitted. | The Ring was still level 4 at the last readback. Version 1.2.1a can resume the recorded request and explain when more Devnet SOL is needed. Completion on that tester's phone has not been confirmed. Do not sign repeated attempts simply because a response is slow. |
| Newly awarded Silver Box | A Box from Draw appeared before it was ready to open. | Preparation completed later. Version 1.2.1a retries readiness on the open Box screen; a new natural-use opening on that tester's phone has not been confirmed. |
| Silver Ring Points | On A8, successful allocations were temporarily shown as unconfirmed. | The two recorded actions were confirmed and reconciled without repeating them. Version 1.2.1a waits and checks for the existing result. A new tester transaction has not yet confirmed the fix in natural use. |

Update notices are included on the sign-in and game screens of newer Alpha builds. Older installed builds may retain their earlier check timing because an APK cannot be changed after installation. If a notice is delayed, use the [official download link](https://app.etherings.xyz/download/android/etherings.apk). An update over a compatible signed Alpha build keeps local app data.

For a new report, contact [founder@etherings.com](mailto:founder@etherings.com) or the [community Discord](https://discord.gg/5jQzegWuhz). Share what you did, what happened, your app version and phone model. Never send a wallet recovery phrase, password or private key.
