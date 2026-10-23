import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AGENT_WORK_WINDOW_MS, CALM_POLL_MS, FAST_POLL_MS, pendingAgentWork } from '../app/envoy-workspace.js';

// pendingAgentWork mirrors the server's agentWork() rules
// (src/cloud/envoy-mesh.mjs): a routed message is pending for a provider
// until its reply:<id> lands, it ages out of the 30-minute work window,
// or it predates the provider joining the channel. Only online providers
// are reported — an offline agent is not "answering".

const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const human = (id, body, msAgo = 60_000) => ({ id, authorKind: 'human', authorSubject: 'user:troy', body, createdAt: iso(msAgo) });
const reply = (id, toId, provider, msAgo = 30_000) => ({ id, authorKind: 'agent', authorSubject: `agent:${provider}`, body: 'On it.', createdAt: iso(msAgo), idempotencyKey: `reply:${toId}` });
const ROSTER = ['maestro', 'gemini'];
const JOINED = { maestro: iso(3_600_000), gemini: iso(3_600_000) };
const ONLINE = new Set(['maestro', 'gemini']);

test('an unmentioned human message is pending for Maestro only', () => {
  const msgs = [human('m1', 'hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
});

test('a mention routes the pending work to the named agent', () => {
  const msgs = [human('m1', '@Gemini yo')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
});

test('@all makes the work pending for the whole roster, in roster order', () => {
  const msgs = [human('m1', '@all hands on deck')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro', 'gemini']);
});

test('the work clears when the reply posts', () => {
  const msgs = [human('m1', 'hello'), reply('m2', 'm1', 'maestro')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), []);
});

test('a second unanswered ask keeps the agent pending after the first is answered', () => {
  const msgs = [human('m1', 'one', 120_000), reply('m2', 'm1', 'maestro', 90_000), human('m3', 'two', 60_000)];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
});

test('work expires at the server work window, not before', () => {
  const justInside = [human('m1', 'hello', AGENT_WORK_WINDOW_MS - 1_000)];
  assert.deepEqual(pendingAgentWork(justInside, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
  const justOutside = [human('m1', 'hello', AGENT_WORK_WINDOW_MS + 1_000)];
  assert.deepEqual(pendingAgentWork(justOutside, ROSTER, JOINED, ONLINE, NOW), []);
});

test('messages from before an agent joined are not its work', () => {
  const msgs = [human('m1', '@Gemini hello', 120_000)];
  const joined = { maestro: iso(3_600_000), gemini: iso(60_000) };
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, joined, ONLINE, NOW), []);
});

test('offline agents are never reported as answering', () => {
  const msgs = [human('m1', 'hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, new Set(), NOW), []);
  assert.deepEqual(pendingAgentWork([human('m2', '@Gemini yo')], ROSTER, JOINED, new Set(['maestro']), NOW), []);
});

test('Maestro dispatch makes named agents pending, one hop only', () => {
  const dispatch = { id: 'm1', authorKind: 'agent', authorSubject: 'agent:maestro', body: '@Gemini: take the summary slice', createdAt: iso(60_000) };
  assert.deepEqual(pendingAgentWork([dispatch], ROSTER, JOINED, ONLINE, NOW), ['gemini']);
  const workerNote = { id: 'm2', authorKind: 'agent', authorSubject: 'agent:gemini', body: '@Maestro done', createdAt: iso(60_000) };
  assert.deepEqual(pendingAgentWork([workerNote], ROSTER, JOINED, ONLINE, NOW), []);
});

test('no roster, no work', () => {
  assert.deepEqual(pendingAgentWork([human('m1', 'hello')], [], {}, ONLINE, NOW), []);
});

test('poll cadence: fast while work is pending, calm otherwise', () => {
  assert.equal(FAST_POLL_MS, 800);
  assert.equal(CALM_POLL_MS, 2500);
  assert.equal(AGENT_WORK_WINDOW_MS, 30 * 60_000);
});

// Layout bite 1 (Troy's ruling, 2026-10-23): the agent CLI is its own
// center pane between the human chat and the agents roster; the channels
// pane creates plain channels (no agent select), and "+ New session"
// lives in the CLI pane.
test('desktop layout: agent CLI pane sits between chat and agents; channels are plain', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const chat = html.indexOf('id="ew-chat"');
  const cli = html.indexOf('id="ew-cli"');
  const agents = html.indexOf('id="ew-agents"');
  assert.ok(chat !== -1 && cli !== -1 && agents !== -1, 'chat, CLI and agents panes all exist');
  assert.ok(chat < cli && cli < agents, 'CLI pane is between the chat and the agents roster');
  assert.match(html, /data-pane="cli"/);
  assert.match(html, /data-toggle="cli"/);
  assert.match(html, /data-split="cli"/);
  for (const id of ['ew-cli-chips', 'ew-cli-new', 'ew-cli-session-form', 'ew-cli-session-name', 'ew-cli-sessions', 'ew-cli-form', 'ew-cli-input', 'ew-cli-dictate', 'ew-cli-voice', 'ew-cli-send']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="ew-cli-new"[^>]*>\+ New session</);
  assert.match(html, /id="ew-add-channel"[^>]*>\+ New channel</);
  assert.doesNotMatch(html, /ew-new-channel-agent/);
});
