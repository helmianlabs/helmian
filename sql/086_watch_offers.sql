-- Watch offers (live agent-browser view, Bite 3, 2026-11-12): the
-- Browser tab's "your agent is working in a browser" signal. When a
-- session-executor seat has a browser page open on the box, the
-- executor posts that fact — provider name and the page's current
-- address, nothing else — over its device-token road on the runner
-- presence route (runner-presence.mjs reportWatch), and the desk
-- reads the unexpired offers back on that route's GET, the poll it
-- already rides. One row per provider, upserted; every row carries
-- its own short expiry, so an executor that dies mid-turn leaves an
-- offer that expires on its own within the TTL — the pane never
-- offers a watch on a browser that is not there. The executor also
-- clears its row the moment its last page closes; the expiry is the
-- backstop, not the mechanism.
--
-- Tenant data, unlike the app-global watch ticket secret (085):
-- one tenant's offers are never another's, enforced by the tenant
-- policy below and by the store's tenant transaction, the same
-- shape as runner_activity (067). No provider check constraint on
-- purpose (067's reasoning): the vocabulary is validated in the
-- store. This table carries nothing secret: a provider name and
-- the address of the provider page the agent is working on.
--
-- Numbering: 086 is the next free number after 085 on main at build
-- time (2026-11-12). Independently idempotent (create if not
-- exists), like its neighbours. NOT applied by the build; it is
-- applied on the box road. The store is fail-soft until it lands:
-- reads answer [] and writes report unavailable.
create table if not exists helmion.watch_offers (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_name text not null,
  url text,
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  primary key (tenant_id, provider_name)
);

create index if not exists watch_offers_tenant_expiry_idx
  on helmion.watch_offers (tenant_id, expires_at);

alter table helmion.watch_offers enable row level security;
drop policy if exists watch_offers_tenant_access on helmion.watch_offers;
create policy watch_offers_tenant_access on helmion.watch_offers
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
