// PROOF THAT PROVENANCE VERIFICATION RUNS ON THE LIVE REPLY PATH.
//
// The wiring test (provenance-verification-wiring.test.mjs) proves the
// hooks run when a caller SUPPLIES claim evidence. This file proves
// the loop is now its own production caller: a turn whose tool
// consulted a web source delivers its answer with who-said-it
// citations and a verification result, a claim no consulted source
// stands behind is labelled in the delivered text, and the negative
// control — a turn that consulted nothing — delivers its reply
// byte-identical, exactly as before this wiring existed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn } from '../src/agent/loop.mjs';
import {
  cleanProvenanceWorkspace,
  makeProvenanceWorkspace,
} from '../test-support/provenance-workspace.mjs';

const PAGE_TEXT = 'Fetched https://news.example/story — The city council voted on Tuesday to approve the new transit budget worth forty million dollars for the coming year ahead.';
const REPLY_TEXT = 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars. The mayor also promised a stadium referendum before the winter holidays begin.';

async function runTurn({ withTool }) {
  const workspace = makeProvenanceWorkspace('helmion-prov-live-');
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const body = withTool && call === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'fetch_page', input: { url: 'https://news.example/story' } }] }
      : { content: [{ type: 'text', text: REPLY_TEXT }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const events = [];
  try {
    const result = await runAgentTurn({
      userText: 'What did the council decide?',
      messages: [],
      provider: { id: 'anthropic', key: 'test-key', label: 'Claude' },
      runtime: {
        permissionMode: 'read-only',
        root: workspace,
        definitionsForOpenAi: () => [{ type: 'function', function: { name: 'fetch_page', description: 'fetch a page', parameters: { type: 'object' } } }],
        execute: async () => PAGE_TEXT,
      },
      onEvent: (e) => events.push(e),
      localProvider: null,
    });
    return { result, events };
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
}

test('a turn that consulted a source delivers citations, weights and labels for what no source backs', async () => {
  const { result, events } = await runTurn({ withTool: true });
  assert.match(result.text, /Sources for this answer/);
  assert.match(result.text, /news\.example/);
  assert.match(result.text, /independent weight 1\.00/);
  assert.match(result.text, /Unverified Provenance/, 'the unsourced sentence is labelled in the delivered answer');
  const event = events.find((e) => e.type === 'provenance_verification');
  assert.ok(event, 'the verification event fired on the live path');
  assert.equal(event.sourcesConsulted, 1);
  assert.equal(event.citations.length, 1);
});

test('a fetch spelled as a command still names its source from the arguments', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-live-');
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const body = call === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'curl -s https://news.example/story' } }] }
      : { content: [{ type: 'text', text: REPLY_TEXT }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const result = await runAgentTurn({
      userText: 'What did the council decide?',
      messages: [],
      provider: { id: 'anthropic', key: 'test-key', label: 'Claude' },
      runtime: {
        permissionMode: 'read-only',
        root: workspace,
        definitionsForOpenAi: () => [{ type: 'function', function: { name: 'run_command', description: 'run a command', parameters: { type: 'object' } } }],
        execute: async () => 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars for the coming year ahead.',
      },
      onEvent: () => {},
      localProvider: null,
    });
    assert.match(result.text, /Sources for this answer/);
    assert.match(result.text, /news\.example/);
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test('a turn that consulted nothing delivers its reply byte-identical', async () => {
  const { result, events } = await runTurn({ withTool: false });
  assert.equal(result.text, REPLY_TEXT);
  assert.equal(events.some((e) => e.type === 'provenance_verification'), false);
});
