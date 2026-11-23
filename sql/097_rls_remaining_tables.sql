-- Row-level security for the last sixteen tables: the set is complete.
--
-- These tables carried no tenant_id column, so no tenant policy could
-- name them: the local kernel's project-slug tables (projects,
-- maestro_leases, maestro_handoffs, maestro_operations,
-- project_checkpoints, blockers, autonomy_rules, context_entries,
-- governance_actions, telemetry_events, advisory_reviews,
-- as2_outbound, human_handoff_confirmations), the billing tables
-- (billing_entitlements, billing_events, keyed by customer), and
-- human_identity_keys (a person's keys, global by design).
--
-- Each table gains a nullable tenant_id. Rows a writer stamps with a
-- tenant are bound by the same current-context policy as every other
-- table; rows without a stamp stay visible to the owner connection
-- only, which is the strict reading of tenant isolation for legacy
-- and local-kernel data. The backfill below stamps the rows whose
-- project_slug already IS a tenant id (the cloud's seeded pattern);
-- every other row is left unstamped rather than guessed into a
-- tenant.
--
-- After this migration every table in the helmion schema has
-- row-level security switched on: 93 carry a tenant policy, and the
-- two secret stores (muse_connector_keys, watch_ticket_secret) carry
-- none, which leaves them deny-all to non-owner connections.
-- Production connects as the owner, which bypasses row-level
-- security, so applying this changes no production behaviour on its
-- own; it binds every non-owner connection to the same boundary.

alter table helmion.projects add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.maestro_leases add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.maestro_handoffs add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.maestro_operations add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.project_checkpoints add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.blockers add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.autonomy_rules add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.context_entries add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.governance_actions add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.telemetry_events add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.advisory_reviews add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.as2_outbound add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.human_handoff_confirmations add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.billing_entitlements add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.billing_events add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;
alter table helmion.human_identity_keys add column if not exists tenant_id text references helmion.tenants(tenant_id) on delete cascade;

update helmion.projects set tenant_id = slug where tenant_id is null and slug in (select tenant_id from helmion.tenants);
update helmion.maestro_leases set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.maestro_handoffs set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.maestro_operations set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.project_checkpoints set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.blockers set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.autonomy_rules set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.context_entries set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.governance_actions set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.telemetry_events set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.as2_outbound set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);
update helmion.human_handoff_confirmations set tenant_id = project_slug where tenant_id is null and project_slug in (select tenant_id from helmion.tenants);

alter table helmion.projects enable row level security;
alter table helmion.maestro_leases enable row level security;
alter table helmion.maestro_handoffs enable row level security;
alter table helmion.maestro_operations enable row level security;
alter table helmion.project_checkpoints enable row level security;
alter table helmion.blockers enable row level security;
alter table helmion.autonomy_rules enable row level security;
alter table helmion.context_entries enable row level security;
alter table helmion.governance_actions enable row level security;
alter table helmion.telemetry_events enable row level security;
alter table helmion.advisory_reviews enable row level security;
alter table helmion.as2_outbound enable row level security;
alter table helmion.human_handoff_confirmations enable row level security;
alter table helmion.billing_entitlements enable row level security;
alter table helmion.billing_events enable row level security;
alter table helmion.human_identity_keys enable row level security;

drop policy if exists projects_tenant_isolation on helmion.projects;
create policy projects_tenant_isolation on helmion.projects
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists maestro_leases_tenant_isolation on helmion.maestro_leases;
create policy maestro_leases_tenant_isolation on helmion.maestro_leases
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists maestro_handoffs_tenant_isolation on helmion.maestro_handoffs;
create policy maestro_handoffs_tenant_isolation on helmion.maestro_handoffs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists maestro_operations_tenant_isolation on helmion.maestro_operations;
create policy maestro_operations_tenant_isolation on helmion.maestro_operations
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists project_checkpoints_tenant_isolation on helmion.project_checkpoints;
create policy project_checkpoints_tenant_isolation on helmion.project_checkpoints
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists blockers_tenant_isolation on helmion.blockers;
create policy blockers_tenant_isolation on helmion.blockers
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists autonomy_rules_tenant_isolation on helmion.autonomy_rules;
create policy autonomy_rules_tenant_isolation on helmion.autonomy_rules
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists context_entries_tenant_isolation on helmion.context_entries;
create policy context_entries_tenant_isolation on helmion.context_entries
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists governance_actions_tenant_isolation on helmion.governance_actions;
create policy governance_actions_tenant_isolation on helmion.governance_actions
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists telemetry_events_tenant_isolation on helmion.telemetry_events;
create policy telemetry_events_tenant_isolation on helmion.telemetry_events
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists advisory_reviews_tenant_isolation on helmion.advisory_reviews;
create policy advisory_reviews_tenant_isolation on helmion.advisory_reviews
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists as2_outbound_tenant_isolation on helmion.as2_outbound;
create policy as2_outbound_tenant_isolation on helmion.as2_outbound
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists human_handoff_confirmations_tenant_isolation on helmion.human_handoff_confirmations;
create policy human_handoff_confirmations_tenant_isolation on helmion.human_handoff_confirmations
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists billing_entitlements_tenant_isolation on helmion.billing_entitlements;
create policy billing_entitlements_tenant_isolation on helmion.billing_entitlements
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists billing_events_tenant_isolation on helmion.billing_events;
create policy billing_events_tenant_isolation on helmion.billing_events
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists human_identity_keys_tenant_isolation on helmion.human_identity_keys;
create policy human_identity_keys_tenant_isolation on helmion.human_identity_keys
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
