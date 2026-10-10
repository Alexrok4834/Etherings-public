# Build EtheRings from source

The Android app is the quickest place to start. The same project contains the earlier MVP and the Public Alpha. The commands below build locally; they do not publish an APK, change a running service or use a project signing key.

## Android app

Install Android Studio with Android SDK 36 and a compatible JDK. Open [`android/`](../android/) in Android Studio, allow Gradle to download its dependencies and set your local SDK path through Android Studio or an untracked `android/local.properties` file.

From `android/`, build the earlier MVP debug app:

```powershell
.\gradlew.bat :app:assembleDebug
```

Build the Alpha development app:

```powershell
.\gradlew.bat :app:assembleAlphaDev
```

On macOS or Linux, use `./gradlew` instead. The build includes the pinned Trust Wallet Core library in `android/app/libs/`; Gradle verifies its SHA-256 hash. `alphaDev` is a separate debug package. Its private development API address was replaced with a `.invalid` placeholder in this public export, so configure your own test endpoint before trying to use that build. To build the **1.2.1a Alpha release configuration**, use `:app:assembleAlphaRelease` with your own local signing key. The build reads its keystore path, alias and passwords from `ETHERINGS_ANDROID_KEYSTORE_PATH`, `ETHERINGS_ANDROID_KEY_ALIAS`, `ETHERINGS_ANDROID_KEYSTORE_PASSWORD` and `ETHERINGS_ANDROID_KEY_PASSWORD`. Keep the keystore outside the repository. Your APK will have your signature and cannot install over the official app as an update.

We built `assembleAlphaDev` and assembled `alphaRelease` **1.2.1a/48** from the reviewed export. The latter used a disposable local signing key, which was deleted after the build. It was a build check, not a new official signed APK or a release.

## Game servers and web client

Use Node.js 24 or newer for the Alpha server. Each project has its own lockfile:

```powershell
cd backend
npm ci
npm run build
cd ..\backend-alpha
npm ci
npm run build
cd ..\frontend
npm ci
npm run build
```

The Alpha server imports shared rules from `backend/alpha-core`, so keep these folders side by side. A running server also needs a database and your own environment values; build commands do not require access to EtheRings' private database, mail account or RPC provider. Do not point a local experiment at the public service.

## Solana programs

The [`programs/`](../programs/) directory contains several separate Rust projects rather than one top-level Anchor workspace. Their `Cargo.toml` files identify each project and its pinned dependencies. Build a chosen project with the compatible Rust/Solana toolchain from inside that directory, for example:

```powershell
cd programs/silver-first-entry
cargo build --locked
```

Building a program is separate from deploying or upgrading it. The repository does not include project authorities or deployment credentials.
