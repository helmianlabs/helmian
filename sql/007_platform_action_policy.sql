-- Platform-global kill switches for the fixed signed-AimForge action release.
--
-- These three booleans can only remove tools from the compiled release. They
-- cannot add names, URLs, providers, models, commands, or customer authority.
-- The sole managing tenant is the explicitly enrolled Helmian platform tenant.

create table if not exists helmion.platform_action_policy (
  policy_key text primary key check (policy_key = 'signed_aimforge_actions'),
  managing_tenant_id text not null references helmion.tenants(tenant_id)
    check (managing_tenant_id = 'helmian-platform'),
  version bigint not null default 1 check (version > 0),
  dispatch_board_summary_enabled boolean not null default true,
  prepare_driver_message_enabled boolean not null default true,
  department_handoff_enabled boolean not null default true,
  updated_by text not null check (nullif(trim(updated_by), '') is not null),
  updated_at timestamptz not null default clock_timestamp()
);

alter table helmion.platform_action_policy enable row level security;

drop policy if exists platform_action_policy_manager_context on helmion.platform_action_policy;
create policy platform_action_policy_manager_context on helmion.platform_action_policy
  using (managing_tenant_id = current_setting('helmion.tenant_id', true))
  with check (managing_tenant_id = current_setting('helmion.tenant_id', true));
