-- Skill library (slash-skills DESIGN §2.2, build bite S1): Helmian's
-- own skills — instruction text a workspace's people author (typed or
-- pasted in the channel) and attach to a message for one agent or for
-- every agent (Troy's order, 2026-11-08).
--
-- ONE table, in the helmion schema beside the connector library
-- (sql/074). A sibling store, not part of the connector tables: a
-- skill has no broker mode, no connection, no snapshot — it is one
-- record of text with a scope. The key is (tenant_id, id), NOT
-- (tenant, seat, entry) like a connector: a connector exists once per
-- seat because each seat holds its own connection, while a skill is
-- authored once per workspace and its targets are data on the record
-- (scope / seat_ids) — per-seat copies would make one edit into
-- fourteen. Scope is still only a ceiling: a message may narrow a
-- skill to fewer seats for one turn, never widen it past the record
-- (dispatch clamps, src/cloud/envoy-mesh.mjs).
--
-- A skill body is inert text (the commands law, src/agent/commands.mjs):
-- it is stored and later injected into a turn as fenced context. There
-- is no execution surface and no credential-shaped column — nothing on
-- this record can hold a secret.
--
-- Numbering: 075 is the next free number after 074. This file is
-- independently idempotent (create if not exists / drop policy if
-- exists), like its neighbours.
create table if not exists helmion.skills (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null,
  description text,
  body text not null,
  scope text not null check (scope in ('blanket','seats')),
  seat_ids text[] not null default '{}',
  state text not null default 'available' check (state in ('available','disabled-by-owner')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists skills_tenant_idx on helmion.skills(tenant_id);
alter table helmion.skills enable row level security;
drop policy if exists skills_tenant_select on helmion.skills;
create policy skills_tenant_select on helmion.skills for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists skills_tenant_insert on helmion.skills;
create policy skills_tenant_insert on helmion.skills for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists skills_tenant_update on helmion.skills;
create policy skills_tenant_update on helmion.skills for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists skills_tenant_delete on helmion.skills;
create policy skills_tenant_delete on helmion.skills for delete using (tenant_id = current_setting('helmion.tenant_id', true));
