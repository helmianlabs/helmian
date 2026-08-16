import assert from 'node:assert/strict';
import test from 'node:test';
import { chatWithTools } from '../src/agent/providers.mjs';
import { createProviderCredentialResolver } from '../src/cloud/provider-credential-resolver.mjs';
import { readCompletions } from '../src/core/provenance-log.mjs';
import { cleanProvenanceWorkspace, makeProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

const REPLIES = {
  openai: { choices: [{ message: { content: 'ok', tool_calls: [] } }] },
  anthropic: { content: [{ type: 'text', text: 'ok' }] },
  gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
  xai: { choices: [{ message: { content: 'ok', tool_calls: [] } }] },
};

test('tenant vault credentials reach all four adapters without entering the reply or provenance', async () => {
  const workspace = makeProvenanceWorkspace('helmion-vault-provider-');
  const seen = [];
  const original = globalThis.fetch;
  const resolver = createProviderCredentialResolver({
    vaultAdapter: {
      async resolveCredential(input) {
        assert.equal(input.tenantId, 'tenant-a');
        assert.equal(input.actorSubject, 'owner-a');
        return { accepted: true, credential: `secret-${input.providerId}`, tokenType: 'api_key', secretMaterial: 'adapter_only' };
      },
    },
    tenantContext: { tenantId: 'tenant-a', subject: 'owner-a', role: 'owner', sessionId: 'session-a', requestId: 'request-a' },
  });
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    const provider = url.includes('anthropic') ? 'anthropic' : url.includes('googleapis') ? 'gemini' : url.includes('x.ai') ? 'xai' : 'openai';
    return { ok: true, status: 200, async text() { return JSON.stringify(REPLIES[provider]); } };
  };
  try {
    for (const providerId of ['openai', 'anthropic', 'gemini', 'xai']) {
      const reply = await chatWithTools({ providerId, credentialResolver: resolver, credentialReference: `vault://tenant/tenant-a/${providerId}`, model: 'test-model', messages: [{ role: 'user', content: 'hello' }], toolDefs: [], provenance: { workspace } });
      assert.equal(reply.content, 'ok');
      assert.equal(JSON.stringify(reply).includes('secret-'), false);
    }
    assert.equal(seen.length, 4);
    assert.equal(seen[0].init.headers.Authorization, 'Bearer secret-openai_codex');
    assert.equal(seen[1].init.headers['x-api-key'], 'secret-claude');
    assert.match(seen[2].url, /[?&]key=secret-gemini/u);
    assert.equal(seen[3].init.headers.Authorization, 'Bearer secret-grok');
    const ledger = readCompletions(workspace);
    assert.equal(ledger.entries.length, 4);
    assert.equal(JSON.stringify(ledger.entries).includes('secret-'), false);
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test('a bearer vault credential uses Gemini authorization headers without a key query', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return { ok: true, status: 200, async text() { return JSON.stringify(REPLIES.gemini); } };
  };
  try {
    await chatWithTools({ providerId: 'gemini', credentialResolver: async () => ({ credential: 'oauth-access', tokenType: 'Bearer' }), credentialReference: 'vault://tenant/tenant-a/gemini', model: 'gemini-test', messages: [{ role: 'user', content: 'hello' }], toolDefs: [] });
    assert.equal(request.url.includes('?key='), false);
    assert.equal(request.init.headers.Authorization, 'Bearer oauth-access');
  } finally {
    globalThis.fetch = original;
  }
});

test('vault resolution fails closed before fetch when the resolver is unavailable', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('provider must not be called'); };
  try {
    await assert.rejects(() => chatWithTools({ providerId: 'gemini', credentialReference: 'vault://tenant/tenant-a/gemini', messages: [], toolDefs: [] }), /No API key configured/u);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
