-- Append-only worker completion evidence. A claim is not execution; absent a
-- future worker evidence receipt, task completion remains not_executed.

create table if not exists helmion.cora_agent_task_completion_receipts (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  task_id bigint not null references helmion.cora_agent_task_intents(id) on delete cascade,
  claim_id text not null check (char_length(claim_id) between 8 and 256),
  worker_subject text not null check (char_length(worker_subject) between 1 and 256),
  worker_id text not null check (worker_id ~ '^worker:[a-z0-9][a-z0-9._:-]{0,95}$'),
  completion_status text not null check (completion_status in ('finished', 'failed')),
  execution text not null check (execution = 'performed'),
  evidence_ref text not null check (char_length(evidence_ref) between 8 and 512),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, task_id),
  unique (tenant_id, idempotency_key)
);

create index if not exists cora_agent_task_completion_tenant_time_idx
  on helmion.cora_agent_task_completion_receipts(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_cora_agent_task_completion_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_agent_task_completion_receipts is append-only'; end;
$$;
drop trigger if exists cora_agent_task_completion_append_only on helmion.cora_agent_task_completion_receipts;
create trigger cora_agent_task_completion_append_only before update or delete on helmion.cora_agent_task_completion_receipts
for each row execute function helmion.reject_cora_agent_task_completion_mutation();

alter table helmion.cora_agent_task_completion_receipts enable row level security;
drop policy if exists cora_agent_task_completion_tenant_select on helmion.cora_agent_task_completion_receipts;
create policy cora_agent_task_completion_tenant_select on helmion.cora_agent_task_completion_receipts
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_completion_tenant_insert on helmion.cora_agent_task_completion_receipts;
create policy cora_agent_task_completion_tenant_insert on helmion.cora_agent_task_completion_receipts
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
