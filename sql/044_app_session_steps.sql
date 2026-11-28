-- Live task progress checklist for /app sessions. One row per step; the plan is
-- replaced as a whole, step status moves pending -> running -> done/failed/skipped.
-- Organization-scoped, owner/admin only (same as helmion.app_sessions).
create table if not exists helmion.app_session_steps (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  session_id uuid not null references helmion.app_sessions(id) on delete cascade,
  position smallint not null check (position between 0 and 19),
  label text not null check (char_length(label) between 1 and 120),
  status text not null default 'pending' check (status in ('pending','running','done','failed','skipped')),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (session_id, position)
);

create index if not exists app_session_steps_tenant_idx on helmion.app_session_steps (tenant_id, updated_at desc);

alter table helmion.app_session_steps enable row level security;
drop policy if exists app_session_steps_admin_access on helmion.app_session_steps;
create policy app_session_steps_admin_access on helmion.app_session_steps
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin') and updated_by_subject = current_setting('helmion.actor_subject', true));
