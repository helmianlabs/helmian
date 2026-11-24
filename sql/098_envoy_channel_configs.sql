-- 098: dedicated channel-config table (Helmian hardening step 1,
-- 2026-11-23).
--
-- A channel's config used to live only as an append-only
-- author_kind='system' row in helmion.envoy_messages, whose body
-- CHECK (sql/009: 1..4000 chars) capped a serialized config at
-- 4,000 chars — about 26 rich custom agents, so the advertised
-- MAX_CHANNEL_AGENTS=50 was unreachable in one channel. This table
-- holds one row per (tenant, channel) with a 65,536-char body
-- (envoy-agents.mjs MAX_CONFIG_BODY_CHARS), keyed and fenced
-- exactly like envoy_channels / envoy_messages in sql/009.
--
-- The store (src/cloud/envoy-config-store.mjs) dual-reads: the
-- effective config is the newest of this table's row and the
-- newest config message, and dual-writes keep appending the
-- message copy whenever the body fits the old CHECK. The backfill
-- below seeds the table from each channel's newest config
-- message; channels whose configs were written only here are
-- simply absent from envoy_messages, which the dual-read merge
-- already handles. Rollback is HELMION_CONFIG_STORE=message —
-- reads and writes return to envoy_messages only, no data moves.
--
-- Numbering: this base's sql/ ends at 089 and production already
-- owns 090–097, so 098 is the next free number; RE-CHECK at merge
-- time against production main before applying anywhere.
-- Independently idempotent (create if not exists, backfill on
-- conflict do nothing), like its neighbours. NOT applied by the
-- build; it is applied on the box road, where the migration
-- runner records it in helmion.schema_migrations with the sha256
-- of this file's CRLF-canonicalised text (src/adapters/neon.mjs
-- loadMigrations). Until it lands, the store's table reads answer
-- "no rows" and its table writes are skipped: the message road
-- carries every config exactly as it did before.
create table if not exists helmion.envoy_channel_configs (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  channel_id uuid not null,
  body text not null check (char_length(body) between 1 and 65536),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel_id),
  constraint envoy_channel_configs_channel_tenant_fk foreign key (tenant_id, channel_id)
    references helmion.envoy_channels (tenant_id, id) on delete cascade
);

alter table helmion.envoy_channel_configs enable row level security;

drop policy if exists envoy_channel_configs_tenant_isolation on helmion.envoy_channel_configs;
create policy envoy_channel_configs_tenant_isolation on helmion.envoy_channel_configs
  using (tenant_id = current_setting('helmion.tenant_id', true));

insert into helmion.envoy_channel_configs (tenant_id, channel_id, body, updated_at)
select distinct on (tenant_id, channel_id) tenant_id, channel_id, body, created_at
from helmion.envoy_messages
where author_subject = 'system:envoy-config'
order by tenant_id, channel_id, created_at desc, id desc
on conflict (tenant_id, channel_id) do nothing;
