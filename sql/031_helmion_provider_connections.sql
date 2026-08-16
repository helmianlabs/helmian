-- Tenant-scoped provider connection metadata only.
-- Raw API keys, OAuth tokens, refresh tokens, and client secrets never enter this table.
-- credential_reference points to an external encrypted vault; adapter execution remains disabled until separately verified.
create table if not exists helmion.provider_connections (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_id text not null check (provider_id in ('openai_codex','claude','gemini','grok')),
  auth_mode text not null check (auth_mode in ('api_key','oauth_subscription')),
  credential_reference text not null check (char_length(credential_reference) between 1 and 200),
  lifecycle text not null default 'pending' check (lifecycle in ('pending','verified','disabled')),
  adapter text not null default 'not_configured' check (char_length(adapter) between 1 and 96),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, provider_id)
);
create index if not exists provider_connections_tenant_idx on helmion.provider_connections(tenant_id, provider_id);
alter table helmion.provider_connections enable row level security;
drop policy if exists provider_connections_tenant_select on helmion.provider_connections;
create policy provider_connections_tenant_select on helmion.provider_connections for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists provider_connections_tenant_insert on helmion.provider_connections;
create policy provider_connections_tenant_insert on helmion.provider_connections for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists provider_connections_tenant_update on helmion.provider_connections;
create policy provider_connections_tenant_update on helmion.provider_connections for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
