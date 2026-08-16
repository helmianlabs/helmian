const REQUIRED_TABLES = Object.freeze([
  'helmion.provider_connections',
  'helmion.provider_oauth_transactions',
  'helmion.provider_oauth_tokens',
]);

export async function readGeminiOAuthReadiness({ pool, config, vaultAdapter } = {}) {
  if (!config?.configured) return Object.freeze({ ready: false, code: config?.code ?? 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED' });
  if (!vaultAdapter) return Object.freeze({ ready: false, code: 'GEMINI_OAUTH_VAULT_NOT_CONFIGURED' });
  if (!pool || typeof pool.connect !== 'function') return Object.freeze({ ready: false, code: 'GEMINI_OAUTH_SCHEMA_CHECK_FAILED' });

  let client;
  try {
    client = await pool.connect();
    const result = await client.query("select to_regclass('helmion.provider_connections') as provider_connections, to_regclass('helmion.provider_oauth_transactions') as provider_oauth_transactions, to_regclass('helmion.provider_oauth_tokens') as provider_oauth_tokens");
    const row = result?.rows?.[0] ?? {};
    const missing = REQUIRED_TABLES.filter((table) => row[table.slice('helmion.'.length)] == null);
    if (missing.length > 0) return Object.freeze({ ready: false, code: 'GEMINI_OAUTH_SCHEMA_NOT_READY' });
    return Object.freeze({ ready: true, code: 'GEMINI_OAUTH_READY' });
  } catch {
    return Object.freeze({ ready: false, code: 'GEMINI_OAUTH_SCHEMA_CHECK_FAILED' });
  } finally {
    client?.release?.();
  }
}
