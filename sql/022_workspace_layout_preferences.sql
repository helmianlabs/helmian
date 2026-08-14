-- Organization role defaults and signed-in-user workspace layout overrides.
-- This stores presentation preferences only: no roles, modules, policy, provider,
-- Plant/facility, or credential authority is represented here.
create table if not exists helmion.workspace_layout_role_defaults (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  role text not null check (role in ('owner','admin','member','auditor')),
  visible_shelves jsonb not null,
  panel_order jsonb not null,
  density text not null check (density in ('comfortable','compact')),
  default_envoy_channel_id uuid,
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, role),
  constraint workspace_role_default_channel_tenant_fk foreign key (tenant_id, default_envoy_channel_id)
    references helmion.envoy_channels (tenant_id, id) on delete set null
);

create table if not exists helmion.workspace_layout_preferences (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  user_subject text not null check (char_length(user_subject) between 1 and 256),
  visible_shelves jsonb,
  panel_order jsonb,
  density text check (density is null or density in ('comfortable','compact')),
  default_envoy_channel_id uuid,
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, user_subject),
  constraint workspace_layout_preference_channel_tenant_fk foreign key (tenant_id, default_envoy_channel_id)
    references helmion.envoy_channels (tenant_id, id) on delete set null
);

alter table helmion.workspace_layout_role_defaults enable row level security;
alter table helmion.workspace_layout_preferences enable row level security;
drop policy if exists workspace_layout_role_defaults_tenant_select on helmion.workspace_layout_role_defaults;
create policy workspace_layout_role_defaults_tenant_select on helmion.workspace_layout_role_defaults
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists workspace_layout_role_defaults_admin_write on helmion.workspace_layout_role_defaults;
create policy workspace_layout_role_defaults_admin_write on helmion.workspace_layout_role_defaults
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin') and updated_by_subject = current_setting('helmion.actor_subject', true));
drop policy if exists workspace_layout_preferences_user_access on helmion.workspace_layout_preferences;
create policy workspace_layout_preferences_user_access on helmion.workspace_layout_preferences
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true) and updated_by_subject = current_setting('helmion.actor_subject', true));
