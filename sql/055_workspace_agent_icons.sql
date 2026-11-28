-- Custom agent icons: per-user emoji overrides for the fixed provider list
-- (Maestro, Claude, ChatGPT, Grok, Gemini). Personal customization only —
-- presentation, never authority. Plain emoji_mode does not strip these:
-- they are the user's own choice.
create table if not exists helmion.workspace_agent_icons (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  user_subject text not null check (char_length(user_subject) between 1 and 256),
  provider_name text not null check (provider_name in ('Maestro', 'Claude', 'ChatGPT', 'Grok', 'Gemini')),
  icon_emoji text not null check (char_length(icon_emoji) between 1 and 16),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, user_subject, provider_name)
);

alter table helmion.workspace_agent_icons enable row level security;
drop policy if exists workspace_agent_icons_user_access on helmion.workspace_agent_icons;
create policy workspace_agent_icons_user_access on helmion.workspace_agent_icons
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true) and updated_by_subject = current_setting('helmion.actor_subject', true));
