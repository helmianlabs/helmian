-- Organization-scoped budget allocation metadata.
-- This does not alter the append-only provider usage ledger.

create table if not exists helmion.cora_usage_budget_allocations (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  allocation_key text not null check (char_length(allocation_key) between 1 and 160),
  department text check (department is null or char_length(department) between 1 and 160),
  cost_center text check (cost_center is null or char_length(cost_center) between 1 and 160),
  soft_limit_minor numeric(18,6) check (soft_limit_minor is null or soft_limit_minor >= 0),
  hard_limit_minor numeric(18,6) check (hard_limit_minor is null or hard_limit_minor >= 0),
  enabled boolean not null default true,
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cora_usage_allocation_scope check (department is not null or cost_center is not null),
  constraint cora_usage_allocation_order check (soft_limit_minor is null or hard_limit_minor is null or soft_limit_minor <= hard_limit_minor),
  unique (tenant_id, allocation_key)
);

create index if not exists cora_usage_budget_allocations_scope_idx on helmion.cora_usage_budget_allocations(tenant_id, department, cost_center);
alter table helmion.cora_usage_budget_allocations enable row level security;
drop policy if exists cora_usage_budget_allocations_tenant_isolation on helmion.cora_usage_budget_allocations;
create policy cora_usage_budget_allocations_tenant_isolation on helmion.cora_usage_budget_allocations
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
