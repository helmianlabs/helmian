-- Organization + signed-in user Cora preferences. No provider keys, model selection,
-- Clerk metadata, Plant/facility authority, or external provider state is stored.
create table if not exists helmion.cora_personal_preferences (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  user_subject text not null check (char_length(user_subject) between 1 and 256),
  muted boolean,
  volume integer check (volume is null or volume between 0 and 100),
  verbosity text check (verbosity is null or verbosity in ('concise','standard','detailed')),
  interrupt_mode text check (interrupt_mode is null or interrupt_mode in ('barge_in','after_sentence')),
  turn_mode text check (turn_mode is null or turn_mode in ('concise','standard')),
  voice_profile text check (voice_profile is null or char_length(voice_profile) between 1 and 128),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, user_subject)
);
alter table helmion.cora_personal_preferences enable row level security;
drop policy if exists cora_personal_preferences_tenant_select on helmion.cora_personal_preferences;
create policy cora_personal_preferences_tenant_select on helmion.cora_personal_preferences for select using (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true));
drop policy if exists cora_personal_preferences_tenant_write on helmion.cora_personal_preferences;
create policy cora_personal_preferences_tenant_write on helmion.cora_personal_preferences for all using (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true)) with check (tenant_id = current_setting('helmion.tenant_id', true) and user_subject = current_setting('helmion.actor_subject', true) and updated_by_subject = current_setting('helmion.actor_subject', true));
