-- Agent task execution runs: durable per-task outcome receipts written by the
-- cloud worker when it triages a prepared task. Mirrors helmion.console_command_runs.
-- The intents table stays append-only and receipt-only; runs are the execution
-- record. Nothing here invokes a provider, agent, build, or filesystem — a task
-- that needs a project workspace is recorded as needs_desktop for the paired
-- Helmian desktop (or a future runner) to pick up.
create table if not exists helmion.cora_agent_task_runs (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  task_id bigint not null references helmion.cora_agent_task_intents(id) on delete cascade,
  task_receipt_id text not null check (char_length(task_receipt_id) between 8 and 256),
  worker_id text not null check (char_length(worker_id) between 1 and 128),
  outcome text not null check (outcome in ('completed', 'failed', 'needs_desktop', 'refused')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, task_id)
);

create index if not exists cora_agent_task_runs_tenant_time_idx
  on helmion.cora_agent_task_runs(tenant_id, created_at desc, id desc);
