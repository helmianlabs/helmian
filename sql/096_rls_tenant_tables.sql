-- Row-level security for the remaining tenant-keyed tables.
--
-- Tenant separation is enforced in the application on every request;
-- this migration extends the database's own second layer to the eleven
-- tables that carry a tenant_id column but had no row-level security:
-- each gets the same current-context policy shape as sql/004 and
-- sql/009 (the request's helmion.tenant_id setting names the one
-- tenant a non-owner connection may see or write).
--
-- Production connects as the table owner, which bypasses row-level
-- security, so applying this changes no production behaviour on its
-- own; it binds every non-owner connection (read replicas, analyst
-- roles, future least-privilege app roles) to the same boundary.
--
-- The tables still without row-level security after this migration
-- carry no tenant_id column at all: the local kernel's project-slug
-- tables (projects, maestro_*, blockers, autonomy_rules,
-- context_entries, governance_actions, telemetry_events,
-- project_checkpoints, advisory_reviews, as2_outbound,
-- human_handoff_confirmations), the billing tables (keyed by
-- customer), and human_identity_keys (global by design). Those need a
-- tenant key before a policy can name one, which is a separate
-- decision, not a silent omission.

alter table helmion.connector_outbound_messages enable row level security;
alter table helmion.cora_agent_task_runs enable row level security;
alter table helmion.cora_artifact_execution_runs enable row level security;
alter table helmion.guard_finding_acks enable row level security;
alter table helmion.guard_findings enable row level security;
alter table helmion.provenance_weighting_profiles enable row level security;
alter table helmion.workspace_active_project_selections enable row level security;
alter table helmion.workspace_project_canvases enable row level security;
alter table helmion.workspace_project_decisions enable row level security;
alter table helmion.workspace_repo_bindings enable row level security;
alter table helmion.workspace_write_leases enable row level security;

drop policy if exists connector_outbound_messages_tenant_isolation on helmion.connector_outbound_messages;
create policy connector_outbound_messages_tenant_isolation on helmion.connector_outbound_messages
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists cora_agent_task_runs_tenant_isolation on helmion.cora_agent_task_runs;
create policy cora_agent_task_runs_tenant_isolation on helmion.cora_agent_task_runs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists cora_artifact_execution_runs_tenant_isolation on helmion.cora_artifact_execution_runs;
create policy cora_artifact_execution_runs_tenant_isolation on helmion.cora_artifact_execution_runs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists guard_finding_acks_tenant_isolation on helmion.guard_finding_acks;
create policy guard_finding_acks_tenant_isolation on helmion.guard_finding_acks
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists guard_findings_tenant_isolation on helmion.guard_findings;
create policy guard_findings_tenant_isolation on helmion.guard_findings
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists provenance_weighting_profiles_tenant_isolation on helmion.provenance_weighting_profiles;
create policy provenance_weighting_profiles_tenant_isolation on helmion.provenance_weighting_profiles
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists workspace_active_project_selections_tenant_isolation on helmion.workspace_active_project_selections;
create policy workspace_active_project_selections_tenant_isolation on helmion.workspace_active_project_selections
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists workspace_project_canvases_tenant_isolation on helmion.workspace_project_canvases;
create policy workspace_project_canvases_tenant_isolation on helmion.workspace_project_canvases
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists workspace_project_decisions_tenant_isolation on helmion.workspace_project_decisions;
create policy workspace_project_decisions_tenant_isolation on helmion.workspace_project_decisions
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists workspace_repo_bindings_tenant_isolation on helmion.workspace_repo_bindings;
create policy workspace_repo_bindings_tenant_isolation on helmion.workspace_repo_bindings
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists workspace_write_leases_tenant_isolation on helmion.workspace_write_leases;
create policy workspace_write_leases_tenant_isolation on helmion.workspace_write_leases
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
