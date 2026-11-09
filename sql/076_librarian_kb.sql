-- Librarian knowledge base (Troy's order, 2026-11-09): the
-- mistakes-and-solutions store behind envoy-librarian.mjs. Troy:
-- the librarian "has gotta have self-learning flywheel with logic
-- and a knowledge base of every mistake that has been done by AIs
-- and the solutions, categorized, with schemas, tables, rows —
-- immediate recall for any AI."
--
-- The design is ADAPTED FROM THE SCRIBE LIBRARIAN, which exists and
-- runs in the memory service on the Hetzner box
-- (/opt/claude-memory-mcp/app/src/librarian/ — engine, learn,
-- presets, shape, match; tools save_memory / search_memory /
-- add_rule / explain_filing / list_unsorted / move_memory). That
-- librarian files MEMORY items into categories with layered,
-- explainable rules and LEARNS a new rule when a human re-files an
-- item. This migration lays the same loop over Helmian's own store:
--
--   librarian_incidents — one row per mistake: what happened, who
--     or what hit it, the category the filing rules chose, the
--     solution that worked, and the evidence (chat / message /
--     finding ids) as data, never free-floating prose alone. The
--     flywheel loop is in the status columns, mirroring
--     ~/workspace/flywheel (RULES.md + OUTCOMES.md): an outcome is
--     logged (status 'open'), a verdict lands (status 'solved',
--     solution filled), and a superseded solution POINTS at its
--     replacement (superseded_by_id) instead of being edited away —
--     the base learns; it does not forget why.
--   librarian_rules — the custom and learned filing rules, stored
--     in the Scribe engine's own Rule shape (id, layer, when,
--     category, addTags, priority, description) as jsonb. Preset
--     rules live in code (envoy-librarian.mjs, the presets.ts
--     road); this table holds only what a workspace gained: custom
--     rules and the rules learned from human re-files. A rule an
--     outcome disproves is STRUCK (status 'struck', struck_at,
--     strike_note) and kept — struck rules stay in the record,
--     exactly like the flywheel's struck rules.
--
-- Tenant isolation is the 075 pattern: tenant_id on every row and
-- the four RLS policies keyed on the tenant transaction's setting.
-- Applied by hand like its neighbours; the librarian's reads and
-- writes are fail-soft until it lands (a missing table reads as an
-- empty knowledge base, never a failed dispatch).

create table if not exists helmion.librarian_incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  key text,
  category text not null default 'unsorted',
  title text not null,
  mistake text not null,
  solution text,
  actor text,
  source text,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'solved', 'superseded')),
  supersedes_id uuid references helmion.librarian_incidents(id),
  superseded_by_id uuid references helmion.librarian_incidents(id),
  filed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists librarian_incidents_tenant_key_idx
  on helmion.librarian_incidents(tenant_id, key) where key is not null;
create index if not exists librarian_incidents_recall_idx
  on helmion.librarian_incidents(tenant_id, status, created_at desc);
create index if not exists librarian_incidents_category_idx
  on helmion.librarian_incidents(tenant_id, category, created_at desc);
alter table helmion.librarian_incidents enable row level security;
drop policy if exists librarian_incidents_tenant_select on helmion.librarian_incidents;
create policy librarian_incidents_tenant_select on helmion.librarian_incidents for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_incidents_tenant_insert on helmion.librarian_incidents;
create policy librarian_incidents_tenant_insert on helmion.librarian_incidents for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_incidents_tenant_update on helmion.librarian_incidents;
create policy librarian_incidents_tenant_update on helmion.librarian_incidents for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_incidents_tenant_delete on helmion.librarian_incidents;
create policy librarian_incidents_tenant_delete on helmion.librarian_incidents for delete using (tenant_id = current_setting('helmion.tenant_id', true));

create table if not exists helmion.librarian_rules (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  layer text not null check (layer in ('custom', 'learned')),
  rule jsonb not null,
  status text not null default 'active' check (status in ('active', 'struck')),
  created_at timestamptz not null default now(),
  struck_at timestamptz,
  strike_note text,
  primary key (tenant_id, id)
);
create index if not exists librarian_rules_tenant_idx on helmion.librarian_rules(tenant_id, status);
alter table helmion.librarian_rules enable row level security;
drop policy if exists librarian_rules_tenant_select on helmion.librarian_rules;
create policy librarian_rules_tenant_select on helmion.librarian_rules for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_rules_tenant_insert on helmion.librarian_rules;
create policy librarian_rules_tenant_insert on helmion.librarian_rules for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_rules_tenant_update on helmion.librarian_rules;
create policy librarian_rules_tenant_update on helmion.librarian_rules for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists librarian_rules_tenant_delete on helmion.librarian_rules;
create policy librarian_rules_tenant_delete on helmion.librarian_rules for delete using (tenant_id = current_setting('helmion.tenant_id', true));
