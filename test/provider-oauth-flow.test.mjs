import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exchangeCloudOAuthCode } from '../src/cloud/provider-oauth-flow.mjs';

const verifier = 'V'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const base = { tenantId: 'acme-operations', providerId: 'gemini', clientId: 'helmian-client.apps.googleusercontent.com', code: 'google-authorization-code', codeVerifier: verifier, codeChallenge: challenge, redirectUri: 'https://helmian.example.com/oauth/callback', credentialReference: 'vault://tenant/acme/gemini' };

function vault(calls, accepted = true) {
  return {
    async prepareReference() { return { status: 'external_vault_not_configured', accepted: false }; },
    async storeOAuthTokens(input) { calls.push(input); return { status: accepted ? 'stored_in_external_vault' : 'external_vault_not_configured', accepted }; },
  };
}

test('Gemini token exchange posts PKCE to the documented endpoint and sends token material only to the vault seam', async () => {
  const requests = [];
  const stored = [];
  const result = await exchangeCloudOAuthCode(base, {
    vaultAdapter: vault(stored),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, async json() { return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/generative-language.retriever', token_type: 'Bearer' }; } };
    },
  });
  assert.equal(result.valid, true);
  assert.equal(result.tokenExchange, 'completed');
  assert.equal(result.tokenStorage, 'stored_in_external_vault');
  assert.equal('accessToken' in result, false);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(requests[0].init.body, /grant_type=authorization_code/u);
  assert.match(requests[0].init.body, /code_verifier=/u);
  assert.deepEqual(stored[0], { tenantId: 'acme-operations', providerId: 'gemini', credentialReference: 'vault://tenant/acme/gemini', accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 3600, scope: 'https://www.googleapis.com/auth/generative-language.retriever', tokenType: 'Bearer' });
});

test('provider error is returned without invoking storage', async () => {
  const stored = [];
  const result = await exchangeCloudOAuthCode(base, { vaultAdapter: vault(stored), fetchImpl: async () => ({ ok: false, status: 400, async json() { return { error: 'invalid_grant' }; } }) });
  assert.deepEqual(result, { valid: false, status: 'token_exchange_failed', providerId: 'gemini', tokenExchange: 'failed', tokenStorage: 'not_attempted', httpStatus: 400, providerError: 'invalid_grant' });
  assert.equal(stored.length, 0);
});

test('unsupported provider OAuth never calls a guessed endpoint', async () => {
  let called = false;
  const result = await exchangeCloudOAuthCode({ ...base, providerId: 'openai_codex' }, { fetchImpl: async () => { called = true; }, vaultAdapter: vault([]) });
  assert.equal(result.valid, false);
  assert.equal(result.tokenExchange, 'blocked');
  assert.equal(called, false);
});

test('invalid PKCE fails before network or vault access', async () => {
  let called = false;
  const stored = [];
  const result = await exchangeCloudOAuthCode({ ...base, codeChallenge: 'X'.repeat(43) }, { fetchImpl: async () => { called = true; }, vaultAdapter: vault(stored) });
  assert.equal(result.status, 'pkce_invalid');
  assert.equal(called, false);
  assert.equal(stored.length, 0);
});
