-- Tenant-scoped agent task intents. This records draft/prepare intent and an
-- append-only receipt; it does not invoke an agent, provider, build, or file system.

create table if not exists helmion.cora_agent_task_intents (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  task_type text not null check (task_type in ('workspace_preview')),
  goal text not null check (char_length(goal) between 1 and 1000),
  context_ref text check (context_ref is null or char_length(context_ref) between 1 and 240),
  department text check (department is null or char_length(department) between 1 and 160),
  cost_center text check (cost_center is null or char_length(cost_center) between 1 and 120),
  intent text not null check (intent in ('draft','prepare')),
  status text not null check (status in ('draft','prepared')),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  agent_invocation text not null default 'not_performed' check (agent_invocation = 'not_performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  filesystem_mutation text not null default 'not_performed' check (filesystem_mutation = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_id)
);

create table if not exists helmion.cora_agent_task_transitions (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  task_id bigint not null references helmion.cora_agent_task_intents(id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  from_status text check (from_status is null or from_status in ('draft','prepared')),
  to_status text not null check (to_status in ('draft','prepared')),
  reason text not null check (char_length(reason) between 1 and 240),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists cora_agent_task_tenant_time_idx
  on helmion.cora_agent_task_intents(tenant_id, created_at desc, id desc);
create index if not exists cora_agent_task_transition_task_idx
  on helmion.cora_agent_task_transitions(tenant_id, task_id, created_at desc, id desc);

create or replace function helmion.reject_cora_agent_task_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_agent_task tables are append-only'; end;
$$;
drop trigger if exists cora_agent_task_append_only on helmion.cora_agent_task_intents;
create trigger cora_agent_task_append_only before update or delete on helmion.cora_agent_task_intents
for each row execute function helmion.reject_cora_agent_task_mutation();
drop trigger if exists cora_agent_task_transition_append_only on helmion.cora_agent_task_transitions;
create trigger cora_agent_task_transition_append_only before update or delete on helmion.cora_agent_task_transitions
for each row execute function helmion.reject_cora_agent_task_mutation();

alter table helmion.cora_agent_task_intents enable row level security;
drop policy if exists cora_agent_task_tenant_select on helmion.cora_agent_task_intents;
create policy cora_agent_task_tenant_select on helmion.cora_agent_task_intents
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_tenant_insert on helmion.cora_agent_task_intents;
create policy cora_agent_task_tenant_insert on helmion.cora_agent_task_intents
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));

alter table helmion.cora_agent_task_transitions enable row level security;
drop policy if exists cora_agent_task_transition_tenant_select on helmion.cora_agent_task_transitions;
create policy cora_agent_task_transition_tenant_select on helmion.cora_agent_task_transitions
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_agent_task_transition_tenant_insert on helmion.cora_agent_task_transitions;
create policy cora_agent_task_transition_tenant_insert on helmion.cora_agent_task_transitions
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
