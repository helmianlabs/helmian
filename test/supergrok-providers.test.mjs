// SuperGrok provider-wiring tests: how chatWithTools treats an xAI
// subscription (oauth) credential versus a plain API key. Covers resolver
// precedence for xai, the X-XAI-Token-Auth client marker (sent for oauth,
// never for api keys, never for other providers), the env-marker path
// (credentialType passed straight in), and the one-shot 401 refresh+retry.
// fetch is stubbed throughout; provenance goes to a temp workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWithTools } from '../src/agent/providers.mjs';
import { cleanProvenanceWorkspace, makeProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

const XAI_REPLY = { choices: [{ message: { content: 'ok', tool_calls: [] } }] };

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const bearer = (token) => `Bearer ${token}`;
const ok200 = () => ({ ok: true, status: 200, async text() { return JSON.stringify(XAI_REPLY); } });
const err401 = () => ({ ok: false, status: 401, async text() { return 'unauthorized'; } });

async function turn(args) {
  const workspace = makeProvenanceWorkspace('helmion-supergrok-provider-');
  try {
    return await chatWithTools({
      model: 'grok-4.3',
      messages: [{ role: 'user', content: 'hello' }],
      toolDefs: [],
      provenance: { workspace },
      ...args,
    });
  } finally {
    cleanProvenanceWorkspace(workspace);
  }
}

test('a resolver oauth credential beats the env key and carries the client marker', async () => {
  const { calls, restore } = stubFetch(ok200);
  try {
    const reply = await turn({
      providerId: 'xai',
      apiKey: 'env-api-key',
      credentialResolver: async () => ({ credential: 'oauth-access', tokenType: 'oauth' }),
    });
    assert.equal(reply.content, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, bearer('oauth-access'));
    assert.equal(calls[0].init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  } finally { restore(); }
});

test('a null resolver answer leaves the env key in charge, with no marker', async () => {
  const { calls, restore } = stubFetch(ok200);
  try {
    await turn({
      providerId: 'xai',
      apiKey: 'env-api-key',
      credentialResolver: async () => null,
    });
    assert.equal(calls[0].init.headers.Authorization, bearer('env-api-key'));
    assert.equal(calls[0].init.headers['X-XAI-Token-Auth'], undefined);
  } finally { restore(); }
});

test('the marker also follows a directly-passed oauth credential type (bridge env path)', async () => {
  const { calls, restore } = stubFetch(ok200);
  try {
    await turn({ providerId: 'xai', apiKey: 'injected-access-token', credentialType: 'oauth' });
    assert.equal(calls[0].init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  } finally { restore(); }
});

test('a plain xai api key never carries the marker', async () => {
  const { calls, restore } = stubFetch(ok200);
  try {
    await turn({ providerId: 'xai', apiKey: 'plain-key' });
    assert.equal(calls[0].init.headers['X-XAI-Token-Auth'], undefined);
  } finally { restore(); }
});

test('a 401 on an oauth credential refreshes once and retries with the fresh token', async () => {
  const { calls, restore } = stubFetch((n) => (n === 1 ? err401() : ok200()));
  try {
    let refreshes = 0;
    const resolver = async () => ({ credential: 'stale-access', tokenType: 'oauth' });
    resolver.refreshCredential = async () => {
      refreshes += 1;
      return { credential: 'fresh-access', tokenType: 'oauth' };
    };
    const reply = await turn({ providerId: 'xai', credentialResolver: resolver });
    assert.equal(reply.content, 'ok');
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers.Authorization, bearer('stale-access'));
    assert.equal(calls[1].init.headers.Authorization, bearer('fresh-access'));
    assert.equal(calls[1].init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  } finally { restore(); }
});

test('a 401 where refresh yields the same token does not retry', async () => {
  const { calls, restore } = stubFetch(() => err401());
  try {
    const resolver = async () => ({ credential: 'same-access', tokenType: 'oauth' });
    resolver.refreshCredential = async () => ({ credential: 'same-access', tokenType: 'oauth' });
    await assert.rejects(
      () => turn({ providerId: 'xai', credentialResolver: resolver }),
      /HTTP 401/,
    );
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('a 401 on a plain api key never touches the refresh hook', async () => {
  const { calls, restore } = stubFetch(() => err401());
  try {
    let refreshes = 0;
    const resolver = async () => null;
    resolver.refreshCredential = async () => { refreshes += 1; return null; };
    await assert.rejects(
      () => turn({ providerId: 'xai', apiKey: 'plain-key', credentialResolver: resolver }),
      /HTTP 401/,
    );
    assert.equal(calls.length, 1);
    assert.equal(refreshes, 0);
  } finally { restore(); }
});

test('other providers keep keyless-only resolver semantics: a key in hand is used as-is', async () => {
  const { calls, restore } = stubFetch(ok200);
  try {
    let consulted = 0;
    const reply = await turn({
      providerId: 'openai',
      apiKey: 'openai-key',
      model: 'gpt-test',
      credentialResolver: async () => { consulted += 1; return { credential: 'other', tokenType: 'oauth' }; },
    });
    assert.equal(reply.content, 'ok');
    assert.equal(consulted, 0);
    assert.equal(calls[0].init.headers.Authorization, bearer('openai-key'));
    assert.equal(calls[0].init.headers['X-XAI-Token-Auth'], undefined);
  } finally { restore(); }
});
