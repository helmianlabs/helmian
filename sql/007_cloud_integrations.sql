-- Tenant-scoped feature availability for the Helmian Cloud integration seam.
-- This table stores no provider tokens, OAuth codes, or client secrets.

create table if not exists helmion.cloud_integrations (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  integration_id text not null check (integration_id in ('envoy','discord','slack','github')),
  enabled boolean not null default false,
  updated_by text not null check (nullif(trim(updated_by), '') is not null),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, integration_id)
);

create index if not exists cloud_integrations_tenant_idx
  on helmion.cloud_integrations(tenant_id, integration_id);

alter table helmion.cloud_integrations enable row level security;

drop policy if exists cloud_integrations_current_context on helmion.cloud_integrations;
create policy cloud_integrations_current_context on helmion.cloud_integrations
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
