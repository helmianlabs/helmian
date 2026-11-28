-- Short-lived OAuth authorization-code handoff for the hosted Slack and Discord callbacks.
-- The provider client secret and access/refresh tokens never enter this database.
create table if not exists team_oauth_handoffs (
  request_id text primary key check (request_id ~ '^team_[A-Za-z0-9_-]{20,80}$'),
  provider text not null check (provider in ('slack', 'discord')),
  state_hash text not null check (state_hash ~ '^[A-Za-z0-9_-]{43}$'),
  redemption_challenge text not null check (redemption_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_ciphertext text,
  code_iv text,
  code_tag text,
  provider_error text,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  redeemed_at timestamptz,
  check ((code_ciphertext is null and code_iv is null and code_tag is null)
      or (code_ciphertext is not null and code_iv is not null and code_tag is not null)),
  check (provider_error is null or provider_error = 'declined')
);

create index if not exists team_oauth_handoffs_expiry_idx
  on team_oauth_handoffs (expires_at);

revoke all on team_oauth_handoffs from public;
