import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { createDatabaseEncryptedVaultAdapter } from '../src/cloud/database-encrypted-vault-adapter.mjs';
import { createGeminiOAuthPkce, resolveGeminiOAuthConfig } from '../src/cloud/provider-oauth-config.mjs';

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (['begin', 'commit', 'rollback'].includes(String(sql))) return { rowCount: 0, rows: [] };
      if (String(sql).startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (String(sql).includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      if (String(sql).includes('insert into helmion.provider_oauth_tokens')) return { rowCount: 1, rows: [{ id: 17 }] };
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

test('PKCE generator produces verifier/challenge material accepted by the existing contract', () => {
  const pair = createGeminiOAuthPkce();
  assert.match(pair.state, /^[A-Za-z0-9_-]{32,128}$/u);
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(pair.codeChallengeMethod, 'S256');
});
