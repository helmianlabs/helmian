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
| CORA-001 | P0 | Fix Cora refusal loop on Helmian Cloud | `helmian.cloud` domain -> Fly release `v44` -> authenticated WebSocket `101 Switching Protocols` -> real `helmian-platform` owner bridge -> published config resolver -> `assistant_input` + `assistant_end` -> durable completed voice row and Hume usage receipt. Source gates: `src/cora/clm-server.mjs:432-534, 623-713`; `src/cora/session-config-resolver.mjs:23-76`; `src/cora/activity.mjs:140-178`; live probe used the active DB identity/config and returned a normal Cora response. | ☑ VERIFIED |
| CORA-002 | P0 | Make refusal evidence durable | Refusal branch -> `writeActivity('refused', ...)` at `src/cora/clm-server.mjs:703` -> JSONL writer at `src/cora/activity.mjs:115-128, 140-178` -> regression reads the durable row at `test/cora-clm.test.mjs:691-719` -> live refusal probe produced a durable `status=refused` row on Fly. `node --test test/cora-clm.test.mjs` passed 43/43. | ☑ VERIFIED |
| LIVE-001 | P0 | Prove the deployed Helmian admin/auth surface | `helmian.cloud` -> Vercel external rewrites in `web/marketing/vercel.json` -> Fly `/admin` and `/api/admin` -> live UI 200, app asset 200, unauthenticated API 403, and PKCE login 302. The login redirect now carries `redirect_uri=https://helmian.cloud/admin/auth/callback` after the Fly origin secrets were corrected. Source/test wiring: `src/cloud/live-admin.mjs:121-125, 143-150, 211-275, 540-580`; external identity callback completion and Troy visual sign-off remain open. | ☑ ROUTE VERIFIED / OIDC SIGN-IN OPEN |
| PROVIDER-001 | P1 | Verify the four Frontier provider adapters in Cloud | Provider selection -> server-side credential/profile lookup -> documented provider request -> redacted receipt/usage ledger -> UI result. Source currently names OpenAI, Anthropic, Gemini, and Grok paths in `src/agent/session.mjs:76-78, 595` and `src/agent/providers.mjs:11-14`; live credentials and canaries are not proven. | ☐ OPEN |
| OAUTH-001 | P1 | Complete provider OAuth/API connection flows | Admin intent -> provider callback -> encrypted/token-safe persistence -> readiness check -> governed model call. `docs/HELMION_CLOUD_OAUTH_CONNECTIONS.md:1-6` says the current contract is records-only and future callback work remains. | ☐ OPEN |
| RBAC-001 | P1 | Prove ABAC/RBAC enforcement for Cora actions | Signed identity/tenant/role -> policy check -> allowed or denied action -> durable receipt -> UI evidence. Existing contracts require this; a live role matrix is not yet captured. | ☐ OPEN |
| UI-001 | P1 | Complete full Helmian Cloud UI wiring | Visible control -> client request -> server route -> persisted receipt -> rendered result/error. The admin UI contains explicit receipt-only boundaries in `web/cloud-admin/index.html:120-132, 183-251`; full production behavior is not yet proven. | ☐ OPEN |
| APK-001 | P2 | Establish APK/AAB provenance and install proof | Build command -> artifact writer -> checksum/manifest -> install/store result. The staged manifest is internally consistent, but the writer for `device-current.apk` and install/store evidence are unknown. | ☐ OPEN |

## Release gate

Do not call Helmian Cloud production-ready until every P0/P1 row has a cited live test, the domain map is reconciled, Cora has a successful authenticated session on `helmian.cloud`, and Troy has visually QA'd the deployed UI. Phase-two tabs remain gated behind that sign-off.
