import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUserOAuthHandler,
  createUserOAuthRoadsHandler,
  handleUserOAuthRoute,
  USER_GEMINI_OAUTH_CALLBACK,
  USER_GEMINI_OAUTH_START,
  USER_GROK_OAUTH_POLL,
  USER_GROK_OAUTH_START,
  USER_OAUTH_ROADS_PATH,
  USER_OPENAI_OAUTH_START,
} from '../src/cloud/user-oauth.mjs';

// The /api/provider-oauth/* roads were retired wholesale by the
// one-road removal pass (Bite 12, 2026-11-02). Troy's order of
// 2026-11-17 (Scribe letter 935) restored exactly one of them:
// Gemini's documented Google OAuth, the only genuine self-serve
// OAuth road among the seats (verified 2026-11-18). These tests pin
// the restored Gemini flow against fakes, and pin the 410 fence on
// the roads that stay retired (ChatGPT: partner-gated; Grok:
// first-party only).

const ACTOR = { tenantId: 'tenant-1', subject: 'user_1', role: 'owner', sessionId: 'sess-1', requestId: 'req-1' };
const ENV = { HELMION_GEMINI_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', HELMION_APP_ORIGIN: 'https://helmian.cloud' };

function fakePool() {
  return {
    connect: async () => ({
      query: async () => ({ rows: [{ provider_connections: 'helmion.provider_connections', provider_oauth_transactions: 'helmion.provider_oauth_transactions', provider_oauth_tokens: 'helmion.provider_oauth_tokens' }] }),
      release() {},
    }),
  };
}

function fakeRepository() {
  const calls = { created: [], claimed: [], exchanged: [], finished: [] };
  return {
    calls,
    async createOAuthTransaction(actor, input) { calls.created.push(input); return { durable: true, transaction: { id: 'tx-1' } }; },
    async claimOAuthTransaction(actor, input) {
      calls.claimed.push(input);
      return { durable: true, transaction: { id: 'tx-1', providerId: 'gemini', clientId: ENV.HELMION_GEMINI_OAUTH_CLIENT_ID, codeChallenge: 'challenge', redirectUri: 'https://helmian.cloud/api/provider-oauth/gemini/callback', credentialReference: 'vault://tenant/tenant-1/gemini/oauth' } };
    },
    async exchangeOAuth(actor, input) { calls.exchanged.push(input); return { durable: true, exchange: { status: 'token_stored' } }; },
    async finishOAuthTransaction(actor, input) { calls.finished.push(input); return { durable: true }; },
  };
}

async function callHandler(handler, path, { method = 'GET', actor = ACTOR, headers = {} } = {}) {
  const calls = [];
  const requestUrl = new URL(`https://helmian.cloud${path}`);
  const request = { method, headers };
  const send = (response, status, body, contentType, hdrs) => { calls.push({ status, body, contentType, headers: hdrs }); };
  const handled = await handler({ request, response: {}, requestUrl, activeTenantActor: async () => actor, send, TenantAuthorizationError: class extends Error {} });
  return { handled, calls };
}

test('Gemini start: a durable transaction is recorded and the browser is sent to Google with PKCE', async () => {
  const repository = fakeRepository();
  const handler = createUserOAuthHandler({ env: ENV, pool: fakePool(), repository, vaultAdapter: {} });
  const { handled, calls } = await callHandler(handler, USER_GEMINI_OAUTH_START);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 302);
  const location = new URL(calls[0].headers.location);
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('client_id'), ENV.HELMION_GEMINI_OAUTH_CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), 'https://helmian.cloud/api/provider-oauth/gemini/callback');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('state')?.length >= 32);
  assert.ok(location.searchParams.get('code_challenge')?.length >= 43);
  const cookies = calls[0].headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 2);
  assert.ok(cookies[0].startsWith('helmion_gemini_user_oauth_state='));
  assert.ok(cookies[1].startsWith('helmion_gemini_user_oauth_verifier='));
  assert.equal(repository.calls.created.length, 1);
  assert.equal(repository.calls.created[0].providerId, 'gemini');
  assert.equal(repository.calls.created[0].credentialReference, 'vault://tenant/tenant-1/gemini/oauth');
});

test('Gemini start: without a configured client the road answers 503 and records nothing', async () => {
  const repository = fakeRepository();
  const handler = createUserOAuthHandler({ env: {}, pool: fakePool(), repository, vaultAdapter: {} });
  const { calls } = await callHandler(handler, USER_GEMINI_OAUTH_START);
  assert.equal(calls[0].status, 503);
  assert.equal(JSON.parse(calls[0].body).code, 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED');
  assert.equal(repository.calls.created.length, 0);
});

test('Gemini start: a member who is not owner or admin is refused 403', async () => {
  const repository = fakeRepository();
  const handler = createUserOAuthHandler({ env: ENV, pool: fakePool(), repository, vaultAdapter: {} });
  const { calls } = await callHandler(handler, USER_GEMINI_OAUTH_START, { actor: { ...ACTOR, role: 'member' } });
  assert.equal(calls[0].status, 403);
  assert.equal(repository.calls.created.length, 0);
});

test('Gemini callback: state match claims the transaction, exchanges the code, lands connected', async () => {
  const repository = fakeRepository();
  const handler = createUserOAuthHandler({ env: ENV, pool: fakePool(), repository, vaultAdapter: {} });
  const state = 's'.repeat(43);
  const headers = { cookie: `helmion_gemini_user_oauth_state=${state}; helmion_gemini_user_oauth_verifier=${'v'.repeat(43)}` };
  const { handled, calls } = await callHandler(handler, `${USER_GEMINI_OAUTH_CALLBACK}?code=auth-code&state=${state}`, { headers });
  assert.equal(handled, true);
  assert.equal(calls[0].status, 302);
  assert.equal(calls[0].headers.location, '/app/?provider_oauth=connected');
  assert.equal(repository.calls.claimed.length, 1);
  assert.equal(repository.calls.exchanged.length, 1);
  assert.equal(repository.calls.exchanged[0].code, 'auth-code');
  assert.deepEqual(repository.calls.finished, [{ transactionId: 'tx-1', status: 'completed', errorCode: null }]);
});

test('Gemini callback: a state that does not match the cookie is refused 400 and nothing is exchanged', async () => {
  const repository = fakeRepository();
  const handler = createUserOAuthHandler({ env: ENV, pool: fakePool(), repository, vaultAdapter: {} });
  const headers = { cookie: `helmion_gemini_user_oauth_state=${'a'.repeat(43)}; helmion_gemini_user_oauth_verifier=${'v'.repeat(43)}` };
  const { calls } = await callHandler(handler, `${USER_GEMINI_OAUTH_CALLBACK}?code=auth-code&state=${'b'.repeat(43)}`, { headers });
  assert.equal(calls[0].status, 400);
  assert.equal(JSON.parse(calls[0].body).code, 'GEMINI_OAUTH_CALLBACK_STATE_INVALID');
  assert.equal(repository.calls.claimed.length, 0);
  assert.equal(repository.calls.exchanged.length, 0);
});

test('roads read: a configured deployment reports the Gemini road; an unconfigured one does not', async () => {
  const call = async (handler) => {
    const calls = [];
    const requestUrl = new URL(`https://helmian.cloud${USER_OAUTH_ROADS_PATH}`);
    const handled = await handler({ request: { method: 'GET', headers: { host: 'helmian.cloud' } }, response: {}, requestUrl, activeTenantActor: async () => ACTOR, send: (r, status, body) => calls.push({ status, body }), TenantAuthorizationError: class extends Error {} });
    return { handled, calls };
  };
  const configured = await call(createUserOAuthRoadsHandler({ env: ENV }));
  assert.equal(configured.handled, true);
  assert.equal(configured.calls[0].status, 200);
  assert.deepEqual(JSON.parse(configured.calls[0].body).oauth, { gemini: true });
  const unconfigured = await call(createUserOAuthRoadsHandler({ env: {} }));
  assert.equal(unconfigured.calls[0].status, 200);
  assert.deepEqual(JSON.parse(unconfigured.calls[0].body).oauth, { gemini: false });
});

async function callUserOAuth(path, { method = 'GET' } = {}) {
  const calls = [];
  const requestUrl = new URL(`https://helmian.cloud${path}`);
  const request = { method, headers: {} };
  const send = (response, status, body, contentType, headers) => { calls.push({ status, body, contentType, headers }); };
  const handled = await handleUserOAuthRoute({ request, response: {}, requestUrl, send });
  return { handled, calls };
}

function assertRetired({ handled, calls }) {
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 410);
  assert.equal(JSON.parse(calls[0].body).code, 'PROVIDER_OAUTH_RETIRED');
}

test('OpenAI user OAuth start stays retired: 410 even when a client is configured', async () => {
  assertRetired(await callUserOAuth(USER_OPENAI_OAUTH_START));
});

test('Grok user OAuth start stays retired: 410 and xAI is never contacted for a device code', async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not be called'); };
  try {
    assertRetired(await callUserOAuth(USER_GROK_OAUTH_START));
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Grok user OAuth poll stays retired: 410 and xAI is never contacted', async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not be called'); };
  try {
    assertRetired(await callUserOAuth(USER_GROK_OAUTH_POLL, { method: 'POST' }));
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI user OAuth callback stays retired: 410, no code exchange is attempted', async () => {
  assertRetired(await callUserOAuth('/api/provider-oauth/openai/callback?code=x&state=y'));
});

test('an unknown provider-oauth path is not handled by the handler (the router answers 410 for the prefix)', async () => {
  const { handled, calls } = await callUserOAuth('/api/provider-oauth/unknown/start');
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
