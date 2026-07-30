import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWithTools } from '../src/agent/providers.mjs';
import { sharedProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// Every call below produces a completion, and every completion is recorded
// (src/agent/providers.mjs). Without a workspace of its own, this file's rows
// land in the repo's real ledger and `helmion provenance` then reports that
// OpenAI answered Troy at the moment a unit test ran.
const LEDGER = sharedProvenanceWorkspace('helmion-openai-tool-');

/**
 * OpenAI's chat.completions endpoint rejects function tools when the gpt-5.6
 * family's default reasoning effort is in play. Its own 400 names the fix:
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-terra
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 * Every tool-bearing OpenAI turn failed until reasoning_effort was pinned.
 * These tests read the body that actually goes on the wire.
 */

const TOOL_DEFS = [{
  type: 'function',
  function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
}];

const OK_RESPONSE = {
  choices: [{ message: { content: 'ok', tool_calls: [] } }],
};

function captureFetch(sink) {
  return async (url, init) => {
    sink.url = url;
    sink.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(OK_RESPONSE),
    };
  };
}

async function withStubbedFetch(fn) {
  const original = globalThis.fetch;
  const sink = {};
  globalThis.fetch = captureFetch(sink);
  try {
    await fn(sink);
  } finally {
    globalThis.fetch = original;
  }
}

test('openai tool turns pin reasoning_effort to none', async () => {
  await withStubbedFetch(async (sink) => {
    await chatWithTools({
      providerId: 'openai',
      apiKey: 'test-key',
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: TOOL_DEFS,
      provenance: { workspace: LEDGER },
    });
    assert.equal(sink.body.reasoning_effort, 'none');
    assert.equal(sink.body.tool_choice, 'auto');
  });
});

test('openai turns WITHOUT tools do not send reasoning_effort', async () => {
  await withStubbedFetch(async (sink) => {
    await chatWithTools({
      providerId: 'openai',
      apiKey: 'test-key',
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [],
      provenance: { workspace: LEDGER },
    });
    assert.equal('reasoning_effort' in sink.body, false);
    assert.equal('tools' in sink.body, false);
  });
});

test('xai tool turns never send reasoning_effort', async () => {
  // xAI rejects the unknown field; the fix must not leak to other providers.
  await withStubbedFetch(async (sink) => {
    await chatWithTools({
      providerId: 'xai',
      apiKey: 'test-key',
      model: 'grok-4.3',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: TOOL_DEFS,
      provenance: { workspace: LEDGER },
    });
    assert.equal('reasoning_effort' in sink.body, false);
    assert.equal(sink.body.tools.length, 1);
  });
});

test('custom OpenAI-compatible endpoints never send reasoning_effort', async () => {
  // Ollama / vLLM / LM Studio reject unknown fields.
  await withStubbedFetch(async (sink) => {
    await chatWithTools({
      providerId: 'custom',
      apiKey: 'test-key',
      url: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'llama-local',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: TOOL_DEFS,
      provenance: { workspace: LEDGER },
    });
    assert.equal('reasoning_effort' in sink.body, false);
    assert.equal(sink.url, 'http://127.0.0.1:11434/v1/chat/completions');
  });
});
