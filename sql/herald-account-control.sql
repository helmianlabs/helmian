-- Helmian Remote Control account ownership and Desktop enrollment.
-- This migration stores only identity references, credential hashes, bounded
-- presence metadata, and short-lived control grants. It is not transcript,
-- project-file, provider-key, or tool storage.

create table if not exists herald_accounts (
  provider text not null,
  subject text not null,
  display_name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (provider, subject)
);

create table if not exists herald_desktop_enrollments (
  enrollment_id text primary key,
  proof_hash text not null,
  confirmation_code_hash text not null unique,
  desktop_display_name text not null,
  expires_at timestamptz not null,
  confirmed_account_provider text,
  confirmed_account_subject text,
  confirmed_at timestamptz,
  redeemed_at timestamptz,
  failed_redemption_attempts integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (confirmed_account_provider, confirmed_account_subject)
    references herald_accounts(provider, subject)
);

create table if not exists herald_enrollment_confirmation_limits (
  account_provider text not null,
  account_subject text not null,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key (account_provider, account_subject)
);

create table if not exists herald_registered_desktops (
  desktop_id text primary key,
  account_provider text not null,
  account_subject text not null,
  credential_hash text not null,
  credential_expires_at timestamptz not null,
  display_name text not null,
  enrolled_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  foreign key (account_provider, account_subject)
    references herald_accounts(provider, subject)
);

create table if not exists herald_account_sessions (
  desktop_id text not null references herald_registered_desktops(desktop_id) on delete cascade,
  session_id text not null,
  project_id text not null,
  project_name text not null,
  session_name text not null,
  session_state text not null,
  agent_id text,
  agent_name text,
  agent_state text,
  guard_state text not null,
  guard_detail text,
  realtime_channel text not null unique,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  stopped_at timestamptz,
  primary key (desktop_id, session_id)
);

create table if not exists herald_control_grants (
  grant_id text primary key,
  account_provider text not null,
  account_subject text not null,
  desktop_id text not null,
  session_id text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (account_provider, account_subject)
    references herald_accounts(provider, subject),
  foreign key (desktop_id, session_id)
    references herald_account_sessions(desktop_id, session_id) on delete cascade
);

create table if not exists herald_desktop_nonces (
  desktop_id text not null references herald_registered_desktops(desktop_id) on delete cascade,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (desktop_id, nonce)
);

create table if not exists herald_account_nonces (
  account_provider text not null,
  account_subject text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (account_provider, account_subject, nonce),
  foreign key (account_provider, account_subject)
    references herald_accounts(provider, subject) on delete cascade
);

create index if not exists herald_desktop_enrollment_expiry_idx
  on herald_desktop_enrollments(expires_at);
create index if not exists herald_registered_desktop_owner_idx
  on herald_registered_desktops(account_provider, account_subject, revoked_at);
create index if not exists herald_account_session_presence_idx
  on herald_account_sessions(desktop_id, last_seen_at, stopped_at);
create index if not exists herald_control_grant_owner_idx
  on herald_control_grants(account_provider, account_subject, expires_at, revoked_at);
create index if not exists herald_desktop_nonce_created_idx
  on herald_desktop_nonces(created_at);
create index if not exists herald_account_nonce_created_idx
  on herald_account_nonces(created_at);
