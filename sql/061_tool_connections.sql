-- Tool connections: the registry that holds the truth about whether an
-- agent can actually CALL a service's tools (research note
-- helmian-connectors-2026-10-25 §4). One row per (tenant, scope, service).
--
-- THE RULE THIS TABLE EXISTS TO ENFORCE: state may read 'verified' only
-- because a probe connected to the server, ran tools/list, and wrote the
-- receipt columns (last_verified_at / probe_method / last_tools_count).
-- Registration writes intent ('registered'); nothing else in the system may
-- set 'verified' by hand. A failed probe sets state='failed', records the
-- error, and CLEARS the verified receipt, so a stale "Connected" can never
-- survive a connection that has stopped answering.
--
-- server_ref and credential_reference are REFERENCES, never secrets:
-- server_ref is a plugin + registration name, an endpoint URL, or a config
-- target; credential_reference is a pointer (a vault reference or a token
-- source declaration naming WHERE the credential lives). The credential
-- value itself is resolved at probe/turn time and is never stored here.
--
-- Numbering: 061 is the next free number. 059_user_profiles.sql was never
-- applied (it calls helmion.set_updated_at(), which does not exist) and is
-- left untouched; 060 is applied. This file is independently idempotent
-- (create if not exists / drop policy if exists), like its neighbours.
create table if not exists helmion.tool_connections (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  scope_kind text not null check (scope_kind in ('workspace','agent')),
  scope_id text not null check (char_length(scope_id) between 1 and 256),
  service_id text not null check (char_length(service_id) between 1 and 64),
  kind text not null check (kind in ('mcp-stdio','mcp-http','native')),
  server_ref text not null check (char_length(server_ref) between 1 and 1024),
  credential_reference jsonb check (credential_reference is null or jsonb_typeof(credential_reference) = 'object'),
  account_label text check (account_label is null or char_length(account_label) between 1 and 256),
  granted_scopes jsonb not null default '[]'::jsonb check (jsonb_typeof(granted_scopes) = 'array'),
  state text not null default 'registered' check (state in ('registered','probing','verified','failed','revoked')),
  last_verified_at timestamptz,
  probe_method text check (probe_method is null or char_length(probe_method) between 1 and 64),
  last_tools_count integer check (last_tools_count is null or last_tools_count >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, scope_kind, scope_id, service_id)
);
create index if not exists tool_connections_tenant_idx on helmion.tool_connections(tenant_id, scope_kind, scope_id);
alter table helmion.tool_connections enable row level security;
drop policy if exists tool_connections_tenant_select on helmion.tool_connections;
create policy tool_connections_tenant_select on helmion.tool_connections for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists tool_connections_tenant_insert on helmion.tool_connections;
create policy tool_connections_tenant_insert on helmion.tool_connections for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists tool_connections_tenant_update on helmion.tool_connections;
create policy tool_connections_tenant_update on helmion.tool_connections for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
