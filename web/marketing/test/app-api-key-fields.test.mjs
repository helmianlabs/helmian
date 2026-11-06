// ApiKeyFields tests: the catalog seats' connect component renders
// the registry row's field shape (one key; Cloudflare's two pieces),
// sends exactly the body the connect route accepts (a bare key for a
// one-field row, the named fields for a multi-field row), and follows
// the ConnectFields pending discipline — the submit races a timeout
// and every exit restores the form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyFieldsModel, apiKeyPayload, submitApiKeyFields } from '../app/api-key-fields.mjs';

test('model: one-field rows render one password field; cloudflare renders its two named pieces', () => {
  const one = apiKeyFieldsModel({ provider: 'groq', fields: ['api_key'] });
  assert.equal(one.provider, 'groq');
  assert.deepEqual(one.fields.map((f) => f.name), ['api_key']);
  assert.equal(one.fields[0].type, 'password');
  const two = apiKeyFieldsModel({ provider: 'cloudflare', fields: ['account_id', 'api_token'] });
  assert.deepEqual(two.fields.map((f) => f.name), ['account_id', 'api_token']);
  assert.deepEqual(two.fields.map((f) => f.label), ['Account ID', 'API token']);
  assert.equal(two.fields[0].type, 'text', 'the account id is not a secret — it renders as text');
  assert.equal(two.fields[1].type, 'password');
});

test('model: nothing renders when connected, providerless, or the field shape is unknown', () => {
  assert.equal(apiKeyFieldsModel({ provider: 'groq', fields: ['api_key'], connected: true }), null);
  assert.equal(apiKeyFieldsModel({ provider: '', fields: ['api_key'] }), null);
  assert.equal(apiKeyFieldsModel({ provider: 'groq', fields: ['shoe_size'] }), null);
  assert.equal(apiKeyFieldsModel({ provider: 'groq', fields: [] }), null);
});

test('model: change mode renders the same fields for a connected provider (owner order, 2026-11-06)', () => {
  const m = apiKeyFieldsModel({ provider: 'cloudflare', fields: ['account_id', 'api_token'], connected: true, change: true });
  assert.equal(m.provider, 'cloudflare');
  assert.equal(m.change, true);
  assert.deepEqual(m.fields.map((f) => f.name), ['account_id', 'api_token']);
  assert.equal(m.button.label, 'Save');
  assert.equal(apiKeyFieldsModel({ provider: 'groq', fields: ['api_key'], change: true }).change, true, 'change mode also renders before a first connect — the host decides when to offer it');
});

test('payload: a one-field row sends its key as apiKey; a multi-field row sends the named fields, trimmed', () => {
  assert.deepEqual(apiKeyPayload('groq', { api_key: 'gsk_x' }), { provider: 'groq', apiKey: 'gsk_x' });
  assert.deepEqual(
    apiKeyPayload('cloudflare', { account_id: ' acct-1 ', api_token: ' tok-1 ' }, ['account_id', 'api_token']),
    { provider: 'cloudflare', fields: { account_id: 'acct-1', api_token: 'tok-1' } },
  );
});

test('submit: posts the payload to the credential connect path and reports the store', async () => {
  const calls = [];
  const post = async (path, body) => { calls.push({ path, body }); return { stored: true }; };
  const r = await submitApiKeyFields({ provider: 'cloudflare', values: { account_id: 'a', api_token: 't' }, fields: ['account_id', 'api_token'], post });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/admin/envoy/credential/connect');
  assert.deepEqual(calls[0].body, { provider: 'cloudflare', fields: { account_id: 'a', api_token: 't' } });
});

test('submit: a refusal surfaces its status and code; a missing post is a plain failure, never a throw', async () => {
  const refused = await submitApiKeyFields({
    provider: 'groq', values: { api_key: 'x' }, fields: ['api_key'],
    post: async () => { const e = new Error('nope'); e.status = 503; e.body = { code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }; throw e; },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.equal(refused.code, 'CREDENTIAL_SERVICE_NOT_CONFIGURED');
  const missing = await submitApiKeyFields({ provider: 'groq', values: {}, fields: ['api_key'] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'CONNECT_POST_MISSING');
});

test('submit: a post that never answers loses the race to the timeout', async () => {
  const r = await submitApiKeyFields({
    provider: 'groq', values: { api_key: 'x' }, fields: ['api_key'],
    post: () => new Promise(() => {}), timeoutMs: 5,
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});
