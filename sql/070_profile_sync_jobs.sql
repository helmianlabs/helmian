-- Profile sync jobs (S1, 2026-11-05): the helmian.cloud "Sync Profile &
-- Guard to All AIs" button used to stamp presence rows and return a
-- hardcoded list of files it never wrote. A sync is now a real job:
-- the button enqueues one row here, the tenant's PC bridge claims it
-- (device-token poll, the same pull shape as agent-work), runs the
-- Agent OS installer, and posts back the installer's per-file report —
-- paths, created-or-updated, and a sha256 read back from the disk it
-- wrote. The page renders only that report. Nothing in this table is
-- secret: a job id, a status, and file paths with hashes.
create table if not exists helmion.profile_sync_jobs (
  id bigint generated always as identity primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  kind text not null default 'profile-sync',
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'failed')),
  requested_by text,
  result jsonb,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  completed_at timestamptz
);

create index if not exists profile_sync_jobs_tenant_status_idx
  on helmion.profile_sync_jobs (tenant_id, status, created_at);

alter table helmion.profile_sync_jobs enable row level security;
drop policy if exists profile_sync_jobs_tenant_access on helmion.profile_sync_jobs;
create policy profile_sync_jobs_tenant_access on helmion.profile_sync_jobs
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
