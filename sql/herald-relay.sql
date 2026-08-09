-- First-party Helmian Herald relay. This schema carries only short-lived,
-- typed phone/desktop messages; it is not project storage or a file relay.
create table if not exists herald_sessions (
  channel text primary key,
  desktop_token_hash text not null,
  pairing_code_hash text not null,
  pairing_expires_at timestamptz not null,
  pairing_failed_attempts integer not null default 0,
  expires_at timestamptz not null,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  last_desktop_seen_at timestamptz not null default now()
);

alter table herald_sessions
  add column if not exists pairing_failed_attempts integer not null default 0;

create table if not exists herald_devices (
  channel text not null references herald_sessions(channel) on delete cascade,
  device_id text not null,
  token_hash text not null,
  display_name text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (channel, device_id)
);

create table if not exists herald_nonces (
  channel text not null,
  device_id text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (channel, device_id, nonce),
  foreign key (channel, device_id) references herald_devices(channel, device_id) on delete cascade
);

create table if not exists herald_messages (
  id bigserial primary key,
  channel text not null references herald_sessions(channel) on delete cascade,
  sender text not null check (sender in ('phone', 'desktop')),
  request_id text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  unique (channel, sender, request_id)
);

create index if not exists herald_messages_channel_id_idx on herald_messages(channel, id);
create index if not exists herald_sessions_expiry_idx on herald_sessions(expires_at);
create index if not exists herald_devices_expiry_idx on herald_devices(expires_at);
create index if not exists herald_nonces_created_idx on herald_nonces(created_at);
