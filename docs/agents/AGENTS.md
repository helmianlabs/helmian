# Helmian Cloud agent ledger

This folder records bounded work, blockers, source citations, and release evidence for the continuing Helmian Cloud build.

## Current run

- Canonical map: `helmian.cloud` is Helmian Cloud, formerly `helmian.vercel.app`; `forgetms.cloud` is the legacy AimForge console, formerly `aimforge-console.vercel.app`. This is the current product instruction from Troy on 2026-08-16.
- Live routing audit: `vercel domains add helmian.cloud helmian --force` moved only the Helmian apex. Follow-up `inspect` shows `helmian.cloud` and `www.helmian.cloud` on `helmian`; `verify` returned `ok`; both live probes return HTTP 200 with the Helmian title. `forgetms.cloud` and `www.forgetms.cloud` remain on `aimforge-console`.
- Cora audit/fix: `src/cora/clm-server.mjs:703, 898-906` now records a refused turn without copying a signed envelope; `src/cora/activity.mjs:115-128, 140-178` writes the JSONL ledger; `test/cora-clm.test.mjs:691-719` proves the row and `node --test test/cora-clm.test.mjs` passed 43/43. No authenticated public Cora session has been proven yet.
- Test blocker: the repository root test run passed 157 tests and failed 3 marketing tests because `@clerk/backend` is declared by `web/marketing/package.json` but absent from both `web/marketing/node_modules` and the root `node_modules`.
- Android audit: `adb` exists, but `emulator`, `sdkmanager`, and `gradle` were not found; the APK artifact writer and install/store path remain unproven.

## Working rule

Every entry added here must name a trigger, a measured result or exact response, and a `file:line`, endpoint, or command citation. Do not promote a handoff claim without re-verifying it against source or live evidence.
