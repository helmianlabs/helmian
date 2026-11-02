import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleUserOAuthRoute,
  USER_GEMINI_OAUTH_START,
  USER_GROK_OAUTH_POLL,
  USER_GROK_OAUTH_START,
  USER_OPENAI_OAUTH_START,
} from '../src/cloud/user-oauth.mjs';

// The /api/provider-oauth/* connect roads are RETIRED (one-road
// removal pass, Bite 12, 2026-11-02): an AI connects with its account
// email and password on its Integrations card, never through an OAuth
// redirect or a device code. user-oauth.mjs remains only as a fence —
// every retired path answers 410, whatever the environment claims is
// configured, and no provider endpoint is ever contacted. (The router
// in envoy-ably.mjs answers 410 for the whole prefix before this
// handler is even consulted; these tests pin the handler's own fence.)
// Gemini's start/callback pair is also covered in
// provider-oauth-vault.test.mjs.

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

test('Gemini user OAuth start is retired: 410 even when a client is configured', async () => {
  process.env.HELMION_GEMINI_OAUTH_CLIENT_ID = 'client.apps.googleusercontent.com';
  try {
    assertRetired(await callUserOAuth(USER_GEMINI_OAUTH_START));
  } finally {
    delete process.env.HELMION_GEMINI_OAUTH_CLIENT_ID;
  }
});

test('OpenAI user OAuth start is retired: 410 even when a client is configured', async () => {
  process.env.HELMION_OPENAI_OAUTH_CLIENT_ID = 'openai-client-123';
  try {
    assertRetired(await callUserOAuth(USER_OPENAI_OAUTH_START));
  } finally {
    delete process.env.HELMION_OPENAI_OAUTH_CLIENT_ID;
  }
});

test('Grok user OAuth start is retired: 410 and xAI is never contacted for a device code', async () => {
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

test('Grok user OAuth poll is retired: 410 and xAI is never contacted', async () => {
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

test('OpenAI user OAuth callback is retired: 410, no code exchange is attempted', async () => {
  assertRetired(await callUserOAuth('/api/provider-oauth/openai/callback?code=x&state=y'));
});

test('an unknown provider-oauth path is not handled by the fence (the router answers 410 for the prefix)', async () => {
  const { handled, calls } = await callUserOAuth('/api/provider-oauth/unknown/start');
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
