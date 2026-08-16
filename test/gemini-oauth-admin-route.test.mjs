import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_GEMINI_OAUTH_CALLBACK_PATH, LIVE_ADMIN_GEMINI_OAUTH_START_PATH } from '../src/cloud/live-admin.mjs';

const databaseUrl = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';

function pool() {
  const client = {
    async query(sql) {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text) || text.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (text.includes("to_regclass('helmion.provider_connections')")) return { rowCount: 1, rows: [{ provider_connections: 'helmion.provider_connections', provider_oauth_transactions: 'helmion.provider_oauth_transactions', provider_oauth_tokens: 'helmion.provider_oauth_tokens' }] };
      if (text.includes('tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'helmian-platform', role: 'owner' }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

function identity() {
  return { getSession(sessionId) { return sessionId === 'active-session' ? { subject: 'owner-1' } : null; } };
}

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function fixture(envOverrides = {}, providerConnectionRepository = null) {
  const handler = await createLiveHelmianCloudAdminHandler({
    env: { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: databaseUrl, HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', ...envOverrides },
    pool: pool(), identity: identity(), providerVaultAdapter: { prepareReference() {}, storeOAuthTokens() {} }, page: '<!doctype html><title>Admin</title>', script: 'void 0;',
    expectedMigrations: [], providerConnectionRepository,
  });
  const live = await startServer(handler.handler);
  return { ...live, close: async () => { await handler.close(); await new Promise((resolve) => live.server.close(resolve)); } };
}

test('Gemini OAuth start fails closed when client registration is absent', async (t) => {
  const app = await fixture(); t.after(app.close);
  const response = await fetch(`${app.base}${LIVE_ADMIN_GEMINI_OAUTH_START_PATH}`, { redirect: 'manual', headers: { cookie: 'helmion_admin_session=active-session', host: 'helmian.cloud', 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { valid: false, code: 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED' });
});

test('Gemini OAuth start creates state and callback completes through the repository seam', async (t) => {
  const calls = [];
  const repo = {
    async createOAuthTransaction(actor, input) { calls.push(['create', actor, input]); return { durable: true, transaction: { id: 'tx-1' } }; },
    async claimOAuthTransaction(actor, input) { calls.push(['claim', actor, input]); return { durable: true, transaction: { id: 'tx-1', providerId: 'gemini', clientId: 'client.apps.googleusercontent.com', redirectUri: 'https://helmian.cloud/api/admin/provider-oauth/gemini/callback', codeChallenge: input.codeChallenge ?? 'x'.repeat(43), credentialReference: 'vault://tenant/helmian-platform/gemini/oauth' } }; },
    async exchangeOAuth(actor, input) { calls.push(['exchange', actor, input]); return { durable: true, exchange: { status: 'token_stored' } }; },
    async finishOAuthTransaction(actor, input) { calls.push(['finish', actor, input]); return { durable: true }; },
    async list() { return { connections: [] }; },
    async save() { return { durable: true }; },
  };
  const app = await fixture({ HELMION_GEMINI_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com' }, repo); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session', host: 'helmian.cloud', 'x-forwarded-proto': 'https' };
  const started = await fetch(`${app.base}${LIVE_ADMIN_GEMINI_OAUTH_START_PATH}`, { redirect: 'manual', headers });
  assert.equal(started.status, 302);
  assert.match(started.headers.get('location'), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/u);
  const cookies = started.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  const state = started.headers.getSetCookie()[0].split('=', 2)[1].split(';', 1)[0];
  assert.match(state, /^[A-Za-z0-9_-]{32,128}$/u);
  const callback = await fetch(`${app.base}${LIVE_ADMIN_GEMINI_OAUTH_CALLBACK_PATH}?code=google-code&state=${state}`, { redirect: 'manual', headers: { host: 'helmian.cloud', 'x-forwarded-proto': 'https', Cookie: `helmion_admin_session=active-session; ${cookies}` } });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location'), /provider_oauth=connected/u);
  assert.equal(calls.some(([name]) => name === 'exchange'), true);
  assert.equal(calls.find(([name]) => name === 'finish')[2].status, 'completed');
});
