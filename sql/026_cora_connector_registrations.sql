-- Organization connector registration/readiness metadata only.
-- No signing secret, token, webhook, OAuth credential, provider call, or outbound delivery is stored here.
create table if not exists helmion.cora_connector_registrations (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider text not null check (provider in ('slack','discord')),
  lifecycle text not null check (lifecycle in ('draft','testing','approved','enabled','disabled')),
  enabled boolean not null default false,
  public_endpoint_ready boolean not null default false,
  secret_reference_name text check (secret_reference_name is null or char_length(secret_reference_name) between 1 and 160),
  allowed_inbound_channels jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_inbound_channels) = 'array'),
  last_verified_status text not null default 'not_verified' check (char_length(last_verified_status) between 1 and 64),
  last_verified_receipt_id text,
  last_verified_at timestamptz,
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, provider)
);
create index if not exists cora_connector_registrations_tenant_idx on helmion.cora_connector_registrations(tenant_id, provider);
alter table helmion.cora_connector_registrations enable row level security;
drop policy if exists cora_connector_registrations_tenant_select on helmion.cora_connector_registrations;
create policy cora_connector_registrations_tenant_select on helmion.cora_connector_registrations for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_connector_registrations_tenant_insert on helmion.cora_connector_registrations;
create policy cora_connector_registrations_tenant_insert on helmion.cora_connector_registrations for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_connector_registrations_tenant_update on helmion.cora_connector_registrations;
create policy cora_connector_registrations_tenant_update on helmion.cora_connector_registrations for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
