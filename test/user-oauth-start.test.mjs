import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleUserOAuthRoute,
  USER_GEMINI_OAUTH_START,
  USER_GROK_OAUTH_START,
  USER_OPENAI_OAUTH_START,
} from '../src/cloud/user-oauth.mjs';

// The Integrations "Connect" buttons navigate the browser to these start
// paths. Each start must either send the user to the provider's real sign-in
// door (302 with the right parameters) or fail honestly (503 configuration
// error) — never strand the user. Gemini's start/callback pair is covered
// in provider-oauth-vault.test.mjs; this file covers the other two doors
// plus the honest not-configured answers.

async function callUserOAuth(path, { method = 'GET' } = {}) {
  const calls = [];
  const requestUrl = new URL(`https://helmian.cloud${path}`);
  const request = { method, headers: {} };
  const send = (response, status, body, contentType, headers) => { calls.push({ status, body, contentType, headers }); };
  const handled = await handleUserOAuthRoute({ request, response: {}, requestUrl, send });
  return { handled, calls };
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) { saved[key] = process.env[key]; process.env[key] = values[key]; }
  return fn().finally(() => {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
}

test('Gemini user OAuth start answers an honest 503 (not a dead end) when the client is not configured', async () => {
  await withEnv({ HELMION_GEMINI_OAUTH_CLIENT_ID: '' }, async () => {
    delete process.env.HELMION_GEMINI_OAUTH_CLIENT_ID;
    const { handled, calls } = await callUserOAuth(USER_GEMINI_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 503);
    assert.equal(JSON.parse(calls[0].body).code, 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED');
  });
});

test('OpenAI user OAuth start redirects to the ChatGPT sign-in door with PKCE parameters', async () => {
  await withEnv({ HELMION_OPENAI_OAUTH_CLIENT_ID: 'openai-client-123' }, async () => {
    const { handled, calls } = await callUserOAuth(USER_OPENAI_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 302);
    const location = new URL(calls[0].headers.location);
    assert.equal(location.origin, 'https://auth.openai.com');
    assert.equal(location.pathname, '/api/accounts/authorize');
    assert.equal(location.searchParams.get('client_id'), 'openai-client-123');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://helmian.cloud/api/provider-oauth/openai/callback');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.match(location.searchParams.get('scope') ?? '', /openid/u);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    assert.ok(location.searchParams.get('state'));
    const cookies = calls[0].headers['set-cookie'].join('\n');
    assert.match(cookies, /helmion_user_openai_state=/u);
    assert.match(cookies, /helmion_user_openai_verifier=/u);
  });
});

test('OpenAI user OAuth start answers an honest 503 when the client is not configured', async () => {
  await withEnv({ HELMION_OPENAI_OAUTH_CLIENT_ID: '' }, async () => {
    delete process.env.HELMION_OPENAI_OAUTH_CLIENT_ID;
    const { handled, calls } = await callUserOAuth(USER_OPENAI_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 503);
    assert.equal(JSON.parse(calls[0].body).error, 'ChatGPT OAuth not configured');
  });
});

test('Grok user OAuth start shows the device code page for the user to approve on X', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: new URLSearchParams(String(options.body)) });
    return {
      ok: true,
      async json() {
        return { device_code: 'device-code-1', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/oauth2/device', interval: 5 };
      },
    };
  };
  try {
    const { handled, calls } = await callUserOAuth(USER_GROK_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 200);
    assert.match(calls[0].body, /ABCD-EFGH/u);
    assert.match(calls[0].body, /accounts\.x\.ai\/oauth2\/device/u);
    assert.match(calls[0].body, /\/api\/provider-oauth\/grok\/poll/u);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://auth.x.ai/oauth2/device/code');
    assert.equal(requests[0].body.get('grant_type'), null);
    assert.ok(requests[0].body.get('client_id'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Grok user OAuth start reports an honest failure when xAI refuses the device code', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, async json() { return { error_description: 'invalid_client' }; } });
  try {
    const { handled, calls } = await callUserOAuth(USER_GROK_OAUTH_START);
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 500);
    assert.match(calls[0].body, /invalid_client/u);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unknown provider-oauth path is not handled (the router answers, not the handler)', async () => {
  const { handled, calls } = await callUserOAuth('/api/provider-oauth/unknown/start');
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
