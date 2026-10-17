-- Workspace repo bindings: durable per-project record of which GitHub repository
-- a workspace project is bound to. This is a NEW clean table, deliberately
-- separate from helmion.github_app_workspace_source_bindings (created by the
-- dead migration 040_github_app_workspace_source_bindings, an unshipped
-- app-builder feature with zero code references). That table is never read or
-- written by any code and must not be revived; bindings live here instead.
-- A binding is metadata only — it records the association, it never fetches
-- repo contents (that is a future trust-boundary decision). Owner/admin-only
-- to create; every create is audit-logged. Nothing here touches a filesystem
-- or invokes a provider.
create table if not exists helmion.workspace_repo_bindings (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  project_key text not null,
  repo_owner text not null check (repo_owner ~ '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$'),
  repo_name text not null check (repo_name ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
  installation_id text check (installation_id is null or char_length(installation_id) between 1 and 64),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, project_key),
  foreign key (tenant_id, project_key) references helmion.workspace_projects(tenant_id, project_key) on delete cascade
);

create index if not exists workspace_repo_bindings_tenant_idx
  on helmion.workspace_repo_bindings(tenant_id, project_key);
