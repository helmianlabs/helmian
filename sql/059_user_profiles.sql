-- 059: User profiles for Envoy (nickname, avatar)
-- Each user (by Clerk subject) gets a profile with display nickname and avatar.
-- Used by Envoy team chat to show who is who.

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

drop policy if exists user_profiles_current_context on helmion.user_profiles;
create policy user_profiles_current_context on helmion.user_profiles
  for all
  using (true)
  with check (true);

-- No updated_at trigger. The original version of this file ended with a
-- trigger calling helmion.set_updated_at() — a function no migration
-- defines — so Postgres refused the CREATE TRIGGER, the whole file
-- failed, and helmion.user_profiles was never created: GET/POST
-- /api/admin/profile (Settings > Envoy profile) could not persist
-- anything. 062_user_profiles_repair.sql records the same finding and
-- repairs databases that never got the table; this file is fixed in
-- place because it was never successfully applied anywhere.
-- user-profile.mjs sets updated_at = now() on every write, so no
-- trigger is needed.
