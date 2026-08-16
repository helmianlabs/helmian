-- Tenant-scoped hosted workspace project registry.
-- This is metadata only: it does not claim access to a desktop filesystem or
-- source repository. A project becomes executable only through a separately
-- verified worker seam.
create table if not exists helmion.workspace_projects (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  project_key text not null check (project_key ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  display_name text not null check (char_length(trim(display_name)) between 1 and 160),
  source_kind text not null check (source_kind in ('cloud','desktop_mirror','external')),
  default_branch text not null default 'main' check (char_length(trim(default_branch)) between 1 and 160),
  lifecycle text not null default 'active' check (lifecycle in ('active','archived')),
  created_by_subject text not null check (char_length(trim(created_by_subject)) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, project_key)
);

create index if not exists workspace_projects_tenant_lifecycle_idx
  on helmion.workspace_projects(tenant_id, lifecycle, display_name);

alter table helmion.workspace_projects enable row level security;
drop policy if exists workspace_projects_tenant_select on helmion.workspace_projects;
create policy workspace_projects_tenant_select on helmion.workspace_projects
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists workspace_projects_tenant_admin_write on helmion.workspace_projects;
create policy workspace_projects_tenant_admin_write on helmion.workspace_projects
  for all using (
    tenant_id = current_setting('helmion.tenant_id', true)
    and current_setting('helmion.actor_role', true) in ('owner','admin')
  ) with check (
    tenant_id = current_setting('helmion.tenant_id', true)
    and current_setting('helmion.actor_role', true) in ('owner','admin')
    and created_by_subject = current_setting('helmion.actor_subject', true)
  );
