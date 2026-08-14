-- Append-only worker lifecycle evidence. This records future worker retry
-- decisions without implying that a retry or execution actually happened.
create table if not exists helmion.cora_agent_task_worker_lifecycle (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  task_id bigint not null,
  claim_id text not null check (char_length(claim_id) between 8 and 256),
  worker_subject text not null check (char_length(worker_subject) between 1 and 256),
  worker_id text not null check (worker_id ~ '^worker:[a-z0-9][a-z0-9._:-]{0,95}$'),
  attempt_no integer not null check (attempt_no between 1 and 1000),
  lifecycle_status text not null check (lifecycle_status in ('retry_scheduled', 'finished', 'failed')),
  execution text not null check (execution in ('not_performed', 'performed')),
  evidence_ref text not null check (char_length(evidence_ref) between 8 and 512),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text check (failure_code is null or char_length(failure_code) between 1 and 96),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),
  unique (tenant_id, task_id, attempt_no),
  unique (tenant_id, idempotency_key),
  check ((lifecycle_status = 'retry_scheduled' and execution = 'not_performed') or (lifecycle_status in ('finished', 'failed') and execution = 'performed'))
);

create index if not exists cora_agent_task_worker_lifecycle_tenant_task_idx
  on helmion.cora_agent_task_worker_lifecycle(tenant_id, task_id, attempt_no desc);

create or replace function helmion.reject_cora_agent_task_worker_lifecycle_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_agent_task_worker_lifecycle is append-only'; end;
$$;

drop trigger if exists cora_agent_task_worker_lifecycle_append_only on helmion.cora_agent_task_worker_lifecycle;
create trigger cora_agent_task_worker_lifecycle_append_only before update or delete on helmion.cora_agent_task_worker_lifecycle
for each row execute function helmion.reject_cora_agent_task_worker_lifecycle_mutation();

alter table helmion.cora_agent_task_worker_lifecycle enable row level security;
drop policy if exists cora_agent_task_worker_lifecycle_tenant_select on helmion.cora_agent_task_worker_lifecycle;
create policy cora_agent_task_worker_lifecycle_tenant_select on helmion.cora_agent_task_worker_lifecycle
for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_worker_lifecycle_tenant_insert on helmion.cora_agent_task_worker_lifecycle;
create policy cora_agent_task_worker_lifecycle_tenant_insert on helmion.cora_agent_task_worker_lifecycle
for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
