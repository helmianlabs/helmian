-- Tenant-scoped desktop console command intents.
-- This records a bounded command request and receipt; it never invokes a
-- filesystem tool, worker, provider, build, or desktop action.
create table if not exists helmion.console_command_intents (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  command_name text not null check (command_name in ('workspace_context','list_agents','open_project','run_project_task','start_project_preview','stop_project_preview')),
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  status text not null default 'prepared' check (status = 'prepared'),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_id)
);

create index if not exists console_command_intents_tenant_time_idx
  on helmion.console_command_intents(tenant_id, created_at desc, id desc);

alter table helmion.console_command_intents enable row level security;
drop policy if exists console_command_intents_tenant_select on helmion.console_command_intents;
create policy console_command_intents_tenant_select on helmion.console_command_intents
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists console_command_intents_tenant_insert on helmion.console_command_intents;
create policy console_command_intents_tenant_insert on helmion.console_command_intents
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true) and actor_subject = current_setting('helmion.actor_subject', true));
