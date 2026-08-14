-- Tenant-scoped provider usage ledger and budget contract.
-- Additive only. Actual usage/cost remains NULL until a trusted provider receipt exists.

create table if not exists helmion.cora_usage_budgets (
  tenant_id text primary key references helmion.tenants(tenant_id) on delete cascade,
  period text not null check (period in ('monthly','calendar_month','rolling_30d')),
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  soft_limit_minor bigint check (soft_limit_minor is null or soft_limit_minor >= 0),
  hard_limit_minor bigint check (hard_limit_minor is null or hard_limit_minor >= 0),
  low_cost_limit_minor bigint check (low_cost_limit_minor is null or low_cost_limit_minor >= 0),
  policy_state text not null default 'active' check (policy_state in ('active','soft_exceeded','hard_exceeded','paused')),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cora_usage_budget_order check (
    (soft_limit_minor is null or hard_limit_minor is null or soft_limit_minor <= hard_limit_minor)
    and (low_cost_limit_minor is null or soft_limit_minor is null or low_cost_limit_minor <= soft_limit_minor)
  )
);

create table if not exists helmion.cora_provider_usage (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  department text check (department is null or char_length(department) between 1 and 160),
  cost_center text check (cost_center is null or char_length(cost_center) between 1 and 160),
  user_subject text not null check (char_length(user_subject) between 1 and 256),
  action_type text not null check (char_length(action_type) between 1 and 160),
  workflow text check (workflow is null or char_length(workflow) between 1 and 160),
  provider text not null check (char_length(provider) between 1 and 80),
  model text not null check (char_length(model) between 1 and 160),
  modality text not null check (modality in ('text','audio','image','video','multimodal')),
  requested_tokens bigint check (requested_tokens is null or requested_tokens >= 0),
  actual_tokens bigint check (actual_tokens is null or actual_tokens >= 0),
  audio_seconds numeric(18,6) check (audio_seconds is null or audio_seconds >= 0),
  image_units numeric(18,6) check (image_units is null or image_units >= 0),
  video_seconds numeric(18,6) check (video_seconds is null or video_seconds >= 0),
  estimated_cost_minor numeric(18,6) check (estimated_cost_minor is null or estimated_cost_minor >= 0),
  reconciled_cost_minor numeric(18,6) check (reconciled_cost_minor is null or reconciled_cost_minor >= 0),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  provider_request_ref text check (provider_request_ref is null or char_length(provider_request_ref) between 1 and 512),
  policy_decision text not null check (policy_decision in ('allow','step-up','deny','not_evaluated')),
  approval_ref text check (approval_ref is null or char_length(approval_ref) between 1 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  status text not null check (status in ('requested','started','completed','failed','cancelled','reconciled')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key),
  constraint cora_usage_approval_pair check (policy_decision <> 'step-up' or approval_ref is not null),
  constraint cora_usage_reconciled_status check (reconciled_cost_minor is null or status = 'reconciled')
);

create index if not exists cora_provider_usage_tenant_time_idx on helmion.cora_provider_usage(tenant_id, created_at desc, id desc);
create index if not exists cora_provider_usage_dimensions_idx on helmion.cora_provider_usage(tenant_id, department, cost_center, user_subject, provider, model, modality);

create or replace function helmion.reject_cora_usage_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_provider_usage is append-only'; end;
$$;
drop trigger if exists cora_provider_usage_append_only on helmion.cora_provider_usage;
create trigger cora_provider_usage_append_only before update or delete on helmion.cora_provider_usage
for each row execute function helmion.reject_cora_usage_mutation();

alter table helmion.cora_usage_budgets enable row level security;
alter table helmion.cora_provider_usage enable row level security;
drop policy if exists cora_usage_budgets_tenant_isolation on helmion.cora_usage_budgets;
create policy cora_usage_budgets_tenant_isolation on helmion.cora_usage_budgets
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_provider_usage_tenant_isolation on helmion.cora_provider_usage;
create policy cora_provider_usage_tenant_isolation on helmion.cora_provider_usage
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_provider_usage_tenant_insert on helmion.cora_provider_usage
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
