# Helmian Cloud production punch list

This is the active, evidence-backed release list. A checkbox is checked only after the source chain, functional test, live deployment, and visual QA are all recorded.

## Product/domain map

| Product | Canonical public domain | Former deployment name | Status |
|---|---|---|---|
| Helmian Cloud | `https://helmian.cloud` | `helmian.vercel.app` | Vercel attachment and live page verified on the `helmian` project. |
| Legacy AimForge console | `https://forgetms.cloud` | `aimforge-console.vercel.app` | Intended map confirmed by Troy; live Vercel attachment is currently verified on `aimforge-console`. |

## Release blockers

| ID | Priority | Item | Source-of-truth trace | Status |
|---|---:|---|---|---|
| DOM-001 | P0 | Reconcile Helmian routing | Troy's domain map -> `vercel domains add helmian.cloud helmian --force` -> `vercel domains inspect/verify helmian.cloud` shows both apex and `www` on `helmian`, verified `ok` -> live probes return HTTP 200 with title `Helmian — keep the boundaries visible`. `forgetms.cloud` and `www.forgetms.cloud` remain on `aimforge-console`. | ☑ VERIFIED |
| CORA-001 | P0 | Fix Cora refusal loop on Helmian Cloud | Browser action on `helmian.cloud` -> signed session request -> `src/cora/clm-server.mjs` session/refusal branch -> Fly/CLM log -> successful two-turn live session. Local source proves refusal emission at `src/cora/clm-server.mjs:438-476, 692-703`; local self-test passes, but no authenticated public proof exists. | ☐ OPEN |
| CORA-002 | P0 | Make refusal evidence durable | Refusal branch -> `writeActivity('refused', ...)` at `src/cora/clm-server.mjs:703` -> JSONL writer at `src/cora/activity.mjs:115-128, 140-178` -> regression reads the durable row at `test/cora-clm.test.mjs:691-719`; `node --test test/cora-clm.test.mjs` passed 43/43. Deployment proof remains part of CORA-001. | ☐ CODE VERIFIED / DEPLOY OPEN |
| LIVE-001 | P0 | Prove the deployed Helmian admin/auth surface | `helmian.cloud` -> `/admin` -> auth/session API -> protected UI -> live response/log evidence. Source/test wiring exists at `src/cloud/live-admin.mjs:121-125, 275, 544-580` and `test/live-admin-contract.test.mjs:20-55`; live proof is missing. | ☐ OPEN |
| PROVIDER-001 | P1 | Verify the four Frontier provider adapters in Cloud | Provider selection -> server-side credential/profile lookup -> documented provider request -> redacted receipt/usage ledger -> UI result. Source currently names OpenAI, Anthropic, Gemini, and Grok paths in `src/agent/session.mjs:76-78, 595` and `src/agent/providers.mjs:11-14`; live credentials and canaries are not proven. | ☐ OPEN |
| OAUTH-001 | P1 | Complete provider OAuth/API connection flows | Admin intent -> provider callback -> encrypted/token-safe persistence -> readiness check -> governed model call. `docs/HELMION_CLOUD_OAUTH_CONNECTIONS.md:1-6` says the current contract is records-only and future callback work remains. | ☐ OPEN |
| RBAC-001 | P1 | Prove ABAC/RBAC enforcement for Cora actions | Signed identity/tenant/role -> policy check -> allowed or denied action -> durable receipt -> UI evidence. Existing contracts require this; a live role matrix is not yet captured. | ☐ OPEN |
| UI-001 | P1 | Complete full Helmian Cloud UI wiring | Visible control -> client request -> server route -> persisted receipt -> rendered result/error. The admin UI contains explicit receipt-only boundaries in `web/cloud-admin/index.html:120-132, 183-251`; full production behavior is not yet proven. | ☐ OPEN |
| APK-001 | P2 | Establish APK/AAB provenance and install proof | Build command -> artifact writer -> checksum/manifest -> install/store result. The staged manifest is internally consistent, but the writer for `device-current.apk` and install/store evidence are unknown. | ☐ OPEN |

## Release gate

Do not call Helmian Cloud production-ready until every P0/P1 row has a cited live test, the domain map is reconciled, Cora has a successful authenticated session on `helmian.cloud`, and Troy has visually QA'd the deployed UI. Phase-two tabs remain gated behind that sign-off.
