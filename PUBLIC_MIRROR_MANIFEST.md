# What is in this repository

This public repository contains the authored product source needed to study and build EtheRings from the Android MVP through Public Alpha 1.2.1a. It is a reviewed export, not a copy of the private engineering repository or its Git history.

| Directory | Scope |
| --- | --- |
| `android/` | One Android project containing the MVP app and the later Alpha screens, wallet integration, resources, build files and tests. |
| `android-alpha-prototype/` | Earlier separate Alpha Android prototype. It is historical work, not the released app. |
| `backend/` | MVP server, migrations, shared Alpha game rules and tests. |
| `backend-alpha/` | Alpha server, its database schema and tests. |
| `frontend/` | MVP web and administration client. |
| `programs/` | Solana program source and development projects for ERU, Silver assets and related experiments. |
| `docs/` | Product explanation, build guide, release history and known issues. |

The Android project has a pinned copy of the third-party Trust Wallet Core 4.8.2 Android library because the build requires it. That binary is not authored EtheRings source; its upstream license and hash are recorded in `android/app/libs/README.md`.

The export omits signing keys, wallet seeds, passwords, private RPC URLs, internal host addresses, deployment configuration, real player data, private operational records and one-off administration scripts. Some test fixtures use documentation-only addresses, and the development Android variant uses a `.invalid` placeholder instead of the private development API. These omissions do not remove the player app, game servers or Solana program source. The public source can be compiled with local dependencies and a developer's own signing key; that key cannot reproduce the official APK signature.

The source reflects a reviewed private Git revision after the 1.2.1a release. One unrelated uncommitted private server edit was not exported. Public Git history starts with this repository's own commits; earlier milestones are described in [release history](docs/RELEASE_HISTORY.md) instead of being invented as Git ancestry. The earlier limited source sample remains in public Git history, while the current tree contains the expanded export.

See [BUILD.md](docs/BUILD.md) for the build steps and [PUBLIC_MIRROR_SYNC_POLICY.md](PUBLIC_MIRROR_SYNC_POLICY.md) for how later releases are reflected here.
