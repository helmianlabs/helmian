-- Organization invite links (Slack-style join) and desktop app links for Envoy chat.
-- Only SHA-256 hashes of invite tokens, link codes and desktop tokens are stored.
create table if not exists helmion.organization_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null default 'member' check (role = 'member'),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  max_uses integer not null default 25 check (max_uses between 1 and 500),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  check (use_count <= max_uses),
  check (expires_at > created_at)
);
create index if not exists organization_invites_tenant_idx on helmion.organization_invites (tenant_id, created_at desc);

create table if not exists helmion.organization_invite_redemptions (
  invite_id uuid not null references helmion.organization_invites(id) on delete cascade,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 256),
  redeemed_at timestamptz not null default clock_timestamp(),
  primary key (invite_id, subject)
);

create table if not exists helmion.desktop_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 256),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz not null,
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or char_length(label) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  linked_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists desktop_links_subject_idx on helmion.desktop_links (tenant_id, subject, created_at desc);

alter table helmion.organization_invites enable row level security;
alter table helmion.organization_invite_redemptions enable row level security;
alter table helmion.desktop_links enable row level security;

drop policy if exists organization_invites_admin on helmion.organization_invites;
create policy organization_invites_admin on helmion.organization_invites
  for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'));
drop policy if exists organization_invite_redemptions_tenant on helmion.organization_invite_redemptions;
create policy organization_invite_redemptions_tenant on helmion.organization_invite_redemptions
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and subject = current_setting('helmion.actor_subject', true));
drop policy if exists desktop_links_owner_subject on helmion.desktop_links;
create policy desktop_links_owner_subject on helmion.desktop_links
  using (tenant_id = current_setting('helmion.tenant_id', true) and subject = current_setting('helmion.actor_subject', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true) and subject = current_setting('helmion.actor_subject', true));
