-- Credential vault v2 (cloud-connect design §5, build bite 1).
-- Generalizes custody beyond the OAuth-only table in 034:
--   * helmion.tenant_vault_keys      — one wrapped data key per tenant (envelope).
--   * helmion.provider_credentials   — credential records of every kind
--     (api_key / oauth_bundle / password / session) for any provider id,
--     each encrypted under its own per-record key, which is itself wrapped
--     by the tenant data key. The master key never leaves the credential
--     service's environment and encrypts nothing but tenant keys.
-- Ciphertext only: no plaintext key, password, token, or session material
-- ever enters these tables.
-- Also widens helmion.provider_connections (031) per design §6: any
-- provider id, the password_session / desktop_tool auth modes, the
-- needs_attention lifecycle state, and the probe receipt columns
-- (last_verified_at + verification_note). The (tenant_id, provider_id)
-- unique key is deliberately NOT widened here: the connection
-- repository's upserts name that conflict target, and changing both
-- belongs to the bite that rewrites the repository's verified writer.

create table if not exists helmion.tenant_vault_keys (
  tenant_id text primary key references helmion.tenants(tenant_id) on delete cascade,
  wrapped_data_key bytea not null,
  wrap_iv bytea not null check (octet_length(wrap_iv) = 12),
  wrap_auth_tag bytea not null check (octet_length(wrap_auth_tag) = 16),
  key_version integer not null default 1 check (key_version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  shredded_at timestamptz
);
alter table helmion.tenant_vault_keys enable row level security;
drop policy if exists tenant_vault_keys_tenant_admin on helmion.tenant_vault_keys;
create policy tenant_vault_keys_tenant_admin on helmion.tenant_vault_keys for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin')) with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'));

create table if not exists helmion.provider_credentials (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_id text not null check (char_length(provider_id) between 1 and 128),
  credential_reference text not null check (char_length(credential_reference) between 1 and 200),
  credential_kind text not null check (credential_kind in ('api_key','oauth_bundle','password','session')),
  record_key_wrapped bytea not null,
  record_key_iv bytea not null check (octet_length(record_key_iv) = 12),
  record_key_auth_tag bytea not null check (octet_length(record_key_auth_tag) = 16),
  ciphertext bytea not null,
  iv bytea not null check (octet_length(iv) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  token_type text not null default 'Bearer',
  scope text,
  expires_at timestamptz,
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (tenant_id, provider_id, credential_reference)
);
create index if not exists provider_credentials_tenant_idx on helmion.provider_credentials(tenant_id, provider_id, revoked_at);
alter table helmion.provider_credentials enable row level security;
drop policy if exists provider_credentials_tenant_admin on helmion.provider_credentials;
create policy provider_credentials_tenant_admin on helmion.provider_credentials for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin')) with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'));

-- provider_connections widening (design §6). Each statement re-creates the
-- 031 constraint under the same name with the wider rule.
alter table helmion.provider_connections drop constraint if exists provider_connections_provider_id_check;
alter table helmion.provider_connections add constraint provider_connections_provider_id_check check (char_length(provider_id) between 1 and 128);
alter table helmion.provider_connections drop constraint if exists provider_connections_auth_mode_check;
alter table helmion.provider_connections add constraint provider_connections_auth_mode_check check (auth_mode in ('api_key','oauth_subscription','password_session','desktop_tool'));
alter table helmion.provider_connections drop constraint if exists provider_connections_lifecycle_check;
alter table helmion.provider_connections add constraint provider_connections_lifecycle_check check (lifecycle in ('pending','verified','needs_attention','disabled'));
alter table helmion.provider_connections add column if not exists last_verified_at timestamptz;
alter table helmion.provider_connections add column if not exists verification_note text check (verification_note is null or char_length(verification_note) <= 500);
