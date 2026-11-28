-- Connector OAuth pending, DCR leg (2026-11-09): a handshake
-- started on the self-registering road (dynamic client
-- registration, connector-oauth-dcr.mjs) must remember two more
-- things across the redirect so the callback can finish the token
-- exchange from the pending row alone:
--
--   client_secret — the secret the authorization server issued at
--                   registration, when it issued one. Null for a
--                   public client (token auth method "none", where
--                   PKCE carries the handshake) and null on every
--                   fixed-provider row (GitHub's secret lives in
--                   the environment, never on a row). Born with the
--                   handshake, deleted with it (the row is consumed
--                   by the callback or dies at its 15-minute TTL).
--   token_endpoint — the authorization server's token endpoint,
--                   from its published metadata at start time.
--   token_endpoint_auth_method — how the issued client
--                   authenticates at that endpoint, as recorded by
--                   the registration answer.
--
-- Nullable throughout: existing rows and the fixed road are
-- untouched. Until this migration is applied, the pending store
-- fails soft on DCR saves exactly as it does for a missing
-- sql/078 table — the road answers "not switched on yet" and every
-- other library write keeps working.

alter table helmion.connector_oauth_pending
  add column if not exists client_secret text,
  add column if not exists token_endpoint text,
  add column if not exists token_endpoint_auth_method text;
