# Helmian Cloud agent ledger

This folder records bounded work, blockers, source citations, and release evidence for the continuing Helmian Cloud build.

## Current run

- Canonical map: `helmian.cloud` is Helmian Cloud, formerly `helmian.vercel.app`; `forgetms.cloud` is the legacy AimForge console, formerly `aimforge-console.vercel.app`. This is the current product instruction from Troy on 2026-08-16.
- Live routing audit: `vercel domains add helmian.cloud helmian --force` moved only the Helmian apex. Follow-up `inspect` shows `helmian.cloud` and `www.helmian.cloud` on `helmian`; `verify` returned `ok`; both live probes return HTTP 200 with the Helmian title. `forgetms.cloud` and `www.forgetms.cloud` remain on `aimforge-console`.
- Cora audit/fix: `src/cora/clm-server.mjs:703, 898-906` records a refused turn without copying a signed envelope; `src/cora/activity.mjs:115-128, 140-178` writes the JSONL ledger; `test/cora-clm.test.mjs:691-719` proves the row and `node --test test/cora-clm.test.mjs` passed 43/43. The live refusal probe produced a Fly JSONL row with `status=refused`; the live owner probe for the real `helmian-platform` tenant and published config returned `101`, a normal `assistant_input`, and `assistant_end`. The completed row recorded `Mode: Helmion (tools enabled)` and `Answered by: gpt-5.6-terra`. The live `helmion.cora_provider_usage` table recorded the corresponding Hume sessions as `completed` with `policy_decision=allow`.
- Deployment: commit `43bd105` is pushed on `codex/helmion-step2-signed-session`; Fly release `v44` is live for app `helmian-cloud`. Bearer-authenticated `/healthz` returned HTTP 200 with `providerReadiness.state=ready`, `hume.configured=true`, `signedSessionsRequired=true`, and `sessionConfigResolution=organization_published_at_session_time`.
- Canonical admin routing: `web/marketing/vercel.json` now rewrites `/admin` and `/api/admin/*` to `https://helmian-cloud.fly.dev`. Production deployment `dpl_H6cszAt3MRmGLyzaBQEAup3brBQt` was aliased to `https://helmian.cloud`; live `/admin` returned the Helmian Cloud Workspace page, `/admin/assets/app.js` returned 200, protected API reads returned 403 without a session, and `/admin/auth/login` returned a PKCE 302 with `redirect_uri=https://helmian.cloud/admin/auth/callback`. Fly secrets `HELMION_ADMIN_ORIGIN` and `HELMION_ADMIN_REDIRECT_URI` were corrected to that canonical origin; external Clerk callback completion remains unverified.
- Test repair: `web/marketing/package.json` declares `@clerk/backend`; installing the declared dependency with `npm install --ignore-scripts` made `npm run check` pass 42/42. The repository root `npm test` then passed 1278 tests, failed 0, skipped 2. The stale migration focused tests passed 5/5.
- Browser fixture QA: `qa/browser/playwright.config.mjs:10` runs the fixture from its own directory; `qa/browser/cloud-admin-smoke.spec.mjs:17,24` now asserts the scoped activity cards and current workspace-layout model contract. `npx playwright test --config=qa/browser/playwright.config.mjs` passed 3 functional tests and skipped 1 intentionally ungenerated visual baseline; this proves the source-only fixture, not the external Clerk callback or all production UI paths.
- Android audit: `adb` exists, but `emulator`, `sdkmanager`, and `gradle` were not found; the APK artifact writer and install/store path remain unproven.
- Frontier provider/OAuth trace: `src/cloud/oauth-connection-contract.mjs:11-16` names `openai_codex`, `claude`, `gemini`, and `grok`, but every cloud adapter is `not_configured`; `src/cloud/oauth-connection-contract.mjs:73-89` stops OAuth at `provider_endpoint=not_configured` and `token_exchange=not_performed`; `src/cloud/provider-connection-repository.mjs:53-58` persists only pending tenant metadata and does not grant tools or invoke a provider. PROVIDER-001 and OAUTH-001 remain open.

## 2026-08-16 — signed OIDC session vertical slice

- Isolated branch/worktree: `codex/helmian-rbac-vertical-slice` at `C:\Users\troyh\Documents\Codex\2026-08-14\helmian-rbac-vertical-slice`; remote is `https://github.com/helmianlabs/helmian.git`; target is Fly app `helmian-cloud` from `fly.toml:1`.
- Five mandatory audit questions, included verbatim:
  1. TRACE the return value, don't grep the function — where does its return value persist? Cite the writer's file:line or stamp GAP.
  2. READ the body of every important-sounding name — names lie.
  3. Verify against CODE, not a prior handoff.
  4. Give sub-AIs the CODE, not the handoff.
  5. "Shipped" ≠ "wired end-to-end" — draw A→B→C→D→E, each transition cited.
- Trace result: `helmian.cloud` -> `web/marketing/vercel.json:6-17` -> `https://helmian-cloud.fly.dev/admin` and `/api/admin/*` -> `src/cloud/live-admin.mjs:544-580` -> `src/cloud/identity-gateway.mjs:114-150` OIDC PKCE callback -> `issueSession` at `src/cloud/identity-gateway.mjs:45-49` -> HMAC-signed `hs1` cookie -> `readSession` at `src/cloud/identity-gateway.mjs:51-68` -> `src/cloud/live-admin.mjs:297-310` Neon membership/role lookup -> role-aware UI at `web/cloud-admin/app.js:897-916`. The durable writer for session claims is the signed cookie; the durable role authority is the Neon membership query. No source-only fixture is being called production proof.
- Implementation: `src/cloud/identity-gateway.mjs:1,5,32-68,104-173` replaces the process-only opaque session map with an HMAC-signed session token, validates expiry and tamper resistance, and retains in-process logout revocation. `src/cloud/deployment-contract.mjs:49-51` now requires `HELMION_ADMIN_SESSION_SECRET` at least 32 characters; the live Fly secret list captured before deployment had no such name, so live rollout remains open until the secret is installed and health is rechecked.
- Focused verification: `node --test test/live-admin-contract.test.mjs test/cloud-deployment-contract.test.mjs test/clm-live-admin.test.mjs` passed 36/36; `npm run check:cloud-admin` passed. The regression proves a fresh gateway instance verifies the callback token, tampering fails, and revocation fails closed at `test/live-admin-contract.test.mjs:83-124`.

## Working rule

## 2026-08-16 — RBAC/ABAC workspace-project vertical slice

- Isolated branch/worktree: `codex/helmian-rbac-vertical-slice` at `C:\Users\troyh\Documents\Codex\2026-08-14\helmian-rbac-vertical-slice`.
- Code trace: `src/cloud/live-admin.mjs:897-916` derives the active tenant actor, calls `authorizeTenantAction`, persists member denials through `persistTenantActionDecision`, and returns the receipt; `src/core/tenant-context.mjs:79-101` rechecks the Neon membership row inside a transaction; `src/cloud/workspace-project-repository.mjs:30-42` writes the project and ALLOW audit receipt before commit; `web/cloud-admin/app.js:937-944` renders the denial result and receipt.
- Tests: `node --test test/tenant-rbac-vertical-slice.test.mjs test/workspace-project-route.test.mjs test/workspace-project-repository.test.mjs test/clm-live-admin.test.mjs test/live-admin-contract.test.mjs` passed 34/34; `npm run check:cloud-admin` passed. Live owner/admin/member identity and Neon receipt evidence is still required before marking RBAC fully complete.
- Environment failure: the new worktree initially lacked `node_modules`; `npm install --no-save --ignore-scripts --prefer-offline` installed 14 packages. Do not treat local test success as live deployment proof.

Every entry added here must name a trigger, a measured result or exact response, and a `file:line`, endpoint, or command citation. Do not promote a handoff claim without re-verifying it against source or live evidence.
