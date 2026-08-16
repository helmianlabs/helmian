import assert from 'node:assert/strict';
import test from 'node:test';
import { readGeminiOAuthReadiness } from '../src/cloud/provider-oauth-readiness.mjs';

const config = Object.freeze({ configured: true });
const vaultAdapter = Object.freeze({ prepareReference() {} });

function pool(row) {
  return {
    async connect() {
      return { async query() { return { rows: [row] }; }, release() {} };
    },
  };
}

test('OAuth readiness reports all required tables as ready', async () => {
  const result = await readGeminiOAuthReadiness({ pool: pool({ provider_connections: 'helmion.provider_connections', provider_oauth_transactions: 'helmion.provider_oauth_transactions', provider_oauth_tokens: 'helmion.provider_oauth_tokens' }), config, vaultAdapter });
  assert.deepEqual(result, { ready: true, code: 'GEMINI_OAUTH_READY' });
});

test('OAuth readiness fails closed when the durable OAuth schema is incomplete', async () => {
  const result = await readGeminiOAuthReadiness({ pool: pool({ provider_connections: 'helmion.provider_connections', provider_oauth_transactions: null, provider_oauth_tokens: null }), config, vaultAdapter });
  assert.deepEqual(result, { ready: false, code: 'GEMINI_OAUTH_SCHEMA_NOT_READY' });
});

test('OAuth readiness fails closed when the encrypted vault is unavailable', async () => {
  const result = await readGeminiOAuthReadiness({ pool: pool({}), config, vaultAdapter: null });
  assert.deepEqual(result, { ready: false, code: 'GEMINI_OAUTH_VAULT_NOT_CONFIGURED' });
});
