-- Durable, append-only results for the one provider-free task class.
-- This does not grant filesystem, build, model, or external-provider authority.

alter table helmion.cora_agent_task_intents
  drop constraint if exists cora_agent_task_intents_task_type_check;
alter table helmion.cora_agent_task_intents
  add constraint cora_agent_task_intents_task_type_check
  check (task_type in ('workspace_preview', 'approved_knowledge_lookup'));

alter table helmion.cora_agent_task_transitions
  drop constraint if exists cora_agent_task_transitions_to_status_check;
alter table helmion.cora_agent_task_transitions
  add constraint cora_agent_task_transitions_to_status_check
  check (to_status in ('draft', 'prepared', 'completed'));

create table if not exists helmion.cora_agent_task_execution_results (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  task_id bigint not null references helmion.cora_agent_task_intents(id) on delete cascade,
  claim_id text not null check (char_length(claim_id) between 8 and 256),
  task_receipt_id text not null check (char_length(task_receipt_id) between 8 and 256),
  result_receipt_id text not null check (char_length(result_receipt_id) between 8 and 256),
  status text not null check (status in ('source_ready', 'unavailable', 'no_route', 'blocked', 'approval_required')),
  excerpts jsonb not null check (jsonb_typeof(excerpts) = 'array'),
  routing jsonb not null check (jsonb_typeof(routing) = 'object'),
  usage jsonb not null check (jsonb_typeof(usage) = 'object'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  execution text not null default 'provider_free_read_only' check (execution = 'provider_free_read_only'),
  agent_invocation text not null default 'performed' check (agent_invocation = 'performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  filesystem_mutation text not null default 'not_performed' check (filesystem_mutation = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, task_id),
  unique (tenant_id, result_receipt_id),
  unique (tenant_id, idempotency_key)
);

alter table helmion.cora_agent_task_execution_results
  add constraint cora_agent_task_result_claim_task_fk
  foreign key (tenant_id, task_id) references helmion.cora_agent_task_claims(tenant_id, task_id) on delete restrict;

create index if not exists cora_agent_task_result_tenant_time_idx
  on helmion.cora_agent_task_execution_results(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_cora_agent_task_result_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_agent_task_execution_results is append-only'; end;
$$;
drop trigger if exists cora_agent_task_result_append_only on helmion.cora_agent_task_execution_results;
create trigger cora_agent_task_result_append_only before update or delete on helmion.cora_agent_task_execution_results
for each row execute function helmion.reject_cora_agent_task_result_mutation();

alter table helmion.cora_agent_task_execution_results enable row level security;
drop policy if exists cora_agent_task_result_tenant_select on helmion.cora_agent_task_execution_results;
create policy cora_agent_task_result_tenant_select on helmion.cora_agent_task_execution_results
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_result_tenant_insert on helmion.cora_agent_task_execution_results;
create policy cora_agent_task_result_tenant_insert on helmion.cora_agent_task_execution_results
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
