-- Durable OAuth state and encrypted token vault for tenant provider connections.
-- Raw authorization codes, access tokens, refresh tokens, and client secrets are
-- never stored. Tokens are AES-256-GCM ciphertext encrypted by the app-owned
-- vault adapter with HELMION_OAUTH_VAULT_KEY; this table contains no plaintext.
create table if not exists helmion.provider_oauth_transactions (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_id text not null check (provider_id in ('openai_codex','claude','gemini','grok')),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null check (char_length(client_id) between 1 and 256),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 512),
  code_challenge text not null check (char_length(code_challenge) between 43 and 128),
  credential_reference text not null check (char_length(credential_reference) between 1 and 200),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed','expired')),
  error_code text,
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  unique (tenant_id, provider_id, state_hash)
);
create index if not exists provider_oauth_transactions_pending_idx on helmion.provider_oauth_transactions(tenant_id, provider_id, status, expires_at);
alter table helmion.provider_oauth_transactions enable row level security;
drop policy if exists provider_oauth_transactions_tenant_admin on helmion.provider_oauth_transactions;
create policy provider_oauth_transactions_tenant_admin on helmion.provider_oauth_transactions for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin')) with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'));

create table if not exists helmion.provider_oauth_tokens (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider_id text not null check (provider_id in ('openai_codex','claude','gemini','grok')),
  credential_reference text not null check (char_length(credential_reference) between 1 and 200),
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
create index if not exists provider_oauth_tokens_tenant_idx on helmion.provider_oauth_tokens(tenant_id, provider_id, revoked_at);
alter table helmion.provider_oauth_tokens enable row level security;
drop policy if exists provider_oauth_tokens_tenant_admin on helmion.provider_oauth_tokens;
create policy provider_oauth_tokens_tenant_admin on helmion.provider_oauth_tokens for all using (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin')) with check (tenant_id = current_setting('helmion.tenant_id', true) and current_setting('helmion.actor_role', true) in ('owner','admin'));
