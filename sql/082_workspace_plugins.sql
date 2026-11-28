-- Workspace plugins (plugin-install bite, 2026-11-09): the record
-- that a cloud plugin bundle is installed in a workspace.
--
-- A plugin in Helmian's cloud sense is an Agent Plugins 1.0 bundle
-- (plugin.json + mcp.json + skills/<name>/SKILL.md) a workspace
-- installs from Helmian's own shelf (src/cloud/plugin-bundles.mjs).
-- Installing one does two things and no more: it registers the
-- bundle's skills into the workspace's skill library (sql/075 —
-- those rows carry the provenance, created_by = 'plugin:<name>'),
-- and it writes ONE row here. It never creates a connector
-- connection: the bundle's declared MCP entries stay declarations,
-- and connecting one is the ordinary per-connector road in the
-- connector library (sql/074). This table is the install record,
-- not a second connector or skill store.
--
-- The row keeps the manifest as installed (jsonb — the bundle could
-- later leave the shelf, and the record must still say what was
-- installed), the declared catalog entry ids, and the skill ids the
-- install registered, so uninstall removes exactly its own skills
-- (and only while they still carry the plugin's provenance mark).
--
-- A sibling of the skill library, in the same schema, with the same
-- tenant-transaction + RLS discipline (075's pattern verbatim).
--
-- Numbering: 080 is the next free number after 079 on main at build
-- time (2026-11-09). This file is independently idempotent (create
-- if not exists / drop policy if exists), like its neighbours.
-- NOT applied by the build — the parent applies it on the box road.
create table if not exists helmion.workspace_plugins (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  version text not null check (char_length(version) between 1 and 32),
  description text,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  mcp_entry_ids text[] not null default '{}',
  skill_ids text[] not null default '{}',
  installed_by text not null check (char_length(installed_by) between 1 and 256),
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, name)
);
create index if not exists workspace_plugins_tenant_idx on helmion.workspace_plugins(tenant_id);
alter table helmion.workspace_plugins enable row level security;
drop policy if exists workspace_plugins_tenant_select on helmion.workspace_plugins;
create policy workspace_plugins_tenant_select on helmion.workspace_plugins for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists workspace_plugins_tenant_insert on helmion.workspace_plugins;
create policy workspace_plugins_tenant_insert on helmion.workspace_plugins for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists workspace_plugins_tenant_update on helmion.workspace_plugins;
create policy workspace_plugins_tenant_update on helmion.workspace_plugins for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists workspace_plugins_tenant_delete on helmion.workspace_plugins;
create policy workspace_plugins_tenant_delete on helmion.workspace_plugins for delete using (tenant_id = current_setting('helmion.tenant_id', true));
