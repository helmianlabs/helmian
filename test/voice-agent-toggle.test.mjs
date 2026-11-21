// Agent-voices toggle (2026-11-18, Troy's order): a user-facing on/off
// for agent speech in the room, separate from voice chat. The law:
//  1. Default on — the room behaves exactly as it did before the
//     toggle existed: in voice mode, replies speak.
//  2. Off gates the controller's speak() itself — the one choke point
//     every spoken road funnels through (the room's reply scanner, the
//     voice-on catch-up, the session console poll) — so no agent
//     speaks while it is off, whatever else is on.
//  3. Turning it off stops whatever is playing or queued right now.
//  4. Turning it back on restores speech.
// Everything runs on injected fakes: the served road is a fake that
// fails at once (so the reply lands on the backup-voice road with no
// network involved) and there is no Kokoro loader, same as the other
// voice suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVoiceController } from '../web/shared/voice-dictation.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakes() {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); this.started = false; this.stopped = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; this.onend?.(); }
  }
  const spoken = [];
  let cancels = 0;
  const synthesis = {
    speak(u) { spoken.push(u); },
    cancel() { cancels += 1; },
    speaking: false,
    pending: false,
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const servedTts = async () => { throw new Error('no served road in tests'); };
  return { instances, FakeRecognition, spoken, synthesis, FakeUtterance, servedTts, cancels: () => cancels };
}

function voiceOn(f) {
  const v = createVoiceController({ Recognition: f.FakeRecognition, synthesis: f.synthesis, Utterance: f.FakeUtterance, servedTts: f.servedTts });
  const ok = v.setVoiceMode(true, {
    mode: 'voice',
    onTranscript: () => {},
    onSubmit: () => {},
    onInterim: () => {},
    onError: () => {},
  });
  assert.equal(ok, true);
  return v;
}

test('agent voices: default is on, and voice mode speaks as before', async () => {
  const f = makeFakes();
  const v = voiceOn(f);
  assert.equal(v.agentVoices, true, 'the toggle defaults to on');
  assert.equal(v.speak('the spoken answer', 'claude'), true);
  await wait(300);
  assert.equal(f.spoken.length, 1, 'the reply speaks with the toggle untouched');
});

test('agent voices: off gates speak itself — nothing is spoken', async () => {
  const f = makeFakes();
  const v = voiceOn(f);
  assert.equal(v.setAgentVoices(false), false);
  assert.equal(v.agentVoices, false);
  assert.equal(v.speak('the spoken answer', 'claude'), false, 'speak refuses while voices are off');
  await wait(300);
  assert.equal(f.spoken.length, 0, 'no utterance ever reaches the engine');
});

test('agent voices: turning off cancels whatever is playing or queued', async () => {
  const f = makeFakes();
  const v = voiceOn(f);
  assert.equal(v.speak('a reply in flight', 'claude'), true);
  await wait(300);
  assert.equal(f.spoken.length, 1);
  const before = f.cancels();
  v.setAgentVoices(false);
  assert.ok(f.cancels() > before, 'the cancel road fires the moment the toggle goes off');
});

test('agent voices: back on restores speech', async () => {
  const f = makeFakes();
  const v = voiceOn(f);
  v.setAgentVoices(false);
  assert.equal(v.speak('silenced', 'claude'), false);
  assert.equal(v.setAgentVoices(true), true);
  assert.equal(v.agentVoices, true);
  assert.equal(v.speak('the spoken answer', 'claude'), true);
  await wait(300);
  assert.equal(f.spoken.length, 1, 'speech flows again once the toggle is back on');
});

test('agent voices: the gate holds with voice chat off too', () => {
  const f = makeFakes();
  const v = createVoiceController({ Recognition: f.FakeRecognition, synthesis: f.synthesis, Utterance: f.FakeUtterance, servedTts: f.servedTts });
  v.setAgentVoices(false);
  assert.equal(v.speak('the spoken answer', 'claude'), false);
  v.setAgentVoices(true);
  assert.equal(v.speak('the spoken answer', 'claude'), false, 'voice mode off still never speaks — the toggle only ever removes speech');
});

test('agent voices: the app.js inline copy and the room markup carry the toggle', async () => {
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('if (!agentVoices) return false;'), 'app.js inline copy gates speak on the toggle');
  assert.ok(appJs.includes('function setAgentVoices(on)'), 'app.js inline copy carries setAgentVoices');
  assert.ok(appJs.includes("store.get('agentVoices', true)"), 'app.js applies the stored choice at boot');
  assert.ok(appJs.includes("store.set('agentVoices', on)"), 'app.js persists the choice when the chip is tapped');
  const html = await readFile(new URL('../web/marketing/app/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="maestro-voices"'), 'the room composer carries the Voices toggle button');
});
