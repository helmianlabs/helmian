-- MCP-local connector entries (ledger join, direction 1 — the
-- finishing migration the join's BUILD-REPORT named): a finished
-- MCP install pipeline on a person's machine reports the server it
-- installed, and the connector library now holds that server as an
-- entry of kind 'mcp-local'. sql/074 could not hold it, for the
-- three reasons the join named:
--   (a) the kind CHECK named only catalog / helmian-native / custom;
--   (b) the broker-shape CHECK required a helmian-brokered entry to
--       carry a non-null mcp_endpoint_url — and the store demands a
--       public HTTPS URL there — while a stdio server on a person's
--       machine has no endpoint at all;
--   (c) no column held an installed path or a config snippet.
--
-- THE SHAPE this migration gives an mcp-local entry INSTEAD of the
-- endpoint requirement (the local facts, as real columns — the
-- table's own style; jsonb is used where the fact is itself a
-- document, as vendor_connector_ref already is):
--   installed_path        — the absolute path of the materialized
--                           install on the machine that ran the
--                           pipeline (required for mcp-local).
--   config_snippet        — the { mcpServers: { … } } snippet the
--                           pipeline printed for this server: how
--                           the server is started on that machine
--                           (required for mcp-local).
--   baseline_fingerprint  — the install ledger's baseline hash
--                           (code + permission surface, sha256 hex)
--                           from the install report: the seed the
--                           first-arm drift story compares against,
--                           the same fingerprint the local ledger
--                           keeps — one hash, both tellings.
-- The three local columns are mcp-local's alone: every other kind
-- must leave all three NULL, enforced by the replaced broker-shape
-- constraint below.
--
-- SAFETY FOR EXISTING ROWS — the argument, row by row: this file
-- contains NO update, insert, or delete against connector_entries;
-- it adds three columns (NULL for every existing row — no default
-- is declared, so no row's data changes) and replaces two CHECK
-- constraints. Under the replaced broker-shape constraint, an
-- existing row (kind <> 'mcp-local', the three new columns NULL by
-- construction) is judged by the second disjunct, which is sql/074's
-- original predicate verbatim plus the three NULL conditions that
-- are true by construction — so a row that satisfied 074 satisfies
-- 080, and the ADD CONSTRAINT validation passes on exactly the rows
-- 074 allowed. A row that somehow violated the new shape would make
-- ADD CONSTRAINT fail loudly and stop the migration — the file
-- never rewrites data to make a row fit. The kind constraint's
-- replacement only widens the allowed set.
--
-- The two constraints being replaced were created unnamed in
-- sql/074, so their generated names are not assumed: each DO block
-- finds the live constraint by its definition's own words (the
-- kind list's members; the broker shape's two pipe columns) and
-- refuses to guess — if neither the old shape nor this migration's
-- named replacement is found, the block raises and the migration
-- stops rather than proceeding on an unrecognized schema.
--
-- RLS: no table is created and no policy changes — the alters land
-- on helmion.connector_entries, whose tenant policies from sql/074
-- already govern the new columns and the mcp-local rows alike.
--
-- Numbering: 080 is the next free number after 079. Idempotent:
-- columns are added if not exists; each constraint replacement is
-- a no-op once this migration's named constraint is in place.

alter table helmion.connector_entries
  add column if not exists installed_path text
    check (installed_path is null or char_length(installed_path) between 1 and 1024);
alter table helmion.connector_entries
  add column if not exists config_snippet jsonb
    check (config_snippet is null or jsonb_typeof(config_snippet) = 'object');
alter table helmion.connector_entries
  add column if not exists baseline_fingerprint text
    check (baseline_fingerprint is null or baseline_fingerprint ~ '^[a-f0-9]{64}$');

-- The kind CHECK: widen the allowed set with 'mcp-local'.
do $$
declare
  old_kind_check text;
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'helmion.connector_entries'::regclass
                and conname = 'connector_entries_kind_allowed') then
    return; -- this migration's replacement is already in place
  end if;
  select conname into old_kind_check
    from pg_constraint
   where conrelid = 'helmion.connector_entries'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%''catalog''%'
     and pg_get_constraintdef(oid) like '%''helmian-native''%'
     and pg_get_constraintdef(oid) not like '%''mcp-local''%';
  if old_kind_check is null then
    raise exception 'sql/080: the sql/074 kind check on helmion.connector_entries was not found and no replacement is in place — refusing to guess at the schema';
  end if;
  execute format('alter table helmion.connector_entries drop constraint %I', old_kind_check);
  alter table helmion.connector_entries
    add constraint connector_entries_kind_allowed
    check (kind in ('catalog','helmian-native','custom','mcp-local'));
end $$;

-- The broker-shape CHECK: an mcp-local entry's lawful shape stands
-- in place of the endpoint requirement; every other kind keeps
-- sql/074's predicate verbatim and must leave the local columns
-- NULL.
do $$
declare
  old_shape_check text;
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'helmion.connector_entries'::regclass
                and conname = 'connector_entries_broker_shape') then
    return; -- this migration's replacement is already in place
  end if;
  select conname into old_shape_check
    from pg_constraint
   where conrelid = 'helmion.connector_entries'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%mcp_endpoint_url%'
     and pg_get_constraintdef(oid) like '%vendor_connector_ref%'
     and pg_get_constraintdef(oid) not like '%installed_path%';
  if old_shape_check is null then
    raise exception 'sql/080: the sql/074 broker-shape check on helmion.connector_entries was not found and no replacement is in place — refusing to guess at the schema';
  end if;
  execute format('alter table helmion.connector_entries drop constraint %I', old_shape_check);
  alter table helmion.connector_entries
    add constraint connector_entries_broker_shape
    check (
      (kind = 'mcp-local'
        and broker_mode = 'helmian'
        and mcp_endpoint_url is null
        and vendor_connector_ref is null
        and installed_path is not null
        and config_snippet is not null)
      or
      (kind <> 'mcp-local'
        and installed_path is null
        and config_snippet is null
        and baseline_fingerprint is null
        and ((broker_mode = 'helmian' and mcp_endpoint_url is not null and vendor_connector_ref is null)
          or (broker_mode = 'vendor' and mcp_endpoint_url is null and vendor_connector_ref is not null)))
    );
end $$;
