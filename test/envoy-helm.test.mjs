// Bite H4 (DESIGN 3.3): Helm's grounded composer, pure over the
// records it is handed. The desk tests from the design: fake
// records in, exact three lines out for a state ask, with the
// Weather claim following the connector read in both directions;
// a fact question quoting the filed entry verbatim, facts before
// ask records; the nothing-filed line for a record-naming
// question with no match; the availability line for a general
// question. No pool, no model — composition only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HELM_AVAILABILITY_LINE,
  HELM_NOTHING_FILED_LINE,
  composeHelmStateAnswer,
  findFiledEntry,
  helmAnswerSpec,
  helmFactAnswer,
  helmPendingGuideStep,
  helmTopicWords,
  isHelmFactShaped,
  isHelmStateAsk,
  notebookBlockers,
  oldestUnsettledAssignmentPart,
  readHelmConnectorStates,
} from '../src/cloud/envoy-helm.mjs';
import { formatNotebookBlock } from '../src/cloud/envoy-notebook.mjs';

test('helm shapes: the state ask is the design keyword shape, whole words only', () => {
  assert.equal(isHelmStateAsk('what is running here?'), true);
  assert.equal(isHelmStateAsk('what is the status of the build?'), true);
  assert.equal(isHelmStateAsk('what is blocked?'), true);
  assert.equal(isHelmStateAsk('what is next?'), true);
  assert.equal(isHelmStateAsk('show me the state of the channel'), true);
  assert.equal(isHelmStateAsk('a statement about the roadmap'), false, '"statement" is not a state ask');
  assert.equal(isHelmStateAsk('what is the capital of Norway?'), false);
  assert.equal(isHelmStateAsk(''), false);
});

test('helm shapes: the fact shape names the record itself', () => {
  assert.equal(isHelmFactShaped('what do you have filed about the deploy?'), true);
  assert.equal(isHelmFactShaped('what is recorded about the deploy?'), true);
  assert.equal(isHelmFactShaped('check the notebook for the deploy'), true);
  assert.equal(isHelmFactShaped('do you remember the deploy window?'), true);
  assert.equal(isHelmFactShaped('what is on file for the deploy?'), true);
  assert.equal(isHelmFactShaped('what is the capital of Norway?'), false);
  // The shape words are not the topic: the lookup scores the
  // filed entries on what the question is about.
  const words = helmTopicWords('what do you have filed about the approvals pop-up?');
  assert.ok(words.includes('approvals'), 'the topic word survives');
  assert.ok(!words.includes('filed'), 'the shape word is not a topic');
});

test('helm composer: the Weather claim follows the connector read, both directions (the message-2 case)', () => {
  const base = { runningNames: ['Claude', 'Gemini'], runnerPresent: true };
  assert.equal(
    composeHelmStateAnswer({ ...base, connectors: [{ name: 'Weather', state: 'connected' }] }),
    'Running: Claude and Gemini answering; Weather is connected.\nBlocked: nothing is blocked.\nNext: nothing is queued.',
  );
  assert.equal(
    composeHelmStateAnswer({ ...base, connectors: [{ name: 'Weather', state: 'not-connected' }] }),
    'Running: Claude and Gemini answering.\nBlocked: Weather is not connected.\nNext: nothing is queued.',
    'one read, one claim: never "connected" and "not connected" in the same answer',
  );
});

test('helm composer: full records compose every line from fields', () => {
  const answer = composeHelmStateAnswer({
    runningNames: ['Claude', 'Gemini'],
    runnerPresent: false,
    connectors: [
      { name: 'Weather', state: 'connected' },
      { name: 'GitHub', state: 'needs-reconnect' },
    ],
    blockers: ['Vercel invoice is overdue.', 'Second blocker', 'Third blocker', 'Fourth blocker'],
    openIncidents: [{ title: 'Checkout 500s' }, { title: 'Sync stalls' }, { title: 'Oldest incident' }],
    withheldNames: ['Codex'],
    unsettledPart: { n: 2, ownerName: 'Gemini' },
  });
  assert.equal(answer, [
    'Running: Claude and Gemini answering; no runner is connected; Weather is connected.',
    'Blocked: Vercel invoice is overdue; Second blocker; Third blocker; 1 more blockers in the notebook; open incident: Checkout 500s; open incident: Sync stalls; 1 more open incidents; Codex withheld by the claim gate; GitHub needs reconnecting.',
    'Next: part 2 of an assignment is waiting on Gemini.',
  ].join('\n'));
});

test('helm composer: empty records are the honest empty three lines', () => {
  assert.equal(
    composeHelmStateAnswer({}),
    'Running: no seat is connected.\nBlocked: nothing is blocked.\nNext: nothing is queued.',
  );
});

test('helm composer: the Next line follows decision D8 order', () => {
  const incidents = [{ title: 'Newest incident' }, { title: 'Oldest incident' }];
  assert.equal(
    composeHelmStateAnswer({ openIncidents: incidents, pendingGuideStep: { label: 'Agents' } }).split('\n')[2],
    'Next: the oldest open incident is "Oldest incident".',
    'an open incident outranks the guide chain, and the oldest is the last of the newest-first read',
  );
  assert.equal(
    composeHelmStateAnswer({ pendingGuideStep: { label: 'Turn on Maestro' } }).split('\n')[2],
    'Next: the setup guide step "Turn on Maestro" is waiting for your word.',
  );
  assert.equal(
    composeHelmStateAnswer({ pendingGuideStep: { label: null } }).split('\n')[2],
    'Next: a setup guide step is waiting for your word.',
    'a pending step whose entry carries no label is still named as pending, without inventing a label',
  );
  assert.equal(
    composeHelmStateAnswer({ unsettledPart: { n: 1, ownerName: 'Claude' }, openIncidents: incidents }).split('\n')[2],
    'Next: part 1 of an assignment is waiting on Claude.',
    'the unsettled assignment part outranks the incident',
  );
});

test('helm composer: notebook blockers parse out of the real formatted block', () => {
  const block = formatNotebookBlock({
    blockers: [
      { severity: 'high', description: 'Vercel invoice is overdue' },
      { description: 'Plain blocker' },
    ],
    entries: [{ key: 'some-key', value: 'some value' }],
  });
  assert.deepEqual(notebookBlockers(block), ['[high] Vercel invoice is overdue', 'Plain blocker']);
  assert.deepEqual(notebookBlockers(null), []);
  assert.deepEqual(notebookBlockers(formatNotebookBlock({ entries: [{ key: 'k', value: 'v' }] })), [], 'a block with no Blockers section yields none');
});

test('helm composer: the oldest unsettled assignment part reads the window rows', () => {
  const rows = [{
    id: 5, author_kind: 'human',
    metadata: { maestroAssignment: { parts: [{ n: 1, owner: 'claude' }, { n: 2, owner: 'gemini', ownerName: 'Gemini' }, { n: 3, owner: null }] } },
  }];
  assert.deepEqual(
    oldestUnsettledAssignmentPart(rows, new Set(['agent:claude|5'])),
    { n: 2, owner: 'gemini', ownerName: 'Gemini' },
    'part 1 is settled by its owner\u2019s reply; the unassigned part is never the answer',
  );
  assert.equal(oldestUnsettledAssignmentPart(rows, new Set(['agent:claude|5', 'agent:gemini|5'])), null, 'all owned parts settled: nothing waits');
  assert.equal(oldestUnsettledAssignmentPart([], new Set()), null);
});

test('helm composer: the pending guide step reads the chain through the guide\u2019s own reader', () => {
  const guideRow = {
    id: 10, author_subject: 'agent:helm', author_kind: 'agent', idempotency_key: 'helm-kb:step-one',
    metadata: { helmKb: { forSubject: 'user_author', next: 'turn-on-maestro' } },
  };
  const askRow = { id: 11, author_subject: 'user_author', author_kind: 'human', idempotency_key: 'ask-11', metadata: null };
  assert.deepEqual(
    helmPendingGuideStep([guideRow, askRow], { senderSubject: 'user_author', beforeId: 11 }),
    { label: 'Turn on Maestro' },
    'the pending step\u2019s entry label rides out',
  );
  const unlabeled = { ...guideRow, metadata: { helmKb: { forSubject: 'user_author', next: 'signup-email-code' } } };
  assert.deepEqual(
    helmPendingGuideStep([unlabeled, askRow], { senderSubject: 'user_author', beforeId: 11 }),
    { label: null },
    'an entry with no label still reports the step as pending',
  );
  assert.equal(helmPendingGuideStep([askRow], { senderSubject: 'user_author', beforeId: 11 }), null, 'no guide answer in the window: nothing pending');
});

test('helm facts: a fact question quotes the matching entry verbatim, facts before ask records', () => {
  const entries = [
    { key: 'chat:chan:msg-1', value: { ask: 'what is the approvals pop-up, asked earlier today' } },
    { key: 'fact:msg-2', value: { fact: 'The approvals pop-up is the  Allow box in the app.' } },
  ];
  const hit = findFiledEntry(entries, 'what do you have filed about the approvals pop-up?');
  assert.equal(hit.kind, 'fact');
  assert.equal(hit.text, 'The approvals pop-up is the  Allow box in the app.', 'verbatim: the stored spacing is the quote, untouched');
  assert.deepEqual(
    helmFactAnswer(entries, 'what do you have filed about the approvals pop-up?'),
    { body: 'The approvals pop-up is the  Allow box in the app.', fileMiss: false },
    'an answered question files no miss',
  );
});

test('helm facts: an ask record answers when no fact matches; a plain string entry quotes itself', () => {
  const asks = [{ key: 'chat:chan:msg-1', value: { ask: 'earlier someone asked about the staging bucket rotation' } }];
  assert.deepEqual(
    helmFactAnswer(asks, 'what is recorded about the staging bucket?'),
    { body: 'earlier someone asked about the staging bucket rotation', fileMiss: false },
  );
  const plain = [{ key: 'note:1', value: 'The staging bucket is helmian-staging' }];
  assert.deepEqual(
    helmFactAnswer(plain, 'what is recorded about the staging bucket?'),
    { body: 'The staging bucket is helmian-staging', fileMiss: false },
  );
});

test('helm facts: no match on a record-naming question is the nothing-filed line and one miss', () => {
  assert.deepEqual(
    helmFactAnswer([], 'what do you have filed about the payroll run?'),
    { body: HELM_NOTHING_FILED_LINE, fileMiss: true },
  );
  assert.equal(HELM_NOTHING_FILED_LINE, 'I have nothing filed about that');
  assert.deepEqual(
    helmFactAnswer([{ key: 'fact:x', value: { fact: 'something else entirely' } }], 'what is recorded about the payroll run?'),
    { body: HELM_NOTHING_FILED_LINE, fileMiss: true },
    'entries exist but none match: still nothing filed about THAT',
  );
});

test('helm facts: a general question gets the availability line and one miss; a failed read never claims nothing-filed', () => {
  assert.deepEqual(
    helmFactAnswer([], 'what is the capital of Norway?'),
    { body: HELM_AVAILABILITY_LINE, fileMiss: true },
  );
  assert.deepEqual(
    helmFactAnswer(null, 'what do you have filed about the payroll run?'),
    { body: HELM_AVAILABILITY_LINE, fileMiss: true },
    'entries null means the read failed: Helm must not claim the record is empty',
  );
});

test('helm answer spec: the body defaults to the availability line and the metadata shape is H3\u2019s', () => {
  const message = { id: 42, authorSubject: 'user_author' };
  const spec = helmAnswerSpec({ tenantId: 't1', channelId: 'c1', message, due: 'alone' });
  assert.equal(spec.body, HELM_AVAILABILITY_LINE);
  assert.equal(spec.key, 'helm:42');
  assert.deepEqual(spec.metadata, { helm: { due: 'alone', forSubject: 'user_author' } });
  const composed = helmAnswerSpec({ tenantId: 't1', channelId: 'c1', message, due: 'team', body: 'Running: x.' });
  assert.equal(composed.body, 'Running: x.');
});

test('helm connector read: no armed pairs is no reads and no states', async () => {
  assert.deepEqual(await readHelmConnectorStates({ pool: null, tenantId: 't1', personId: 'user_author', pairs: [] }), []);
});
