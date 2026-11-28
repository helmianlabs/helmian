create table if not exists helmion.organization_database_registry (
  tenant_id text primary key references helmion.tenants(tenant_id) on delete cascade,
  logical_database_locator text not null check (logical_database_locator ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  secret_reference_name text not null check (secret_reference_name ~ '^[a-z0-9][a-z0-9._:/-]{0,255}$' and secret_reference_name !~ '://'),
  region text not null check (region ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  lifecycle text not null check (lifecycle in ('planned','provisioning','active','suspended','retired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists organization_database_registry_lifecycle_idx
  on helmion.organization_database_registry(lifecycle, region);

alter table helmion.organization_database_registry enable row level security;
drop policy if exists organization_database_registry_tenant_select on helmion.organization_database_registry;
create policy organization_database_registry_tenant_select on helmion.organization_database_registry
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
