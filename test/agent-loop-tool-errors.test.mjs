// REGRESSION (context auto-save study, 2026-11-23; Troy's order:
// fix the bugs, hard tests, none skipped): the production agent loop
// used to die when a tool threw. The assistant message carrying the
// calls was already in the history and no result ever landed, so the
// dangling tool_calls poisoned every later turn of the session — the
// providers reject a history whose calls have no results. These
// tests pin the fix on the real loop: a tool error returns as the
// call's tool-result string and the turn completes; a history left
// dangling by a dead turn is repaired before the next model call;
// and the session stays usable afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';

import { UNANSWERED_TOOL_MESSAGE, repairDanglingToolCalls, runAgentTurn } from '../src/agent/loop.mjs';
import {
  cleanProvenanceWorkspace,
  makeProvenanceWorkspace,
} from '../test-support/provenance-workspace.mjs';

const TEST_KEY = 'zzz-test-provider-key-zzz';
const REPLY_TEXT = 'The retrieval failed, so here is what I can say without it: the meeting is on Tuesday.';

function stubFetch(script, bodies) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (bodies) bodies.push(String(options?.body ?? ''));
    const body = script[Math.min(call - 1, script.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

const TOOL_TURN = { content: [{ type: 'tool_use', id: 't1', name: 'fetch_page', input: { url: 'https://news.example/story' } }] };
const TEXT_TURN = { content: [{ type: 'text', text: REPLY_TEXT }] };

function fakeRuntime(workspace, execute) {
  return {
    permissionMode: 'read-only',
    root: workspace,
    definitionsForOpenAi: () => [{ type: 'function', function: { name: 'fetch_page', description: 'fetch a page', parameters: { type: 'object' } } }],
    execute,
  };
}

test('a tool that throws mid-task returns as a tool result and the session still completes', async () => {
  const workspace = makeProvenanceWorkspace('helmion-loop-toolthrow-');
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = stubFetch([TOOL_TURN, TEXT_TURN, TEXT_TURN], bodies);
  const events = [];
  const messages = [];
  try {
    const result = await runAgentTurn({
      userText: 'Fetch the story and tell me what it says.',
      messages,
      provider: { id: 'anthropic', key: TEST_KEY, label: 'Claude' },
      runtime: fakeRuntime(workspace, async () => { throw new Error('retrieval backend exploded'); }),
      onEvent: (e) => events.push(e),
      localProvider: null,
    });
    assert.match(result.text, /the meeting is on Tuesday/);

    // The history is well-formed: the assistant's call is answered by
    // a tool result carrying the failure, in the Error: register.
    const assistantIdx = messages.findIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(assistantIdx >= 0, 'the assistant tool-call message is in the history');
    const toolRow = messages[assistantIdx + 1];
    assert.equal(toolRow?.role, 'tool');
    assert.equal(toolRow?.tool_call_id, 't1');
    assert.match(toolRow?.content ?? '', /Error: the fetch_page tool failed/);
    assert.match(toolRow?.content ?? '', /retrieval backend exploded/);

    // The next provider call carried that result — the model saw the
    // failure and recovered from it, instead of the request dying.
    assert.match(bodies[1] ?? '', /retrieval backend exploded/);
    assert.ok(events.some((e) => e.type === 'tool_error' && e.name === 'fetch_page'), 'the failure was announced as a tool_error event');

    // And the session is NOT poisoned: a follow-up turn on the same
    // history completes normally.
    const followUp = await runAgentTurn({
      userText: 'Thanks. Anything else?',
      messages,
      provider: { id: 'anthropic', key: TEST_KEY, label: 'Claude' },
      runtime: fakeRuntime(workspace, async () => 'unused'),
      onEvent: () => {},
      localProvider: null,
    });
    assert.match(followUp.text, /the meeting is on Tuesday/);
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test('repairDanglingToolCalls answers only the unanswered calls, in place', () => {
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'fetch_page', arguments: '{}' } },
        { id: 'a2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a1', name: 'fetch_page', content: 'the page text' },
    { role: 'user', content: 'next' },
  ];
  const repaired = repairDanglingToolCalls(messages);
  assert.equal(repaired, 1);
  assert.equal(messages.length, 5);
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'a2');
  assert.equal(messages[3].name, 'read_file');
  assert.equal(messages[3].content, UNANSWERED_TOOL_MESSAGE);
  // A well-formed history is left byte-identical.
  assert.equal(repairDanglingToolCalls(messages), 0);
});

test('a history left dangling by a dead turn is repaired before the next model call', async () => {
  const workspace = makeProvenanceWorkspace('helmion-loop-repair-');
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = stubFetch([TEXT_TURN], bodies);
  // The poisoned shape the old loop left behind: an assistant message
  // whose tool call never got a result.
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'Fetch the story.' },
    {
      role: 'assistant', content: null,
      tool_calls: [{ id: 't9', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://news.example/story"}' } }],
    },
  ];
  const events = [];
  try {
    const result = await runAgentTurn({
      userText: 'Continue.',
      messages,
      provider: { id: 'anthropic', key: TEST_KEY, label: 'Claude' },
      runtime: fakeRuntime(workspace, async () => 'unused'),
      onEvent: (e) => events.push(e),
      localProvider: null,
    });
    assert.match(result.text, /the meeting is on Tuesday/);
    // The repair landed in the history itself, before the new turn's
    // own messages: t9 now has its (unanswered) result row.
    const toolRow = messages.find((m) => m.role === 'tool' && m.tool_call_id === 't9');
    assert.ok(toolRow, 'the dangling call was answered in the history');
    assert.equal(toolRow.content, UNANSWERED_TOOL_MESSAGE);
    // And the provider call that went out carried the repaired
    // history — the request was well-formed when it left.
    assert.match(bodies[0] ?? '', /never completed/);
    assert.ok(events.some((e) => e.type === 'history_repaired' && e.count === 1), 'the repair was announced');
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});
