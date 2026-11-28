// READ-ONLY row dump for the seat audit. SELECT only. No secret material:
// ciphertext/token columns are never selected, only presence booleans.
import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT FAIL'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
const show = (label, rows) => console.log('\n### ' + label + ' (' + rows.length + ')\n' + JSON.stringify(rows, null, 1));
try {
  show('tenants', (await pool.query(`select tenant_id, display_name, created_at from helmion.tenants order by created_at`)).rows);
  show('runner_provider_presence', (await pool.query(`select tenant_id, provider_name, connected, updated_at, last_answered_at from helmion.runner_provider_presence order by tenant_id, provider_name`)).rows);
  show('provider_connections', (await pool.query(`select tenant_id, provider_id, auth_mode, lifecycle, adapter, (credential_reference is not null) as has_cred_ref, last_verified_at from helmion.provider_connections order by tenant_id, provider_id`)).rows);
  show('provider_credentials', (await pool.query(`select tenant_id, provider_id, credential_kind, token_type, (revoked_at is not null) as revoked, created_at from helmion.provider_credentials order by tenant_id, provider_id`)).rows);
  show('provider_oauth_tokens', (await pool.query(`select tenant_id, provider_id, token_type, (revoked_at is not null) as revoked, expires_at from helmion.provider_oauth_tokens order by tenant_id, provider_id`)).rows);
  show('envoy_channels', (await pool.query(`select id, tenant_id, slug, title, kind, created_at from helmion.envoy_channels order by tenant_id, created_at`)).rows);
  show('workspace_agent_sessions', (await pool.query(`select tenant_id, name, provider, routing_tier, status, updated_at from helmion.workspace_agent_sessions order by tenant_id, provider, name`)).rows);
  show('workspace_agent_faces', (await pool.query(`select tenant_id, provider, emoji from helmion.workspace_agent_faces order by tenant_id, provider`)).rows);
  show('workspace_agent_icons', (await pool.query(`select tenant_id, provider_name, icon_emoji from helmion.workspace_agent_icons order by tenant_id, provider_name`)).rows);
  show('tenant_vault_keys', (await pool.query(`select tenant_id, key_version, (shredded_at is not null) as shredded from helmion.tenant_vault_keys order by tenant_id`)).rows);
  show('runner_activity providers (7d)', (await pool.query(`select tenant_id, provider_name, count(*) as n, max(at) as last_at from helmion.runner_activity where at > now() - interval '7 days' group by tenant_id, provider_name order by tenant_id, provider_name`)).rows);
} finally { await pool.end(); }
