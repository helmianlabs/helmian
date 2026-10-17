-- Active project selection: durable per-user record of which workspace project
-- is currently selected in the cloud UI. One row per (tenant, subject); setting
-- a new project upserts. The project_key references workspace_projects so a
-- selection can never point at a project that does not exist. Project identity
-- is always the project_key string — never a filesystem path, never local-disk
-- semantics. Nothing here touches a filesystem or invokes a provider.
create table if not exists helmion.workspace_active_project_selections (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 256),
  project_key text not null,
  selected_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, subject),
  foreign key (tenant_id, project_key) references helmion.workspace_projects(tenant_id, project_key) on delete cascade
);

create index if not exists workspace_active_project_selections_tenant_idx
  on helmion.workspace_active_project_selections(tenant_id, subject);
