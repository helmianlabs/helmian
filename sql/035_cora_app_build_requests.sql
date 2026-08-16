-- Tenant-scoped declarative app-build drafts. This is a validated request ledger,
-- not generated code, a provider call, a worker invocation, filesystem mutation, or deployment.
create table if not exists helmion.cora_app_build_requests (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  title text not null check (char_length(title) between 1 and 240),
  department text not null check (char_length(department) between 1 and 160),
  route text not null check (route ~ '^/[a-z0-9][a-z0-9-]{0,47}(/[a-z0-9][a-z0-9-]{0,47}){0,3}$'),
  description text not null check (char_length(description) between 1 and 1200),
  components jsonb not null check (jsonb_typeof(components) = 'array' and jsonb_array_length(components) between 1 and 32),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  agent_invocation text not null default 'not_performed' check (agent_invocation = 'not_performed'),
  filesystem_mutation text not null default 'not_performed' check (filesystem_mutation = 'not_performed'),
  publication text not null default 'not_performed' check (publication = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, route, title), unique (tenant_id, idempotency_key), unique (tenant_id, receipt_id)
);
create index if not exists cora_app_build_request_tenant_time_idx on helmion.cora_app_build_requests(tenant_id, created_at desc, id desc);
create or replace function helmion.reject_cora_app_build_request_mutation() returns trigger language plpgsql as $$ begin raise exception 'helmion.cora_app_build_requests is append-only'; end; $$;
create trigger cora_app_build_request_append_only before update or delete on helmion.cora_app_build_requests for each row execute function helmion.reject_cora_app_build_request_mutation();
alter table helmion.cora_app_build_requests enable row level security;
create policy cora_app_build_request_tenant_select on helmion.cora_app_build_requests for select using (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_app_build_request_tenant_insert on helmion.cora_app_build_requests for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
