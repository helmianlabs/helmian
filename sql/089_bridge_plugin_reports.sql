-- Bridge plugin reports (M3 Gate G7, 2026-11-13): the plugins pipe's
-- kept half. The PC bridge already reports its loaded plugins on
-- every `commands` event (src/agent/bridge.mjs) — name, version,
-- whether it brings commands, its approved and refused MCP servers
-- by name — but until now that report never left the PC, and
-- GET /api/admin/plugins answered from the workspace of the process
-- serving the request: the wrong machine's shelf. The bridge's
-- future sender hop posts the report over its device-token road to
-- the ingest route in src/cloud/bridge-plugin-report.mjs, which
-- stores the latest report per tenant here, stamped with when it
-- arrived.
--
-- One row per tenant, replaced on each report: a report is the
-- bridge's current claim, not a history. The plugins column holds
-- the shaped entries ONLY — the bridge's `root` path for each
-- plugin is dropped at ingest and never stored (the law
-- installed-plugins.mjs already enforces for a cloud surface: no
-- roots, no file paths ride cloud-side). Warning strings are
-- likewise reduced to a count at the door: a loader warning can
-- carry a PC file path, and the count keeps the fact without the
-- leak. Refusal reasons do ride — they are the install ledger's
-- own words about a server, already the vocabulary the surfaces
-- use, and they are never rendered from this table directly: the
-- read shapes rows through installedPluginRow, which carries only
-- name, version, brings, tools, commands.
--
-- Tenant data, enforced by the policy below and by the store's
-- tenant transaction, the same shape as watch_offers (086) and
-- runner_activity (067). The tenant always comes from the device
-- credential, never from the posted body.
--
-- Numbering: 089 is the next free number after 088 on main at build
-- time (2026-11-13). Independently idempotent (create if not
-- exists), like its neighbours. NOT applied by the build; it is
-- applied on the box road, where the migration runner records it in
-- helmion.schema_migrations with the sha256 of this file's
-- CRLF-canonicalised text (src/adapters/neon.mjs loadMigrations).
-- The store is fail-soft until it lands: reads answer "no report"
-- (and the plugins read falls back to the local list it serves
-- today) and writes report unavailable.
create table if not exists helmion.bridge_plugin_reports (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  reported_at timestamptz not null default clock_timestamp(),
  plugins jsonb not null default '[]'::jsonb,
  primary key (tenant_id)
);

alter table helmion.bridge_plugin_reports enable row level security;
drop policy if exists bridge_plugin_reports_tenant_access on helmion.bridge_plugin_reports;
create policy bridge_plugin_reports_tenant_access on helmion.bridge_plugin_reports
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
