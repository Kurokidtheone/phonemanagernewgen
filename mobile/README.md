# Phone Store (Android companion)

Capacitor + Vite + React app that talks to the desktop app over the shop's Wi-Fi (plain http, no internet).
The desktop side is described in [../docs/mobile-api.md](../docs/mobile-api.md).

It imports, never copies, from the desktop source: `@shared` (src/shared), `@desktop-i18n` (the desktop translation files)
and the `Api` type from `@shared/api` (generated from the Rust core). Phone-only strings are in `src/i18n/*.json` under the `m` key.

## Commands
- `npm install` (once, in this folder)
- `npm run typecheck`, `npm test` (also from the repo root: `npm run mobile:check`)
- `npm run sync`: builds the web app and copies it into `android/`
- `npm run android`: sync, then open Android Studio. Needs JDK 21 and Android SDK 36.
- Debug APK without Android Studio: `cd android && ./gradlew assembleDebug` (output: `android/app/build/outputs/apk/debug/`)

## Notes
- App id `dz.phonestoremanager.app.mobile`. `usesCleartextTraffic` and Capacitor `server.cleartext` are on because the PC is plain http.
- Requests use `CapacitorHttp` (src/lib/http.ts). No analytics, no remote fonts.
- The camera uses `BarcodeScanner.startScan()`, which relies on the ML Kit model bundled in the APK (no Play Services download, works in airplane mode + Wi-Fi). `scan()` (Google's downloadable scanner module) is never called.
- Android manifest edits (cleartext, CAMERA, ACCESS_NETWORK_STATE) are committed in `android/`; keep them if you regenerate the platform.

## Release builds (phase 15)
- `npm run android:keystore` (once) creates `android/release.keystore` and `android/keystore.properties`. Both are git-ignored. **Back them up offline: updates must always be signed with the same keystore.**
- `npm run android:apk` builds the signed release APK (needs JDK 21 and the Android SDK) and copies it to `../dist/<product>-mobile-<version>.apk` and `../build/mobile/` (what the desktop installer packs and the PC serves at `/app.apk`). `npm run android:copy` only copies.
- `npm run android:assets` redraws the launcher icons and splash from `../build/icon.png` and the app name from `src/shared/app.config.ts`.
- `npm run android:dev` runs on a connected phone with live reload.
- Version name = the desktop version; version code = seconds since 2026-01-01, so it rises on every build.
- Details for shop owners and resellers: `../docs/mobile-install.md`.
