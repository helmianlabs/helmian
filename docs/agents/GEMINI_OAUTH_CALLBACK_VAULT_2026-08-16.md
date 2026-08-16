# Gemini OAuth callback and production vault work log

> **Rule 0.13:** “NO time-cap handoff. Stick to the rules instead. (RETIRED 2026-05-29)”
>
> **Rule 0.001:** “SOURCE OF TRUTH + FULL TRACING — the supreme rule. Every factual claim I make to Troy must satisfy BOTH gates. No exceptions. GATE 1 — SOURCE OF TRUTH. Cite the primary source where the claim lives. GATE 2 — FULL TRACING. For any multi-stage claim, draw the chain explicitly with a citation on EVERY link.”

## Scope and isolation

This slice is limited to Helmian Cloud Gemini provider OAuth callback,
client-registration configuration, encrypted vault persistence, migration
coverage, and their tests. The isolated workspace is
`C:\Users\troyh\Documents\Codex\2026-08-14\helmian-gemini-oauth-callback-vault` on
branch `codex/gemini-oauth-callback-vault`. Forge TMS, `forgetms.cloud`, and
unrelated provider invocation code are out of scope.

## Mandatory audit questions

1. TRACE the return value, don't grep the function — where does its return value persist? Cite the writer's file:line or stamp GAP.
2. READ the body of every important-sounding name — names lie.
3. Verify against CODE, not a prior handoff.
4. Give sub-AIs the CODE, not the handoff.
5. "Shipped" ≠ "wired end-to-end" — draw A→B→C→D→E, each transition cited.

## Code trace: Gemini A→B→C→D→E

| Stage | Evidence | Result |
|---|---|---|
| A. Owner/admin request | `src/cloud/live-admin.mjs:587-598` calls `activeTenantActor`, resolves the env-bound registration, creates PKCE, builds the Google authorization contract, and calls `createOAuthTransaction`. | The browser receives a 302 plus HttpOnly/Secure state and verifier cookies. |
| B. Durable state | `src/cloud/provider-connection-repository.mjs:79-96` hashes raw state with `hashOAuthState` and inserts `helmion.provider_oauth_transactions`; `sql/034_helmion_provider_oauth.sql:1-45` defines the table, TTL, status, and tenant-admin RLS. | The callback has a single-use, tenant-scoped transaction to claim. |
| C. Callback claim | `src/cloud/live-admin.mjs:605-620` matches the callback state to the cookie, claims it, reads the verifier, and passes transaction-bound client/redirect/challenge/reference values into `exchangeOAuth`; `src/cloud/provider-connection-repository.mjs:98-111` changes `pending` to `processing` under transaction. | A replay or missing state fails closed before token exchange. |
| D. Provider exchange and vault writer | `src/cloud/provider-oauth-flow.mjs:34-93` posts PKCE to Google's token endpoint and calls `vaultAdapter.storeOAuthTokens`; `src/cloud/database-encrypted-vault-adapter.mjs:31-107` encrypts access/refresh tokens with AES-256-GCM and inserts only ciphertext, IV, auth tag, and metadata into `helmion.provider_oauth_tokens`. | The return value is `{stored:true, reference}` and no secret material is returned to the route. |
| E. Completion and connection metadata | `src/cloud/live-admin.mjs:621-630` calls `finishOAuthTransaction`; `src/cloud/provider-connection-repository.mjs:113-123` marks the transaction completed and `:72-76` writes only the tenant provider reference as pending connection metadata. | The connection remains pending and tools/invocation remain disabled until a separate canary. |

## Provider authority boundary

`src/cloud/provider-oauth-authority.mjs:1-80` records real Gemini Google OAuth
authority and named blockers for OpenAI Codex, Claude, and direct Grok API OAuth.
Those blockers are intentionally not converted into guessed URLs or fake OAuth
success.

## Tests and live evidence

- Focused callback/vault/migration/provider suite: 20 passed, 0 failed.
- Full repository suite: 1,289 passed, 0 failed, 2 skipped, after installing
  the already-declared `web/marketing/package.json` dependency into the isolated
  worktree without changing tracked files.
- Pre-deploy live probes:
  `GET https://helmian.cloud/api/admin/provider-oauth/gemini/start` returned
  HTTP 404 `CLOUD_ADMIN_ROUTE_NOT_FOUND`, and the equivalent callback probe also
  returned HTTP 404. `fly secrets list -a helmian-cloud` showed no
  `HELMION_GEMINI_OAUTH_CLIENT_ID` and no `HELMION_OAUTH_VAULT_KEY`.

## Status stamp

`[VERIFIED: code/tests]` The code and tests are verified in this isolated
workspace. `[UNVERIFIED: live]` Deployment, migration 034 on the production
database, real Google client registration, and an authenticated callback/canary
remain live evidence gates. No “wired end-to-end” claim is made before those
gates are directly observed.
