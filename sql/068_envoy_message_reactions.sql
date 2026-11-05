-- 068: Message reactions (emoji bites, 2026-11-04) — bite 2, server + data.
-- A reaction is an attributed room event: one row per (message, emoji,
-- actor). Members and agents react through the same table; the actor is
-- the member's subject or the agent's 'agent:<provider>' subject, with
-- actor_kind saying which, mirroring envoy_messages' own author shape.
-- Toggle semantics live in the store (envoy-reactions.mjs): the primary
-- key makes a second add of the same reaction a no-op, and a remove is a
-- plain delete, so counts are always just the row count — they survive
-- reload because there is nothing cached to lose.
--
-- The emoji column stores the asset SLUG from the shipped set
-- (web/marketing/app/emoji-map.mjs), never the raw character: Unicode is
-- the message data, the slug is the one vocabulary the desk, the worker
-- and the bridges all render by. No SQL check on the slug for the same
-- reason sql/067 carries none on provider: the pack grows by shipping
-- assets, not by migration, so the store validates against the map.
--
-- The pack column is the entitlement seam the economy layer bolts onto
-- (plan addendum, 2026-11-04): every row records which pack its emoji
-- came from, 'default' for the shipped set. Only the default pack exists
-- in this bite and no entitlement is enforced yet; when packs ship, the
-- check lands in the store at the same seam that validates the slug.
--
-- The composite foreign key matches envoy_messages' own composite keying
-- (sql/009): the unique index below gives the FK its target — id is the
-- messages primary key, so the index can never fail to build — and a
-- deleted message takes its reactions with it.
create unique index if not exists envoy_messages_tenant_channel_id_uk
  on helmion.envoy_messages (tenant_id, channel_id, id);

create table if not exists helmion.envoy_message_reactions (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  channel_id uuid not null,
  message_id uuid not null,
  emoji text not null check (char_length(emoji) between 1 and 64),
  pack text not null default 'default' check (char_length(pack) between 1 and 64),
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  actor_kind text not null check (actor_kind in ('human', 'agent')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, message_id, emoji, actor_subject),
  constraint envoy_message_reactions_message_fk
    foreign key (tenant_id, channel_id, message_id)
    references helmion.envoy_messages (tenant_id, channel_id, id) on delete cascade
);

create index if not exists envoy_message_reactions_channel_message_idx
  on helmion.envoy_message_reactions (tenant_id, channel_id, message_id, emoji);

alter table helmion.envoy_message_reactions enable row level security;
drop policy if exists envoy_message_reactions_tenant_isolation on helmion.envoy_message_reactions;
create policy envoy_message_reactions_tenant_isolation on helmion.envoy_message_reactions
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
