-- Connector library (connector-library SPEC §2, build bite 1): the
-- per-seat library of MCP connectors, plugins, and skills.
--
-- Four tables, all in the helmion schema beside tool_connections:
--   connector_entries     — what a seat's library holds (§2.1). One row
--                           per (tenant, seat, entry). broker_mode is set
--                           at creation and NEVER inferred later: the
--                           column is NOT NULL with no default, so an
--                           insert that omits it fails.
--   connector_connections — who connected an entry, and how (§2.2). One
--                           row per (tenant, person, seat, entry) — v1 is
--                           one account per person per connector per
--                           seat, enforced by the unique constraint.
--                           Token columns hold VAULT REFERENCES ONLY
--                           (vault://tenant/... pointers into
--                           helmion.provider_credentials via
--                           src/cloud/credential-vault.mjs); a raw token
--                           value has no column to land in.
--   connector_mirrors     — vendor-brokered state (§1.5/§2.2): for
--                           broker_mode='vendor' entries there is no
--                           connection record with tokens, only what the
--                           seat's vendor side last reported.
--   connector_snapshots   — the frozen tool list (§2.3). One row per
--                           freeze (connect, accepted change review); the
--                           connection's tool_snapshot_ref points at the
--                           live one. Per-tool rows store the input
--                           schema's HASH, never the schema itself.
--
-- Isolation (§3.4): a seat's entries, connections, postures, snapshots,
-- and toggles are that seat's alone. Tenant RLS (below) is the floor;
-- seat and person scoping is enforced in the store
-- (src/cloud/connector-library.mjs) on every read and write.
--
-- Numbering: 074 is the next free number after 073. This file is
-- independently idempotent (create if not exists / drop policy if
-- exists), like its neighbours.
create table if not exists helmion.connector_entries (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  seat_id text not null check (char_length(seat_id) between 1 and 128),
  id text not null check (char_length(id) between 1 and 128),
  kind text not null check (kind in ('catalog','helmian-native','custom')),
  name text not null check (char_length(name) between 1 and 256),
  one_liner text not null check (char_length(one_liner) between 1 and 512),
  icon_ref text check (icon_ref is null or char_length(icon_ref) between 1 and 1024),
  vendor_name text not null check (char_length(vendor_name) between 1 and 256),
  trust_label text not null check (trust_label in ('verified','community','custom')),
  category text check (category is null or char_length(category) between 1 and 128),
  broker_mode text not null check (broker_mode in ('helmian','vendor')),
  mcp_endpoint_url text check (mcp_endpoint_url is null or char_length(mcp_endpoint_url) between 1 and 1024),
  vendor_connector_ref jsonb check (vendor_connector_ref is null or jsonb_typeof(vendor_connector_ref) = 'object'),
  auth_mode text not null check (auth_mode in ('oauth','none','header')),
  client_identity text check (client_identity is null or char_length(client_identity) between 1 and 1024),
  scopes_summary text check (scopes_summary is null or char_length(scopes_summary) between 1 and 1024),
  added_by text not null check (char_length(added_by) between 1 and 256),
  added_at timestamptz not null default clock_timestamp(),
  workspace_provisioned boolean not null default false,
  state text not null default 'available' check (state in ('available','disabled-by-owner')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, seat_id, id),
  -- broker_mode is a fact recorded at creation (§2.1), and each mode has
  -- exactly one pipe shape: helmian entries carry the endpoint Helmian
  -- calls; vendor entries carry only the vendor-side reference — Helmian
  -- has no endpoint because it has no pipe (§1.5).
  check ((broker_mode = 'helmian' and mcp_endpoint_url is not null and vendor_connector_ref is null)
      or (broker_mode = 'vendor' and mcp_endpoint_url is null and vendor_connector_ref is not null)),
  -- Custom entries are always labelled custom (§2.1).
  check (kind <> 'custom' or trust_label = 'custom')
);
create index if not exists connector_entries_seat_idx on helmion.connector_entries(tenant_id, seat_id);
alter table helmion.connector_entries enable row level security;
drop policy if exists connector_entries_tenant_select on helmion.connector_entries;
create policy connector_entries_tenant_select on helmion.connector_entries for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_entries_tenant_insert on helmion.connector_entries;
create policy connector_entries_tenant_insert on helmion.connector_entries for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_entries_tenant_update on helmion.connector_entries;
create policy connector_entries_tenant_update on helmion.connector_entries for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_entries_tenant_delete on helmion.connector_entries;
create policy connector_entries_tenant_delete on helmion.connector_entries for delete using (tenant_id = current_setting('helmion.tenant_id', true));

create table if not exists helmion.connector_connections (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  person_id text not null check (char_length(person_id) between 1 and 256),
  seat_id text not null check (char_length(seat_id) between 1 and 128),
  entry_id text not null check (char_length(entry_id) between 1 and 128),
  account_identity text not null check (char_length(account_identity) between 1 and 512),
  -- VAULT POINTERS ONLY. The reference format is the credential vault's
  -- own (src/cloud/credential-vault.mjs): vault://tenant/<tenant>/...
  -- naming this tenant. The store validates the shape and the tenant
  -- prefix before a reference is written.
  access_token_ref text check (access_token_ref is null or char_length(access_token_ref) between 1 and 512),
  refresh_token_ref text check (refresh_token_ref is null or char_length(refresh_token_ref) between 1 and 512),
  granted_scopes jsonb not null default '[]'::jsonb check (jsonb_typeof(granted_scopes) = 'array'),
  posture text not null default 'ask' check (posture in ('ask','read','low-risk','all')),
  tool_enable_map jsonb not null default '{}'::jsonb check (jsonb_typeof(tool_enable_map) = 'object'),
  tool_snapshot_ref bigint,
  state text not null default 'connected' check (state in ('connected','needs-reconnect','disconnected')),
  last_discovery_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, person_id, seat_id, entry_id),
  foreign key (tenant_id, seat_id, entry_id)
    references helmion.connector_entries (tenant_id, seat_id, id) on delete cascade
);
create index if not exists connector_connections_seat_idx on helmion.connector_connections(tenant_id, seat_id, person_id);
alter table helmion.connector_connections enable row level security;
drop policy if exists connector_connections_tenant_select on helmion.connector_connections;
create policy connector_connections_tenant_select on helmion.connector_connections for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_connections_tenant_insert on helmion.connector_connections;
create policy connector_connections_tenant_insert on helmion.connector_connections for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_connections_tenant_update on helmion.connector_connections;
create policy connector_connections_tenant_update on helmion.connector_connections for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_connections_tenant_delete on helmion.connector_connections;
create policy connector_connections_tenant_delete on helmion.connector_connections for delete using (tenant_id = current_setting('helmion.tenant_id', true));

create table if not exists helmion.connector_snapshots (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  connection_id bigint not null references helmion.connector_connections(id) on delete cascade,
  taken_at timestamptz not null default clock_timestamp(),
  -- [{name, description, inputSchemaHash, annotation}] — hashes, never
  -- schemas (§2.3). annotation is 'read' | 'write' | 'undeclared';
  -- undeclared is treated as write everywhere it matters.
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array'),
  snapshot_hash text not null check (char_length(snapshot_hash) between 1 and 128)
);
create index if not exists connector_snapshots_connection_idx on helmion.connector_snapshots(tenant_id, connection_id);
alter table helmion.connector_snapshots enable row level security;
drop policy if exists connector_snapshots_tenant_select on helmion.connector_snapshots;
create policy connector_snapshots_tenant_select on helmion.connector_snapshots for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_snapshots_tenant_insert on helmion.connector_snapshots;
create policy connector_snapshots_tenant_insert on helmion.connector_snapshots for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_snapshots_tenant_update on helmion.connector_snapshots;
create policy connector_snapshots_tenant_update on helmion.connector_snapshots for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_snapshots_tenant_delete on helmion.connector_snapshots;
create policy connector_snapshots_tenant_delete on helmion.connector_snapshots for delete using (tenant_id = current_setting('helmion.tenant_id', true));

-- The connection's pointer at its live snapshot (§2.2 toolSnapshotRef).
-- Added after both tables exist so the foreign key can name the snapshot
-- store; on delete set null — a deleted freeze never dangles.
alter table helmion.connector_connections
  drop constraint if exists connector_connections_snapshot_fk;
alter table helmion.connector_connections
  add constraint connector_connections_snapshot_fk
  foreign key (tool_snapshot_ref) references helmion.connector_snapshots(id) on delete set null;

create table if not exists helmion.connector_mirrors (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  person_id text not null check (char_length(person_id) between 1 and 256),
  seat_id text not null check (char_length(seat_id) between 1 and 128),
  entry_id text not null check (char_length(entry_id) between 1 and 128),
  reported_state text not null check (reported_state in ('connected','not-connected')),
  reported_account_identity text check (reported_account_identity is null or char_length(reported_account_identity) between 1 and 512),
  reported_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, person_id, seat_id, entry_id),
  foreign key (tenant_id, seat_id, entry_id)
    references helmion.connector_entries (tenant_id, seat_id, id) on delete cascade
);
create index if not exists connector_mirrors_seat_idx on helmion.connector_mirrors(tenant_id, seat_id, person_id);
alter table helmion.connector_mirrors enable row level security;
drop policy if exists connector_mirrors_tenant_select on helmion.connector_mirrors;
create policy connector_mirrors_tenant_select on helmion.connector_mirrors for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_mirrors_tenant_insert on helmion.connector_mirrors;
create policy connector_mirrors_tenant_insert on helmion.connector_mirrors for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_mirrors_tenant_update on helmion.connector_mirrors;
create policy connector_mirrors_tenant_update on helmion.connector_mirrors for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_mirrors_tenant_delete on helmion.connector_mirrors;
create policy connector_mirrors_tenant_delete on helmion.connector_mirrors for delete using (tenant_id = current_setting('helmion.tenant_id', true));
