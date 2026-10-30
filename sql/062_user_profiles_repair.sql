-- 062: Repair for 059_user_profiles.sql, which was never applied: it attached a
-- trigger calling helmion.set_updated_at(), a function no migration defines, so
-- the whole file failed and helmion.user_profiles does not exist. That is why
-- GET/POST /api/admin/profile (Settings > Envoy profile) answers 500.
-- user-profile.mjs already sets updated_at = now() on every write, so no
-- trigger is needed. Idempotent; safe to run whether or not 059 half-applied.
create table if not exists helmion.user_profiles (
  subject text primary key
    check (nullif(trim(subject), '') is not null),
  nickname text
    check (nickname is null or nullif(trim(nickname), '') is not null),
  avatar_emoji text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table helmion.user_profiles enable row level security;

-- A profile row is keyed by the signed-in subject; the handler always filters
-- by the verified session subject, so the policy stays permissive like 059.
drop policy if exists user_profiles_current_context on helmion.user_profiles;
create policy user_profiles_current_context on helmion.user_profiles
  for all
  using (true)
  with check (true);
