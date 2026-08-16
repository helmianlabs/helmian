# Helmian Cloud provider connections

Desktop subscription artifacts never move into Helmian Cloud. Each tenant must
approve a separate cloud provider connection. Gemini now has a bounded callback
vertical slice: owner/admin authorization creates a PKCE transaction, the
callback claims the hashed state once, the documented Google token endpoint is
called, and the access/refresh material is encrypted before tenant-scoped
persistence. Raw codes, verifiers, access tokens, refresh tokens, and client
secrets are never persisted.

The slice is fail-closed until both production configuration and migration
evidence exist. `HELMION_GEMINI_OAUTH_CLIENT_ID` must be a real Google OAuth
client registration whose HTTPS redirect URI is
`https://helmian.cloud/api/admin/provider-oauth/gemini/callback`; the production
vault requires a base64url-encoded 32-byte `HELMION_OAUTH_VAULT_KEY`; and
`sql/034_helmion_provider_oauth.sql` must be applied to the target database.
OpenAI Codex, Claude, and direct Grok API OAuth remain named authority blockers;
no provider endpoint is guessed for them.
