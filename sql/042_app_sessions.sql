-- Helmian Cloud /app console sessions (named Claude/ChatGPT/Grok/Gemini sessions).
-- Organization-scoped; only owners and admins can read or write. Presentation
-- metadata only: nothing sensitive or executable is stored here.
create table if not exists helmion.app_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  provider text not null check (provider in ('Claude','ChatGPT','Grok','Gemini')),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (tenant_id, created_by_subject, idempotency_key)
);

create index if not exists app_sessions_tenant_created_idx on helmion.app_sessions (tenant_id, created_at desc);

alter table helmion.app_sessions enable row level security;
drop policy if exists app_sessions_admin_access on helmion.app_sessions;
create policy app_sessions_admin_access on helmion.app_sessions
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin') and created_by_subject = current_setting('helmion.actor_subject', true));
