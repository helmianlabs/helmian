-- Muse connector keys (Muse-to-Helmian connector, Bite 1,
-- 2026-11-12): the credential store for Helmian's own MCP entrance
-- (POST https://helmian.cloud/mcp, src/cloud/muse-connector.mjs).
--
-- Muse (Troy's personal agent in the Muse app) connects straight
-- into Troy's own Helmian account through this endpoint so it can
-- read Helmian's real state with proper tools instead of browser
-- pages and server probes. It NEVER runs through Scribe: Scribe and
-- Helmian are separate across the board, and this table is Helmian
-- only, like everything else in this schema.
--
-- Auth pick (Bite 1 research): a tenant-scoped API key, not an
-- inbound OAuth authorization server. This codebase has no inbound
-- OAuth AS to ride — connector-oauth-dcr.mjs is Helmian acting as
-- an OAuth CLIENT to outbound MCP servers, the admin console
-- delegates to an external OIDC issuer, and member sign-in rides
-- Clerk. A key is one table and one hash lookup, and it keeps every
-- plan guarantee:
--
--   - The TENANT IS FIXED BY THE KEY ROW (tenant_id below). No tool
--     takes a tenant or user parameter, so a key can only ever read
--     the one tenant it was minted for. No cross-tenant reach.
--   - Only the key's SHA-256 hash is stored (key_hash). The
--     plaintext is shown exactly once, at mint time, to the operator
--     running bin/mint-muse-connector-key.mjs, who places it into
--     Muse's secure connection storage through the secure flow.
--     It is never stored, never logged, and never read back.
--   - READ-ONLY is enforced server-side: the endpoint exposes only
--     read tools (list_agents, agent_health in this bite); there is
--     no write-shaped tool for a key to call.
--   - REVOCATION lives inside Helmian: set enabled = false (or
--     revoked_at) on the row — bin/mint-muse-connector-key.mjs
--     --disable <id> does exactly that — and the key stops working
--     on the next call. No key material exists anywhere else to hunt
--     down.
--
-- Row level security is enabled with NO policies, the
-- watch_ticket_secret (085) shape: the table is credential
-- machinery, not tenant surface data, so every role except the
-- table's owner (the role the cloud runtime and the migration
-- runner share) is denied. The endpoint resolves the tenant FROM
-- the key row before any tenant context exists, which is why this
-- table deliberately carries no tenant policy.
--
-- Numbering: 087 is the next free number after 086 on main at build
-- time (2026-11-12). Independently idempotent (create if not
-- exists), like its neighbours. NOT applied by the build; it is
-- applied on the box road. The endpoint is fail-soft until it
-- lands: with the table missing, every call answers 503 and nothing
-- is served.
create table if not exists helmion.muse_connector_keys (
  id text primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  label text not null check (char_length(label) between 1 and 120),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists muse_connector_keys_tenant_idx
  on helmion.muse_connector_keys (tenant_id);

alter table helmion.muse_connector_keys enable row level security;
