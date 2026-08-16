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
| PROVIDER-001 | P1 | Verify the four Frontier provider adapters in Cloud | Shared runtime source adapters exist for OpenAI-compatible, Anthropic, Gemini, and xAI at `src/agent/providers.mjs:1-14, 189-241, 368-471, 474-612`; the live Cora canary proved only OpenAI (`gpt-5.6-terra`). Fly currently exposes only `OPENAI_API_KEY` in its deployed secret names; Anthropic, Gemini, and xAI/Grok live credentials and canaries are not proven. The tenant connection contract separately lists `openai_codex`, `claude`, `gemini`, and `grok` as `adapter: not_configured` at `src/cloud/oauth-connection-contract.mjs:11-16`. | ☐ OPEN |
| OAUTH-001 | P1 | Complete provider OAuth/API connection flows | Admin UI -> `src/cloud/provider-connection-repository.mjs:27-60` -> tenant metadata row and audit intent -> provider callback/token exchange -> encrypted vault -> readiness -> governed model call. Current source deliberately stops at metadata: `src/cloud/oauth-connection-contract.mjs:73-89` returns `provider_endpoint: not_configured`, `token_exchange: not_performed`, and `refresh_token_storage: external_encrypted_vault_required`; `src/cloud/provider-connection-repository.mjs:53-58` persists only a pending metadata row. | ☐ OPEN |
| RBAC-001 | P1 | Prove ABAC/RBAC enforcement for Cora actions | Signed identity/tenant/role -> policy check -> allowed or denied action -> durable receipt -> UI evidence. Existing contracts require this; a live role matrix is not yet captured. | ☐ OPEN |
| UI-001 | P1 | Complete full Helmian Cloud UI wiring | Visible control -> client request -> server route -> persisted receipt -> rendered result/error. The admin UI contains explicit receipt-only boundaries in `web/cloud-admin/index.html:120-132, 183-251`; the source-only authenticated fixture now proves 3 functional flows with Playwright (`qa/browser/cloud-admin-smoke.spec.mjs:4-29`, 3 passed, 1 visual baseline skipped), but full production behavior is not yet proven. | ☐ OPEN |
| APK-001 | P2 | Establish APK/AAB provenance and install proof | Build command -> artifact writer -> checksum/manifest -> install/store result. The staged manifest is internally consistent, but the writer for `device-current.apk` and install/store evidence are unknown. | ☐ OPEN |

## Release gate

Do not call Helmian Cloud production-ready until every P0/P1 row has a cited live test, the domain map is reconciled, Cora has a successful authenticated session on `helmian.cloud`, and Troy has visually QA'd the deployed UI. Phase-two tabs remain gated behind that sign-off.
