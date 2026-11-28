-- Runner live activity (demo-night bite A, 2026-11-04): the room shows
-- what a seat is DOING — started / working / file-placed / published /
-- done / failed — from real events the worker emits at a job's actual
-- milestones, never from a timer or a message's age. One row per event,
-- each stamped with its own expiry (the store's short TTL): a worker
-- that dies mid-job leaves a last event that expires on its own, and
-- the seat stops claiming work without anyone cleaning up after it.
-- Written only by the worker's device-token posts on the runner
-- presence route (runner-presence.mjs reportActivity); read back on
-- that route's GET. No provider check constraint on purpose: the 057
-- constraint is why presence upserts carry a widen-and-retry repair —
-- the provider vocabulary is validated in the store instead. This
-- table carries nothing secret: a provider name, a channel id, a
-- stage, and a small bag of measured counts.
create table if not exists helmion.runner_activity (
  id bigint generated always as identity primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_name text not null,
  channel_id text not null,
  stage text not null check (stage in ('started', 'working', 'file-placed', 'published', 'done', 'failed')),
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists runner_activity_tenant_expiry_idx
  on helmion.runner_activity (tenant_id, expires_at);
create index if not exists runner_activity_tenant_channel_idx
  on helmion.runner_activity (tenant_id, provider_name, channel_id, at desc);

alter table helmion.runner_activity enable row level security;
drop policy if exists runner_activity_tenant_access on helmion.runner_activity;
create policy runner_activity_tenant_access on helmion.runner_activity
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
