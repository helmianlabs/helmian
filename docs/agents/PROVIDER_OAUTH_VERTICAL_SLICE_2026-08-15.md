# Provider/OAuth vertical-slice work log

> **Rule 0.13:** “NO time-cap handoff. Stick to the rules instead.”
>
> **Rule 0.001:** “Every factual claim I make to Troy must satisfy BOTH gates. No exceptions. Rule 0 says ‘do not lie.’ Rule 0.001 says HOW: prove every claim with primary-source citation AND trace every chain end-to-end with a citation on every link.”

## Scope

This slice owns only Helmian Cloud provider connection/OAuth code for
`openai_codex`, `claude`, `gemini`, and `grok`. It does not change Forge TMS,
Cora runtime behavior, domain routing, or the provider invocation adapters in
`src/agent/providers.mjs`.

## Mandatory audit questions

1. TRACE the return value, don't grep the function — where does its return value persist? Cite the writer's file:line or stamp GAP.
2. READ the body of every important-sounding name — names lie.
3. Verify against CODE, not a prior handoff.
4. Give sub-AIs the CODE, not the handoff.
5. "Shipped" ≠ "wired end-to-end" — draw A→B→C→D→E, each transition cited.

## Authority result

| Provider | Reviewed primary authority | Implemented state |
|---|---|---|
| OpenAI Codex | [OpenAI API authentication](https://platform.openai.com/docs/api-reference/authentication?lang=go) says the API uses API keys. | Explicit `blocked_no_public_cloud_oauth_contract`; no guessed endpoint. |
| Claude | [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) documents an interactive Console OAuth login but does not publish a third-party cloud authorization/token endpoint. | Explicit `blocked_no_public_cloud_oauth_contract`; API-key connection remains the available documented server seam. |
| Gemini | [Gemini OAuth quickstart](https://ai.google.dev/gemini-api/docs/oauth?hl=en) documents Google OAuth and cached access/refresh credentials; [GenerateContent](https://ai.google.dev/api/generate-content) documents the Gemini API endpoint and scopes. | Real authorization URL, PKCE token exchange, and vault handoff seam. |
| Grok | [xAI enterprise docs](https://docs.x.ai/build/enterprise) identify `auth.x.ai` for OAuth2/OIDC on Grok Build; [xAI quickstart](https://docs.x.ai/developers/quickstart) documents direct API use with `XAI_API_KEY`. | Explicit `blocked_first_party_oauth_only`; no direct-API token endpoint guessed. |

## End-to-end trace

### Gemini OAuth code path

`admin owner/admin input`
→ `createCloudOAuthAuthorization` validates tenant, role, HTTPS redirect, PKCE,
client ID, and approved scopes in
`src/cloud/oauth-connection-contract.mjs`
→ `buildCloudOAuthAuthorizationUrl` returns Google’s authorization URL in
`src/cloud/provider-oauth-authority.mjs`
→ `exchangeCloudOAuthCode` verifies PKCE and POSTs the authorization code to
the documented Google token endpoint in
`src/cloud/provider-oauth-flow.mjs`
→ `vaultAdapter.storeOAuthTokens` receives token material without returning it
to the caller in `src/cloud/provider-oauth-flow.mjs`
→ `createProviderConnectionRepository().exchangeOAuth` writes only the tenant,
provider, auth mode, vault reference, pending lifecycle, adapter marker, and
actor subject to `helmion.provider_connections` in
`src/cloud/provider-connection-repository.mjs`
→ the connection remains pending and tools/invocation remain disabled until a
separate live canary proves the provider adapter.

### Unsupported provider path

`openai_codex|claude|grok`
→ `getCloudProviderOAuthAuthority` returns a named blocker
→ `createCloudOAuthAuthorization` returns `provider_oauth_blocked` with no
provider endpoint or authorization URL
→ `exchangeCloudOAuthCode` returns `tokenExchange=blocked` without calling
`fetch`
→ no vault write and no database activation occur.

## Evidence

- Focused tests: `node --test test/cloud-oauth-connection-contract.test.mjs test/provider-oauth-flow.test.mjs test/provider-connection-repository.test.mjs` — 13 passed, 0 failed.
- Static checks: `node --check` passed for the four changed cloud modules.
- Deployment: Fly app `helmian-cloud` release version `46` is started with one passing machine check; live `https://helmian.cloud/admin` returned HTTP 200 and unauthenticated `https://helmian.cloud/api/admin/session` returned HTTP 403. The direct `/healthz` probe returned HTTP 401 without its bearer token, so authenticated readiness is not claimed here.
- The storage seam is intentionally not live-complete: the default adapter returns `external_vault_not_configured` in `src/cloud/encrypted-vault-adapter.mjs`; no production vault implementation or Gemini client registration was present in the reviewed code.
- This slice is not “all four providers wired.” The remaining live evidence is a registered Gemini OAuth client, deployed callback route, production encrypted vault adapter, and non-mutating Gemini canary. OpenAI Codex, Claude, and direct Grok API OAuth remain provider-authority blockers.
