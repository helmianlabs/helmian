-- Runner provider presence: presence-only booleans so the cloud UI can show
-- which providers are connected on the runner. The cloud NEVER holds the
-- credentials themselves (migration 019 contract): this table carries
-- connected true/false plus a timestamp, nothing secret. The bridge reports
-- presence with its device token; the vault CLI never touches this table.
create table if not exists helmion.runner_provider_presence (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_name text not null check (provider_name in ('gemini', 'claude', 'openai', 'grok', 'xai')),
  connected boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, provider_name)
);

alter table helmion.runner_provider_presence enable row level security;
drop policy if exists runner_provider_presence_tenant_access on helmion.runner_provider_presence;
create policy runner_provider_presence_tenant_access on helmion.runner_provider_presence
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
