// Voice-on catch-up (catch-up bite) — the room speaks the newest
// seat reply that landed BEFORE voice chat was switched on. The
// scanner (speakNewMessages in envoy-workspace.js) only speaks
// messages that arrive while voice chat is on; replies already in
// the room at switch-on were seen and declined, and Troy's real
// move — ask everybody, then turn voice on — got silence. The
// catch-up decision (catchUpPick) and its already-voiced rule
// (runCatchUp) are pure exports of envoy-workspace.js; these tests
// drive them with message fixtures in the shapes the room renders,
// plus source pins for the wiring (the scanner's voiced recording,
// the app.js toggle trigger, the controller's toggle-off cancel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catchUpPick, runCatchUp } from '../web/marketing/app/envoy-workspace.js';

const ME = 'user:troy';
const ownAsk = { id: 'm1', authorKind: 'human', authorSubject: ME, body: '@all how is the river?' };
const replyA = { id: 'm2', authorKind: 'agent', authorSubject: 'agent:claude', agentProvider: 'claude', body: 'The river is high today.' };
const replyB = { id: 'm3', authorKind: 'agent', authorSubject: 'agent:grok', agentProvider: 'grok', body: 'And rising, Troy.' };

function recorder(returnValue = true) {
  const calls = [];
  return { calls, speak: (body, provider, id) => { calls.push({ body, provider, id }); return returnValue; } };
}

test('catch-up fires once, with the newest seat reply', () => {
  const voiced = new Set();
  const { calls, speak } = recorder();
  const pick = runCatchUp({ messages: [ownAsk, replyA, replyB], voiced, me: ME, speak });
  assert.equal(pick?.id, 'm3', 'the newest seat reply is the catch-up');
  assert.deepEqual(calls, [{ body: replyB.body, provider: 'grok', id: 'm3' }], 'spoken once, through the speak path, with its seat key and message ref');
  assert.ok(voiced.has('m3'), 'the spoken catch-up is marked voiced');
  const again = runCatchUp({ messages: [ownAsk, replyA, replyB], voiced, me: ME, speak });
  assert.equal(again, null, 'a second catch-up in the same voice-on fires nothing');
  assert.equal(calls.length, 1, 'still exactly one speak');
});

test('catch-up never replays a backlog: one message, the newest, however many replies wait', () => {
  const voiced = new Set();
  const { calls, speak } = recorder();
  const older = { id: 'm0', authorKind: 'agent', authorSubject: 'agent:gemini', agentProvider: 'gemini', body: 'Oldest reply.' };
  runCatchUp({ messages: [older, replyA, replyB], voiced, me: ME, speak });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'm3');
  assert.equal(voiced.size, 1, 'only the caught-up message is marked; the older replies stay unvoiced, unspoken');
});

test('no catch-up when the newest reply was already spoken', () => {
  const voiced = new Set(['m3']);
  const { calls, speak } = recorder();
  const pick = runCatchUp({ messages: [ownAsk, replyA, replyB], voiced, me: ME, speak });
  assert.equal(pick, null);
  assert.equal(calls.length, 0, 'nothing speaks — and the room does not reach back to the older unspoken reply');
});

test('no catch-up for the human’s own message', () => {
  const voiced = new Set();
  const { calls, speak } = recorder();
  const ownNewest = { id: 'm4', authorKind: 'human', authorSubject: ME, body: 'One more thing from me.' };
  const pick = runCatchUp({ messages: [replyA, ownNewest], voiced, me: ME, speak });
  assert.equal(pick?.id, 'm2', 'the member’s own newest message is skipped; the newest seat reply catches up');
  assert.deepEqual(calls.map((c) => c.id), ['m2']);
  const solo = recorder();
  assert.equal(runCatchUp({ messages: [ownNewest], voiced: new Set(), me: ME, speak: solo.speak }), null, 'a room whose newest message is the member’s own has no catch-up');
  assert.equal(solo.calls.length, 0);
});

test('catch-up is seat-only: other humans, bridge-fed members and system rows never qualify', () => {
  const otherHuman = { id: 'm5', authorKind: 'human', authorSubject: 'user:guest', body: 'A guest speaks.' };
  const discordMember = { id: 'm6', authorKind: 'human', authorSubject: 'discord:42', source: 'discord', body: 'From Discord.' };
  const systemRow = { id: 'm7', authorKind: 'system', agentProvider: 'claude', body: 'System notice.' };
  const { calls, speak } = recorder();
  const pick = runCatchUp({ messages: [replyA, otherHuman, discordMember, systemRow], voiced: new Set(), me: ME, speak });
  assert.equal(pick?.id, 'm2', 'none of the newer non-seat rows is picked over the newest seat reply');
  assert.deepEqual(calls.map((c) => c.id), ['m2']);
  assert.equal(catchUpPick([otherHuman, discordMember, systemRow], ME), null, 'no seat reply in the room — no catch-up');
});

test('catch-up takes only completed replies: pending echoes and empty bodies are skipped', () => {
  const pendingSeat = { id: 'pending-1', _pending: true, authorKind: 'agent', authorSubject: 'agent:claude', agentProvider: 'claude', body: 'Still typing…' };
  const emptySeat = { id: 'm8', authorKind: 'agent', authorSubject: 'agent:claude', agentProvider: 'claude', body: '   ' };
  const { calls, speak } = recorder();
  const pick = runCatchUp({ messages: [replyA, pendingSeat, emptySeat], voiced: new Set(), me: ME, speak });
  assert.equal(pick?.id, 'm2', 'the newest COMPLETED seat reply catches up, not a pending or empty row');
  assert.deepEqual(calls.map((c) => c.id), ['m2']);
});

test('seat provider derives like the scanner: provider field, agent: subject, bridge → null', () => {
  const bySubject = { id: 'm9', authorSubject: 'agent:mistral', body: 'Subject-named seat.' };
  assert.deepEqual(catchUpPick([bySubject], ME), { id: 'm9', body: bySubject.body, provider: 'mistral' });
  const bridge = { id: 'm10', authorSubject: 'runner:bridge', body: 'From the PC bridge.' };
  assert.deepEqual(catchUpPick([bridge], ME), { id: 'm10', body: bridge.body, provider: null });
});

test('toggle-off before it starts: a declined speak burns nothing, and the next voice-on can still offer it', () => {
  const voiced = new Set();
  const off = recorder(false); // the controller declines — voice chat is off (or the view gate closed)
  const pick = runCatchUp({ messages: [ownAsk, replyA, replyB], voiced, me: ME, speak: off.speak });
  assert.equal(pick, null, 'nothing is reported spoken');
  assert.equal(off.calls.length, 1, 'the offer was made and declined');
  assert.equal(voiced.size, 0, 'a declined catch-up does not mark the message voiced');
  const on = recorder(true);
  const retry = runCatchUp({ messages: [ownAsk, replyA, replyB], voiced, me: ME, speak: on.speak });
  assert.equal(retry?.id, 'm3', 'the same reply is offered again at the next switch-on');
});

test('wiring pins: scanner records voiced ids, toggle triggers the catch-up, toggle-off cancels queued speech', async () => {
  const envoy = await readFile(new URL('../web/marketing/app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(envoy.includes('if (!spokenPrimed.has(streamId))'), 'the scanner prime is untouched (first sight of a stream still only baselines)');
  assert.ok(envoy.includes('if (ws.ctx.voiceSpeak(m.body, who.provider ?? null, m.id) !== false) voicedIds.add(m.id);'),
    'the scanner marks a message voiced only when the speak path takes it');
  assert.ok(envoy.includes('export function speakCatchUp()'), 'envoy exports the catch-up entry the toggle calls');
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const toggleAt = appJs.indexOf('function toggleMaestroVoice');
  assert.ok(toggleAt !== -1, 'toggleMaestroVoice exists');
  const toggleBody = appJs.slice(toggleAt, appJs.indexOf('\nfunction ', toggleAt + 10));
  assert.ok(toggleBody.includes("if (mode === 'voice') workspaceModule?.speakCatchUp?.();"),
    'turning voice chat on in the room fires exactly one catch-up; dictate never does');
  const offAt = appJs.indexOf('if (!on && voiceMode)');
  assert.ok(offAt !== -1, 'the controller toggle-off branch exists');
  assert.ok(appJs.slice(offAt, appJs.indexOf('return true;', offAt)).includes('cancelSpeech();'),
    'toggling voice off cancels queued speech — a queued catch-up dies with it');
});
