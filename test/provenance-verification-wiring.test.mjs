// PROOF THAT THE PRE-RESPONSE HOOKS RUN ON THE REAL REPLY PATH.
//
// The unit suite proves the schemas and the hook runner. This file proves
// the agent loop calls them: a real runAgentTurn over a stubbed provider,
// with structured claim evidence supplied the way a caller supplies it, and
// assertions on the text the turn actually delivers — plus the negative
// control that a turn WITHOUT the option delivers its reply byte-identical,
// so the wiring cannot be credited for behaviour that was already there.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn } from '../src/agent/loop.mjs';
import {
  createProvenanceRecord,
  createContestationVector,
} from '../src/core/provenance-verification.mjs';
import {
  cleanProvenanceWorkspace,
  makeProvenanceWorkspace,
} from '../test-support/provenance-workspace.mjs';

const ANTHROPIC_REPLY = { content: [{ type: 'text', text: 'The effect is 40 percent.' }] };

async function runTurn({ provenanceVerification = null } = {}) {
  const workspace = makeProvenanceWorkspace('helmion-prov-verif-wire-');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(ANTHROPIC_REPLY),
  });
  const events = [];
  try {
    const result = await runAgentTurn({
      userText: 'What did the study find?',
      messages: [],
      provider: { id: 'anthropic', key: 'test-key', label: 'Claude' },
      runtime: { permissionMode: 'read-only', definitionsForOpenAi: () => [], root: workspace },
      onEvent: (e) => events.push(e),
      localProvider: null,
      ...(provenanceVerification ? { provenanceVerification } : {}),
    });
    return { result, events };
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
}

const HASH = 'b'.repeat(64);
const settled = () => createContestationVector({
  provenanceScore: 0.9, independenceScore: 0.9, consensusRatio: 0.95, dissentRigor: 0.2,
});

test('a turn carrying an unverified claim delivers the reply WITH its annotation, and reports the event', async () => {
  const { result, events } = await runTurn({
    provenanceVerification: {
      claims: [{
        claimId: 'study-1',
        provenanceRecord: createProvenanceRecord({
          recordId: 's1', sourceUrl: 'https://blog.example/post',
          signatureStatus: 'absent', attributionStatus: 'unknown',
        }),
        contestationVector: settled(),
      }],
    },
  });
  assert.match(result.text, /The effect is 40 percent\./);
  assert.match(result.text, /Unverified Provenance/);
  const event = events.find((e) => e.type === 'provenance_verification');
  assert.ok(event, 'no provenance_verification event was emitted');
  assert.equal(event.action, 'annotate');
  assert.equal(event.evaluations.length, 1);
  // History carries the delivered (annotated) text, not the raw reply.
  assert.equal(result.messages.at(-1).content, result.text);
});

test('a turn carrying a failed-signature claim delivers the block notice, never the claim', async () => {
  const { result, events } = await runTurn({
    provenanceVerification: {
      claims: [{
        claimId: 'study-2',
        provenanceRecord: createProvenanceRecord({
          recordId: 's2', sourceUrl: 'https://example.org/paper', sourceHash: HASH,
          signatureStatus: 'failed', attributionStatus: 'verified',
        }),
        contestationVector: settled(),
      }],
    },
  });
  assert.equal(result.text.includes('40 percent'), false);
  assert.match(result.text, /blocked by the Executive Guard/);
  assert.equal(events.find((e) => e.type === 'provenance_verification').action, 'block');
});

test('NEGATIVE CONTROL: a turn WITHOUT the option delivers its reply byte-identical and emits no verification event', async () => {
  const { result, events } = await runTurn();
  assert.equal(result.text, 'The effect is 40 percent.');
  assert.equal(events.some((e) => e.type === 'provenance_verification'), false);
});
