# Helmian Cloud agent ledger

This folder records bounded work, blockers, source citations, and release evidence for the continuing Helmian Cloud build.

## Current run

- Canonical map: `helmian.cloud` is Helmian Cloud, formerly `helmian.vercel.app`; `forgetms.cloud` is the legacy AimForge console, formerly `aimforge-console.vercel.app`. This is the current product instruction from Troy on 2026-08-16.
- Live routing audit: `vercel domains add helmian.cloud helmian --force` moved only the Helmian apex. Follow-up `inspect` shows `helmian.cloud` and `www.helmian.cloud` on `helmian`; `verify` returned `ok`; both live probes return HTTP 200 with the Helmian title. `forgetms.cloud` and `www.forgetms.cloud` remain on `aimforge-console`.
- Cora audit/fix: `src/cora/clm-server.mjs:703, 898-906` records a refused turn without copying a signed envelope; `src/cora/activity.mjs:115-128, 140-178` writes the JSONL ledger; `test/cora-clm.test.mjs:691-719` proves the row and `node --test test/cora-clm.test.mjs` passed 43/43. The live refusal probe produced a Fly JSONL row with `status=refused`; the live owner probe for the real `helmian-platform` tenant and published config returned `101`, a normal `assistant_input`, and `assistant_end`. The completed row recorded `Mode: Helmion (tools enabled)` and `Answered by: gpt-5.6-terra`. The live `helmion.cora_provider_usage` table recorded the corresponding Hume sessions as `completed` with `policy_decision=allow`.
- Deployment: commit `43bd105` is pushed on `codex/helmion-step2-signed-session`; Fly release `v44` is live for app `helmian-cloud`. Bearer-authenticated `/healthz` returned HTTP 200 with `providerReadiness.state=ready`, `hume.configured=true`, `signedSessionsRequired=true`, and `sessionConfigResolution=organization_published_at_session_time`.
- Test repair: `web/marketing/package.json` declares `@clerk/backend`; installing the declared dependency with `npm install --ignore-scripts` made `npm run check` pass 42/42. The repository root `npm test` then passed 1278 tests, failed 0, skipped 2. The stale migration focused tests passed 5/5.
- Android audit: `adb` exists, but `emulator`, `sdkmanager`, and `gradle` were not found; the APK artifact writer and install/store path remain unproven.

## Working rule

Every entry added here must name a trigger, a measured result or exact response, and a `file:line`, endpoint, or command citation. Do not promote a handoff claim without re-verifying it against source or live evidence.
