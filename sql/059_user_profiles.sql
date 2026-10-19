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

-- Updated_at trigger
drop trigger if exists user_profiles_updated_at on helmion.user_profiles;
create trigger user_profiles_updated_at
  before update on helmion.user_profiles
  for each row
  execute function helmion.set_updated_at();
