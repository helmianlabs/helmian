-- Server-owned worker claims for prepared task intents. A claim is not execution.

create table if not exists helmion.cora_agent_task_claims (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  task_id bigint not null references helmion.cora_agent_task_intents(id) on delete cascade,
  task_receipt_id text not null check (char_length(task_receipt_id) between 8 and 256),
  worker_subject text not null check (char_length(worker_subject) between 1 and 256),
  worker_id text not null check (worker_id ~ '^worker:[a-z0-9][a-z0-9._:-]{0,95}$'),
  claim_id text not null check (char_length(claim_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  claim_status text not null default 'claimed' check (claim_status = 'claimed'),
  task_status text not null default 'prepared' check (task_status = 'prepared'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  agent_invocation text not null default 'not_performed' check (agent_invocation = 'not_performed'),
  filesystem_mutation text not null default 'not_performed' check (filesystem_mutation = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, task_id),
  unique (tenant_id, claim_id),
  unique (tenant_id, idempotency_key)
);

create index if not exists cora_agent_task_claim_tenant_time_idx
  on helmion.cora_agent_task_claims(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_cora_agent_task_claim_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_agent_task_claims is append-only'; end;
$$;
drop trigger if exists cora_agent_task_claim_append_only on helmion.cora_agent_task_claims;
create trigger cora_agent_task_claim_append_only before update or delete on helmion.cora_agent_task_claims
for each row execute function helmion.reject_cora_agent_task_claim_mutation();

alter table helmion.cora_agent_task_claims enable row level security;
drop policy if exists cora_agent_task_claim_tenant_select on helmion.cora_agent_task_claims;
create policy cora_agent_task_claim_tenant_select on helmion.cora_agent_task_claims
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_claim_tenant_insert on helmion.cora_agent_task_claims;
create policy cora_agent_task_claim_tenant_insert on helmion.cora_agent_task_claims
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
