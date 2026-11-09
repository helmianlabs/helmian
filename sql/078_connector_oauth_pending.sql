-- Connector OAuth pending handshakes (mirror M1, 2026-11-09): when a
-- person presses Connect on a Helmian-brokered OAuth connector inside
-- Helmian (the Scribe door first), Helmian starts the authorization
-- road and must remember the handshake across the redirect to the
-- provider's consent page and back: the PKCE verifier, the client id
-- Helmian registered, and who started it. The row is keyed by a hash
-- of the OAuth `state` value — the state itself is never stored.
--
--   state_hash   — sha256 hex of the state the browser carries.
--   person_id    — the member who started the connect; the callback
--                  lands the connection on THIS person only.
--   seat_id/entry_id — the library entry being connected.
--   client_id    — the OAuth client Helmian used (DCR-registered at
--                  the Scribe door; static for other providers).
--   code_verifier — the PKCE S256 verifier for the token exchange.
--   redirect_uri — the callback the code returns to.
--   expires_at   — a pending handshake dies 15 minutes after it
--                  starts; a completed or expired row is deleted.
--
-- RLS follows the connector library's own pattern (sql/074): every
-- policy keyed on the tenant transaction setting. The write route
-- fails soft until this migration is applied: with the table missing,
-- connect answers that the OAuth road is not switched on yet, and
-- every other library write keeps working.

create table if not exists helmion.connector_oauth_pending (
  tenant_id text not null,
  state_hash text not null,
  person_id text not null,
  seat_id text not null,
  entry_id text not null,
  provider text not null,
  client_id text not null,
  code_verifier text not null,
  redirect_uri text not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  primary key (tenant_id, state_hash)
);

alter table helmion.connector_oauth_pending enable row level security;
drop policy if exists connector_oauth_pending_tenant_select on helmion.connector_oauth_pending;
create policy connector_oauth_pending_tenant_select on helmion.connector_oauth_pending for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_oauth_pending_tenant_insert on helmion.connector_oauth_pending;
create policy connector_oauth_pending_tenant_insert on helmion.connector_oauth_pending for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_oauth_pending_tenant_update on helmion.connector_oauth_pending;
create policy connector_oauth_pending_tenant_update on helmion.connector_oauth_pending for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists connector_oauth_pending_tenant_delete on helmion.connector_oauth_pending;
create policy connector_oauth_pending_tenant_delete on helmion.connector_oauth_pending for delete using (tenant_id = current_setting('helmion.tenant_id', true));
