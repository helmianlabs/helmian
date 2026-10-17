-- Workspace project canvases: per-project scratchpad (note box + decision box),
-- the cloud counterpart of the desktop Canvas tab. One row per
-- (tenant, project); saving upserts. The composite foreign key to
-- workspace_projects(tenant_id, project_key) guarantees a canvas can never
-- attach to a project that does not exist (same lesson as the 048/049/050
-- FK fix: workspace_projects has a composite primary key, so a FK on
-- project_key alone is rejected by Postgres).
-- Canvas content is plain user text: no provider calls, no secrets, no
-- external writes. Renderers must escape it (stored-XSS risk in
-- multi-user tenants).
create table if not exists helmion.workspace_project_canvases (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  project_key text not null,
  note_text text not null default '',
  decision_text text not null default '',
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, project_key),
  foreign key (tenant_id, project_key) references helmion.workspace_projects(tenant_id, project_key) on delete cascade
);

create index if not exists workspace_project_canvases_tenant_idx
  on helmion.workspace_project_canvases(tenant_id, project_key);
