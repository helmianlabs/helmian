-- Tenant attribute rules (ABAC): the rules an Organization admin creates in
-- the panel, stored per tenant and evaluated by the attribute policy engine
-- alongside the shipped default rules. Defaults stay the floor: tenant rules
-- can refuse an action the defaults allow, never widen past them silently —
-- evaluation is deny-wins over the combined set.
create table if not exists helmion.tenant_attribute_rules (
  id bigserial primary key,
  tenant_id uuid not null,
  rule_id text not null,
  effect text not null check (effect in ('ALLOW', 'DENY')),
  actions jsonb not null,
  conditions jsonb not null default '{}'::jsonb,
  reason text,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, rule_id)
);

create index if not exists tenant_attribute_rules_tenant_idx
  on helmion.tenant_attribute_rules(tenant_id, active);

alter table helmion.tenant_attribute_rules enable row level security;

drop policy if exists tenant_attribute_rules_current_context on helmion.tenant_attribute_rules;
create policy tenant_attribute_rules_current_context on helmion.tenant_attribute_rules
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
