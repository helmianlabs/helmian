-- The connector catalog (brief section (e), bite 1): Helmian's own mirror
-- of the official MCP Registry's metadata, curated. The registry is the
-- metadata source of truth other catalogs build on; this mirror is what
-- the per-seat Connectors view will render from (a later bite), so no seat
-- ever depends on the public registry being up, and the curation decisions
-- (which listings Helmian stands behind) are Helmian's own rows, not a
-- live pass-through.
--
-- The catalog is global reference data — the same shelf for every tenant —
-- so it carries the sql/097 shape for global tables: a nullable tenant_id
-- and the current-context policy as the second layer. The sync writes as
-- the owner; tenant connections see the rows their context names, and the
-- application reads the catalog through its own owner connection.
--
-- Curation (applied by the sync, counted on every run): latest version
-- only and registry status active; a remote endpoint must exist;
-- source-linked (a repository URL or a website URL on the record);
-- the publisher must not be a bulk publisher; and the remote endpoint
-- must answer a live probe. `curated` marks the rows that pass all five.

create table if not exists helmion.connector_catalog_servers (
  id bigserial primary key,
  tenant_id text references helmion.tenants(tenant_id),
  registry_name text not null unique,
  publisher text not null,
  title text,
  description text,
  version text,
  repository_url text,
  website_url text,
  source_kind text not null default 'none' check (source_kind in ('repository', 'website', 'none')),
  icon_url text,
  remotes jsonb not null default '[]'::jsonb,
  record jsonb not null,
  registry_status text,
  registry_updated_at timestamptz,
  endpoint_live boolean,
  endpoint_checked_at timestamptz,
  endpoint_detail text,
  curated boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now()
);

create index if not exists connector_catalog_servers_curated_idx
  on helmion.connector_catalog_servers(curated, publisher);
create index if not exists connector_catalog_servers_publisher_idx
  on helmion.connector_catalog_servers(publisher);

alter table helmion.connector_catalog_servers enable row level security;

drop policy if exists connector_catalog_servers_tenant_isolation on helmion.connector_catalog_servers;
create policy connector_catalog_servers_tenant_isolation on helmion.connector_catalog_servers
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

-- One row per sync run: the funnel counts are the bite's proof surface —
-- what the registry held, and what each curation stage kept.
create table if not exists helmion.connector_catalog_sync_runs (
  id bigserial primary key,
  tenant_id text references helmion.tenants(tenant_id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'complete', 'failed')),
  fetched integer not null default 0,
  active_count integer,
  with_remote_count integer,
  source_linked_count integer,
  non_bulk_count integer,
  endpoint_live_count integer,
  curated_count integer,
  bulk_publisher_max integer,
  detail text
);

alter table helmion.connector_catalog_sync_runs enable row level security;

drop policy if exists connector_catalog_sync_runs_tenant_isolation on helmion.connector_catalog_sync_runs;
create policy connector_catalog_sync_runs_tenant_isolation on helmion.connector_catalog_sync_runs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
