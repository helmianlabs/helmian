-- Tenant-scoped workspace preview intents. This records a bounded request/receipt,
-- not a build, provider call, agent invocation, or filesystem mutation.

create table if not exists helmion.cora_workspace_preview_intents (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  mode text not null check (mode in ('workspace','builder')),
  intent text not null check (intent in ('draft','prepare')),
  department text not null check (char_length(department) between 1 and 160),
  template_id text not null check (template_id ~ '^[a-z][a-z0-9-]{0,47}$'),
  title text not null check (char_length(title) between 1 and 240),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  status text not null default 'preview_ready' check (status in ('preview_ready','rejected')),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_id)
);

create index if not exists cora_workspace_preview_tenant_time_idx
  on helmion.cora_workspace_preview_intents(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_cora_workspace_preview_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_workspace_preview_intents is append-only'; end;
$$;
drop trigger if exists cora_workspace_preview_append_only on helmion.cora_workspace_preview_intents;
create trigger cora_workspace_preview_append_only before update or delete on helmion.cora_workspace_preview_intents
for each row execute function helmion.reject_cora_workspace_preview_mutation();

alter table helmion.cora_workspace_preview_intents enable row level security;
drop policy if exists cora_workspace_preview_tenant_select on helmion.cora_workspace_preview_intents;
create policy cora_workspace_preview_tenant_select on helmion.cora_workspace_preview_intents
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_workspace_preview_tenant_insert on helmion.cora_workspace_preview_intents;
create policy cora_workspace_preview_tenant_insert on helmion.cora_workspace_preview_intents
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
