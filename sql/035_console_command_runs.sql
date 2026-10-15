-- Append-only results written by the cloud console worker
-- (src/cloud/console-command-worker.mjs). One run per intent. The cloud worker
-- only executes read-only, tenant-scoped commands; anything that needs a
-- filesystem or a provider session is recorded as 'needs_desktop'.
create table if not exists helmion.console_command_runs (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  intent_id bigint not null references helmion.console_command_intents(id) on delete cascade,
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  worker_id text not null check (worker_id ~ '^worker:[a-z0-9][a-z0-9._:-]{0,95}$'),
  outcome text not null check (outcome in ('completed','needs_desktop','refused','failed')),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, intent_id)
);
create index if not exists console_command_runs_tenant_time_idx
  on helmion.console_command_runs(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_console_command_run_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.console_command_runs is append-only'; end;
$$;
drop trigger if exists console_command_runs_append_only on helmion.console_command_runs;
create trigger console_command_runs_append_only before update or delete on helmion.console_command_runs
for each row execute function helmion.reject_console_command_run_mutation();

alter table helmion.console_command_runs enable row level security;
drop policy if exists console_command_runs_tenant_select on helmion.console_command_runs;
create policy console_command_runs_tenant_select on helmion.console_command_runs
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
