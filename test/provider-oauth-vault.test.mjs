import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { createDatabaseEncryptedVaultAdapter } from '../src/cloud/database-encrypted-vault-adapter.mjs';
import { createGeminiOAuthPkce, GEMINI_OAUTH_CALLBACK_PATH, GEMINI_OAUTH_USER_CALLBACK_PATH, resolveGeminiOAuthConfig, resolveGeminiUserOAuthConfig } from '../src/cloud/provider-oauth-config.mjs';
import { handleUserOAuthRoute, USER_GEMINI_OAUTH_CALLBACK, USER_GEMINI_OAUTH_START } from '../src/cloud/user-oauth.mjs';

function fakePool() {
  const calls = [];
  let storedToken = null;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (['begin', 'commit', 'rollback'].includes(String(sql))) return { rowCount: 0, rows: [] };
      if (String(sql).startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (String(sql).includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
       if (String(sql).includes('insert into helmion.provider_oauth_tokens')) {
         storedToken = { ciphertext: values[3], iv: values[4], auth_tag: values[5], token_type: values[6] };
         return { rowCount: 1, rows: [{ id: 17 }] };
       }
       if (String(sql).includes('from helmion.provider_oauth_tokens')) return storedToken ? { rowCount: 1, rows: [storedToken] } : { rowCount: 0, rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

test('Gemini registration config binds the callback to the current HTTPS origin', () => {
  const missing = resolveGeminiOAuthConfig({}, 'https://helmian.cloud');
  assert.deepEqual(missing, { configured: false, code: 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED' });
  const config = resolveGeminiOAuthConfig({ HELMION_GEMINI_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com' }, 'https://helmian.cloud');
  assert.equal(config.configured, true);
  assert.equal(config.redirectUri, 'https://helmian.cloud/api/admin/provider-oauth/gemini/callback');
  assert.equal(resolveGeminiOAuthConfig({ HELMION_GEMINI_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', HELMION_GEMINI_OAUTH_REDIRECT_URI: 'https://evil.example/callback' }, 'https://helmian.cloud').configured, false);
});

test('Gemini user OAuth config binds the callback to the user path, never the admin path', () => {
  const client = { HELMION_GEMINI_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com' };
  // The config module's user callback path is the route the user flow serves.
  assert.equal(GEMINI_OAUTH_USER_CALLBACK_PATH, USER_GEMINI_OAUTH_CALLBACK);
  const user = resolveGeminiUserOAuthConfig(client, 'https://helmian.cloud');
  assert.equal(user.configured, true);
  assert.equal(user.redirectUri, 'https://helmian.cloud/api/provider-oauth/gemini/callback');
  // A redirect onto the admin path is rejected for the user flow...
  assert.equal(resolveGeminiUserOAuthConfig({ ...client, HELMION_GEMINI_USER_OAUTH_REDIRECT_URI: 'https://helmian.cloud/api/admin/provider-oauth/gemini/callback' }, 'https://helmian.cloud').configured, false);
  // ...and a redirect onto the user path is rejected for the admin flow.
  assert.equal(resolveGeminiOAuthConfig({ ...client, HELMION_GEMINI_OAUTH_REDIRECT_URI: 'https://helmian.cloud/api/provider-oauth/gemini/callback' }, 'https://helmian.cloud').configured, false);
  // The admin redirect override does not leak into the user flow.
  const separated = resolveGeminiUserOAuthConfig({ ...client, HELMION_GEMINI_OAUTH_REDIRECT_URI: 'https://helmian.cloud/api/admin/provider-oauth/gemini/callback' }, 'https://helmian.cloud');
  assert.equal(separated.configured, true);
  assert.equal(separated.redirectUri, 'https://helmian.cloud/api/provider-oauth/gemini/callback');
  // The admin flow default stays on the admin path.
  assert.equal(resolveGeminiOAuthConfig(client, 'https://helmian.cloud').redirectUri, `https://helmian.cloud${GEMINI_OAUTH_CALLBACK_PATH}`);
});

async function callUserOAuth(path, { cookie = '' } = {}) {
  const calls = [];
  const requestUrl = new URL(`https://helmian.cloud${path}`);
  const request = { method: 'GET', headers: { cookie } };
  const send = (response, status, body, contentType, headers) => { calls.push({ status, body, contentType, headers }); };
  const handled = await handleUserOAuthRoute({ request, response: {}, requestUrl, send });
  return { handled, calls };
}

test('Gemini user OAuth start redirects to Google with the user callback and user cookies', async () => {
  process.env.HELMION_GEMINI_OAUTH_CLIENT_ID = 'client.apps.googleusercontent.com';
  try {
    const { handled, calls } = await callUserOAuth(USER_GEMINI_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 302);
    const location = new URL(calls[0].headers.location);
    assert.equal(location.searchParams.get('redirect_uri'), 'https://helmian.cloud/api/provider-oauth/gemini/callback');
    const cookies = calls[0].headers['set-cookie'].join('\n');
    assert.match(cookies, /helmion_user_gemini_state=/u);
    assert.match(cookies, /helmion_user_gemini_verifier=/u);
    assert.equal(cookies.includes('helmion_gemini_oauth_state'), false);
  } finally {
    delete process.env.HELMION_GEMINI_OAUTH_CLIENT_ID;
  }
});

test('Gemini user OAuth callback accepts only the user state cookie and exchanges against the user redirect', async () => {
  process.env.HELMION_GEMINI_OAUTH_CLIENT_ID = 'client.apps.googleusercontent.com';
  const realFetch = globalThis.fetch;
  const exchanges = [];
  globalThis.fetch = async (url, options) => {
    exchanges.push({ url: String(url), body: new URLSearchParams(String(options.body)) });
    return { ok: true, async json() { return { access_token: 'user-access-token' }; } };
  };
  try {
    // State carried only under the ADMIN cookie names must not satisfy the user callback.
    const adminCookie = await callUserOAuth(`${USER_GEMINI_OAUTH_CALLBACK}?code=google-code&state=state-123`, { cookie: 'helmion_gemini_oauth_state=state-123; helmion_gemini_oauth_verifier=verifier-123' });
    assert.equal(adminCookie.calls[0].status, 400);
    assert.equal(exchanges.length, 0);
    // A mismatched user state is rejected before any exchange.
    const mismatch = await callUserOAuth(`${USER_GEMINI_OAUTH_CALLBACK}?code=google-code&state=state-999`, { cookie: 'helmion_user_gemini_state=state-123; helmion_user_gemini_verifier=verifier-123' });
    assert.equal(mismatch.calls[0].status, 400);
    assert.equal(exchanges.length, 0);
    // Matching user state + PKCE verifier completes the exchange with the user redirect URI.
    const ok = await callUserOAuth(`${USER_GEMINI_OAUTH_CALLBACK}?code=google-code&state=state-123`, { cookie: 'helmion_user_gemini_state=state-123; helmion_user_gemini_verifier=verifier-123' });
    assert.equal(ok.calls[0].status, 200);
    assert.match(ok.calls[0].body, /user-access-token/u);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].body.get('redirect_uri'), 'https://helmian.cloud/api/provider-oauth/gemini/callback');
    assert.equal(exchanges[0].body.get('code_verifier'), 'verifier-123');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HELMION_GEMINI_OAUTH_CLIENT_ID;
  }
});

test('database vault stores only AES-GCM ciphertext and keeps token material out of SQL parameters', async () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  const pool = fakePool();
  const vault = createDatabaseEncryptedVaultAdapter({ pool, key });
  const result = await vault.storeOAuthTokens({ tenantId: 'acme-operations', providerId: 'gemini', credentialReference: 'vault://tenant/acme-operations/gemini/oauth', actorSubject: 'owner-1', actorRole: 'owner', sessionId: 'session-1', requestId: 'request-1', accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 3600, scope: 'https://www.googleapis.com/auth/generative-language.retriever', tokenType: 'Bearer' });
  assert.equal(result.accepted, true);
  const write = pool.calls.find((call) => call.sql.includes('insert into helmion.provider_oauth_tokens'));
  assert.ok(write);
  assert.equal(write.values.includes('access-secret'), false);
  assert.equal(write.values.includes('refresh-secret'), false);
  const [ciphertext, iv, authTag] = write.values.slice(3, 6);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  decipher.setAAD(Buffer.from('acme-operations\0gemini\0vault://tenant/acme-operations/gemini/oauth', 'utf8'));
  decipher.setAuthTag(authTag);
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')), { accessToken: 'access-secret', refreshToken: 'refresh-secret' });
});

test('database vault rejects a credential reference belonging to another tenant', async () => {
  const adapter = createDatabaseEncryptedVaultAdapter({ pool: fakePool(), key: Buffer.alloc(32, 9).toString('base64url') });
  await assert.rejects(() => adapter.prepareReference({ tenantId: 'tenant-a', providerId: 'gemini', credentialReference: 'vault://tenant/tenant-b/gemini/oauth' }), /reference is invalid/);
});

test('database vault resolves a tenant credential only after membership and never returns it as metadata', async () => {
  const pool = fakePool();
  const vault = createDatabaseEncryptedVaultAdapter({ pool, key: Buffer.alloc(32, 7).toString('base64url') });
  await vault.storeOAuthTokens({ tenantId: 'acme-operations', providerId: 'gemini', credentialReference: 'vault://tenant/acme-operations/gemini/oauth', actorSubject: 'owner-1', actorRole: 'owner', sessionId: 'session-1', requestId: 'request-1', accessToken: 'access-secret', refreshToken: null });
  const result = await vault.resolveCredential({ tenantId: 'acme-operations', providerId: 'gemini', credentialReference: 'vault://tenant/acme-operations/gemini/oauth', actorSubject: 'owner-1', actorRole: 'owner', sessionId: 'session-1', requestId: 'request-1' });
  assert.equal(result.accepted, true);
  assert.equal(result.credential, 'access-secret');
  assert.equal(result.secretMaterial, 'adapter_only');
  assert.equal(Object.hasOwn(result, 'refreshToken'), false);
});

test('PKCE generator produces verifier/challenge material accepted by the existing contract', () => {
  const pair = createGeminiOAuthPkce();
  assert.match(pair.state, /^[A-Za-z0-9_-]{32,128}$/u);
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(pair.codeChallengeMethod, 'S256');
});
