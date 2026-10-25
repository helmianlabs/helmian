import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTurnAttachments } from '../src/agent/attachments.mjs';
import { chatWithTools, providerHasNativeWebSearch, ANTHROPIC_WEB_SEARCH_TOOL } from '../src/agent/providers.mjs';
import { runAgentTurn } from '../src/agent/loop.mjs';
import { createToolRuntime } from '../src/agent/tools.mjs';
import { sharedProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// Bite 8: the composer's web-search toggle must be TRUE or honest.
//
// Before: the flag rode message metadata into the turn and became ONE
// context line — "requested, but Helmian has no web-search tool today" —
// on every seat alike, and nothing ever reached a provider request.
//
// Now: on the Claude seat the toggle enables Anthropic's OWN native
// web_search server tool for that turn (declared on the wire, executed by
// Anthropic inside the call — no third-party search API, no extra key).
// On every other seat the honest line stays, and the wire proves nothing
// was silently declared there either.

const LEDGER = sharedProvenanceWorkspace('helmion-websearch-');

const FUNCTION_TOOL = {
  type: 'function',
  function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
};

function captureFetch(sink, responseBody) {
  return async (url, init) => {
    sink.url = url;
    sink.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
    };
  };
}

async function withStubbedFetch(responseBody, fn) {
  const original = globalThis.fetch;
  const sink = {};
  globalThis.fetch = captureFetch(sink, responseBody);
  try {
    await fn(sink);
  } finally {
    globalThis.fetch = original;
  }
}

const ANTHROPIC_TEXT_REPLY = {
  content: [{ type: 'text', text: 'plain answer' }],
  stop_reason: 'end_turn',
};

const ANTHROPIC_SEARCHED_REPLY = {
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'helmian release date' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', title: 'A result', url: 'https://example.com/a', encrypted_content: 'x' }],
    },
    { type: 'text', text: 'the searched answer' },
  ],
  stop_reason: 'end_turn',
};

// ---- capability map -------------------------------------------------------

test('capability: only the anthropic (Claude) seat has native web search', () => {
  assert.equal(providerHasNativeWebSearch('anthropic'), true);
  for (const id of ['openai', 'gemini', 'xai', 'custom', 'maestro', null, undefined]) {
    assert.equal(providerHasNativeWebSearch(id), false, `${id} must not claim native search`);
  }
  assert.equal(ANTHROPIC_WEB_SEARCH_TOOL.type, 'web_search_20250305');
  assert.equal(ANTHROPIC_WEB_SEARCH_TOOL.name, 'web_search');
});

// ---- attachment resolution: flag → native enable or honest line -----------

test('toggle ON + Claude seat: native search enabled, line says it is really on', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { webSearch: true },
    plugins: [],
    providerId: 'anthropic',
  });
  assert.equal(resolved.webSearch, true);
  assert.match(resolved.contextText, /Web search: ON for this turn/);
  assert.match(resolved.contextText, /native web-search tool/);
  assert.doesNotMatch(resolved.contextText, /cannot search the web/);
  await resolved.dispose();
});

test('toggle ON + any other seat: honest line, nothing enabled', async () => {
  for (const providerId of ['openai', 'gemini', 'xai', 'custom', null]) {
    const resolved = await resolveTurnAttachments({
      metadata: { webSearch: true },
      plugins: [],
      providerId,
    });
    assert.equal(resolved.webSearch, false, `${providerId}: toggle must not enable anything`);
    assert.match(resolved.contextText, /no web-search tool today/);
    assert.match(resolved.contextText, /cannot search the web in this turn/);
    assert.match(resolved.contextText, /Say so plainly/);
    await resolved.dispose();
  }
});

test('toggle OFF: stated as an instruction on every seat, Claude included', async () => {
  for (const providerId of ['anthropic', 'openai']) {
    const resolved = await resolveTurnAttachments({
      metadata: { webSearch: false },
      plugins: [],
      providerId,
    });
    assert.equal(resolved.webSearch, false);
    assert.match(resolved.contextText, /Web search: OFF for this turn/);
    await resolved.dispose();
  }
});

test('toggle absent: no line, nothing enabled', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'skill', name: 'deploy' }] },
    plugins: [],
    providerId: 'anthropic',
  });
  assert.equal(resolved.webSearch, false);
  assert.doesNotMatch(resolved.contextText ?? '', /Web search:/);
  await resolved.dispose();

  const none = await resolveTurnAttachments({ metadata: null, plugins: [], providerId: 'anthropic' });
  assert.equal(none.webSearch, false);
  assert.equal(none.contextText, null);
  await none.dispose();
});

// ---- wire format: what actually reaches the provider ----------------------

test('wire: Claude turn with toggle ON declares native search beside the function tools', async () => {
  await withStubbedFetch(ANTHROPIC_TEXT_REPLY, async (sink) => {
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [FUNCTION_TOOL],
      webSearch: true,
      provenance: { workspace: LEDGER },
    });
    assert.match(sink.url, /api\.anthropic\.com/);
    const search = sink.body.tools.find((t) => t.type === 'web_search_20250305');
    assert.ok(search, 'the native search declaration is on the wire');
    assert.equal(search.name, 'web_search');
    assert.ok(sink.body.tools.some((t) => t.name === 'read_file'), 'function tools ride along');
  });
});

test('wire: Claude turn with toggle ON and NO function tools still declares search, alone', async () => {
  await withStubbedFetch(ANTHROPIC_TEXT_REPLY, async (sink) => {
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [],
      webSearch: true,
      provenance: { workspace: LEDGER },
    });
    assert.equal(sink.body.tools.length, 1);
    assert.equal(sink.body.tools[0].type, 'web_search_20250305');
  });
});

test('wire: Claude turn with toggle OFF (the default) sends no search declaration', async () => {
  await withStubbedFetch(ANTHROPIC_TEXT_REPLY, async (sink) => {
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [FUNCTION_TOOL],
      provenance: { workspace: LEDGER },
    });
    assert.ok(sink.body.tools.every((t) => t.type !== 'web_search_20250305'));
    assert.deepEqual(sink.body.tools.map((t) => t.name), ['read_file']);
  });
  // And with no tools at all, no tools array appears — byte-for-byte the old shape.
  await withStubbedFetch(ANTHROPIC_TEXT_REPLY, async (sink) => {
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [],
      webSearch: false,
      provenance: { workspace: LEDGER },
    });
    assert.equal('tools' in sink.body, false);
  });
});

test('wire: the toggle changes nothing on the OpenAI seat', async () => {
  await withStubbedFetch({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }, async (sink) => {
    await chatWithTools({
      providerId: 'openai',
      apiKey: 'test-key',
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [FUNCTION_TOOL],
      webSearch: true,
      provenance: { workspace: LEDGER },
    });
    assert.match(sink.url, /api\.openai\.com/);
    assert.ok(sink.body.tools.every((t) => t.type === 'function'), 'no search declaration leaks onto other seats');
  });
});

test('reply: server search blocks are not client tool calls; the text is the answer', async () => {
  await withStubbedFetch(ANTHROPIC_SEARCHED_REPLY, async () => {
    const reply = await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'search for this' }],
      toolDefs: [FUNCTION_TOOL],
      webSearch: true,
      provenance: { workspace: LEDGER },
    });
    assert.equal(reply.content, 'the searched answer');
    assert.deepEqual(reply.toolCalls, [], 'web_search must never reach the client tool runtime');
  });
});

// ---- loop threading: the flag survives bridge → loop → wire ---------------

test('loop: runAgentTurn carries the toggle to the Claude wire, on and off', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'helmion-websearch-loop-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const provider = { id: 'anthropic', key: 'test-key', label: 'Claude' };

  // ON: the request that leaves carries the native declaration, and the
  // searched reply comes back as the turn's answer.
  const original = globalThis.fetch;
  const sinkOn = {};
  globalThis.fetch = captureFetch(sinkOn, ANTHROPIC_SEARCHED_REPLY);
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'read-only' });
    const out = await runAgentTurn({
      userText: 'what does the web say?',
      messages: [{ role: 'system', content: 'test seat' }],
      provider,
      runtime,
      webSearch: true,
      onEvent: () => {},
    });
    assert.equal(out.text, 'the searched answer');
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(
    (sinkOn.body.tools ?? []).some((tool) => tool.type === 'web_search_20250305'),
    'toggle ON: the loop put the native search declaration on the wire',
  );

  const sinkOff = {};
  globalThis.fetch = captureFetch(sinkOff, ANTHROPIC_TEXT_REPLY);
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'read-only' });
    await runAgentTurn({
      userText: 'answer from knowledge',
      messages: [{ role: 'system', content: 'test seat' }],
      provider,
      runtime,
      webSearch: false,
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(
    !(sinkOff.body.tools ?? []).some((tool) => tool.type === 'web_search_20250305'),
    'toggle OFF: no search declaration on the wire',
  );
});
