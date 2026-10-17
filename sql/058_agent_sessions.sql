-- 058: Agent sessions. Every agent (including the Maestro, which is just a
-- named agent with provider='maestro') is a row. Users spin up unlimited
-- named sessions bound to a provider with a routing tier. The Agents panel
-- reads this table for the roster, live status colors, and per-session
-- Guard filtering.
create table if not exists helmion.workspace_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  name text not null,
  provider text not null check (provider in ('maestro', 'claude', 'openai', 'grok', 'gemini')),
  routing_tier text not null default 'auto' check (routing_tier in ('auto', 'fast', 'standard', 'deep')),
  status text not null default 'idle' check (status in ('idle', 'active', 'warning', 'error')),
  last_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, name)
);

alter table helmion.workspace_agent_sessions enable row level security;

drop policy if exists workspace_agent_sessions_tenant_access on helmion.workspace_agent_sessions;
create policy workspace_agent_sessions_tenant_access on helmion.workspace_agent_sessions
  for all using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
