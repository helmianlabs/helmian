// Voice upgrades (2026-11-08, Troy's overnight order):
//  1. Every one of the fourteen room seats carries a NAMED, fixed Kokoro
//     voice — distinct, stable across calls — and the hash pool is only
//     the fallback for unmapped custom seats.
//  2. Two-way voice mode: no "send it" to say. In voice kind a final
//     transcript lands in the composer as usual, and once the speaker
//     stops (VOICE_AUTO_SUBMIT_MS of no new words) the utterance
//     submits itself. Dictate kind is unchanged. Recognition results
//     that arrive while a reply is being read aloud are dropped whole
//     (echo guard), and a pending auto-submit holds until the reply
//     drains. Everything runs on injected fakes — no Kokoro loader —
//     so the two-way behaviour is proven on the backup-voice road too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVoiceController, voiceForSeat, SEAT_VOICES, VOICE_AUTO_SUBMIT_MS } from '../web/shared/voice-dictation.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakes() {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); this.started = false; this.stopped = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; this.onend?.(); }
  }
  const spoken = [];
  const synthesis = {
    speak(u) { spoken.push(u); },
    cancel() {},
    speaking: false,
    pending: false,
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  return { instances, FakeRecognition, spoken, synthesis, FakeUtterance };
}

function resultEvent(transcripts, final = true) {
  return { results: transcripts.map((t) => ({ isFinal: final, 0: { transcript: t }, length: 1 })) };
}

function voiceOn(f, mode) {
  const transcripts = [];
  const submits = [];
  const interims = [];
  const errors = [];
  const v = createVoiceController({ Recognition: f.FakeRecognition, synthesis: f.synthesis, Utterance: f.FakeUtterance });
  const ok = v.setVoiceMode(true, {
    mode,
    onTranscript: (t) => transcripts.push(t),
    onSubmit: (t) => submits.push(t),
    onInterim: (t) => interims.push(t),
    onError: (e) => errors.push(e),
  });
  assert.equal(ok, true);
  return { v, transcripts, submits, interims, errors };
}

// ---------- Piece 1: a named voice for every seat ----------

const EXPECTED_SEAT_VOICES = {
  maestro: 'af_heart',
  claude: 'af_bella',
  chatgpt: 'am_michael',
  grok: 'am_fenrir',
  gemini: 'af_nova',
  mistral: 'bf_emma',
  groq: 'am_puck',
  nvidia: 'am_onyx',
  openrouter: 'bf_isabella',
  cloudflare: 'af_sky',
  qwen: 'af_kore',
  muse: 'af_aoede',
  helm: 'bm_george',
  owner: 'bm_daniel',
};
const LIVE_VOICE_FILES = ['af_aoede', 'af_bella', 'af_heart', 'af_kore', 'af_nicole', 'af_nova', 'af_sarah', 'af_sky', 'am_adam', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_george'];

test('seat voices: all fourteen room seats carry the named voice, exactly', () => {
  assert.deepEqual({ ...SEAT_VOICES }, EXPECTED_SEAT_VOICES);
  for (const [seat, voice] of Object.entries(EXPECTED_SEAT_VOICES)) {
    assert.equal(voiceForSeat(seat), voice, `${seat} resolves to its named voice`);
    assert.equal(voiceForSeat(seat), voiceForSeat(seat), `${seat} is stable across calls`);
    assert.ok(LIVE_VOICE_FILES.includes(voice), `${voice} is one of the nineteen live voice files`);
  }
  assert.equal(voiceForSeat('Claude'), 'af_bella', 'seat lookup stays case-insensitive');
  assert.equal(voiceForSeat(' OWNER '), 'bm_daniel', 'seat lookup trims and lowercases');
});

test('seat voices: all fourteen are distinct — no two seats sound alike', () => {
  const voices = Object.values(SEAT_VOICES);
  assert.equal(voices.length, 14);
  assert.equal(new Set(voices).size, 14);
});

test('seat voices: the owner is named (bm_daniel) and Maestro keeps the house voice', () => {
  // af_heart is Maestro's house voice (pinned by the kokoro bite), so the
  // owner takes the strongest unused male voice instead of colliding.
  assert.equal(SEAT_VOICES.owner, 'bm_daniel');
  assert.equal(SEAT_VOICES.maestro, 'af_heart');
  assert.notEqual(voiceForSeat('owner'), voiceForSeat('maestro'));
});

test('seat voices: unmapped custom seats hash into the fallback pool only, never onto a named voice', () => {
  const pool = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah'];
  const named = new Set(Object.values(SEAT_VOICES));
  for (const custom of ['custom-agent-x', 'helper-2', 'sidekick', 'zz-top-seat']) {
    const v = voiceForSeat(custom);
    assert.ok(pool.includes(v), `${custom} lands in the fallback pool, got ${v}`);
    assert.ok(!named.has(v), `${custom} never collides with a named seat voice`);
    assert.equal(voiceForSeat(custom), v, 'pool pick is stable across calls');
  }
});

// ---------- Piece 2: two-way voice mode ----------

test('two-way: the silence bound is the exported 1500ms', () => {
  assert.equal(VOICE_AUTO_SUBMIT_MS, 1500);
});

test('dictate: a final without "send it" inserts only — it never auto-submits', async () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f, 'dictate');
  f.instances[0].onresult(resultEvent(['a dictated note']));
  assert.deepEqual(transcripts, ['a dictated note']);
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [], 'dictate still waits for the command word');
});

test('dictate: "send it" still submits immediately', async () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f, 'dictate');
  f.instances[0].onresult(resultEvent(['a dictated note send it']));
  assert.deepEqual(submits, ['a dictated note']);
  assert.deepEqual(transcripts, []);
});

test('voice: a final lands in the composer, then submits itself once the speaker stops', async () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['hello everyone']));
  assert.deepEqual(transcripts, ['hello everyone'], 'the utterance lands through onTranscript as usual');
  assert.deepEqual(submits, [], 'nothing submits the instant the final lands');
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [''], 'one bare submit (composer as-is) after the silence bound');
});

test('voice: a second final inside the bound re-arms it — one submit, after the real stop', async () => {
  const f = makeFakes();
  const { submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['first part']));
  await wait(900);
  f.instances[0].onresult(resultEvent(['second part']));
  await wait(800); // 1.7s after the first final, 0.8s after the second
  assert.deepEqual(submits, [], 'the first utterance\u2019s bound must not fire mid-thought');
  await wait(1000); // past the second final's bound
  assert.deepEqual(submits, [''], 'exactly one submit once the speaker truly stopped');
});

test('voice: interim words from a resumed turn push the bound out', async () => {
  const f = makeFakes();
  const { submits, interims } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['the plan is']));
  await wait(1100);
  f.instances[0].onresult(resultEvent(['to ship it Friday'], false)); // interim — still talking
  assert.equal(interims.length, 1);
  await wait(700); // 1.8s after the final: the original bound has passed
  assert.deepEqual(submits, [], 'interim words mean the speaker has not stopped');
  await wait(1100); // past the re-armed bound
  assert.deepEqual(submits, ['']);
});

test('voice: interim words alone never submit — nothing fires mid-utterance', async () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['half a thought'], false));
  f.instances[0].onresult(resultEvent(['half a thought and more'], false));
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(transcripts, []);
  assert.deepEqual(submits, []);
});

test('voice: "send it" still submits immediately and supersedes the pending auto-submit', async () => {
  const f = makeFakes();
  const { submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['draft words']));
  f.instances[0].onresult(resultEvent(['send it']));
  assert.deepEqual(submits, [''], 'the command word submits on the spot');
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [''], 'the superseded auto-submit never double-fires');
});

test('voice: results arriving while a reply is being spoken are dropped whole (echo guard)', async () => {
  const f = makeFakes();
  const { v, transcripts, submits, interims } = voiceOn(f, 'voice');
  f.synthesis.speaking = true; // a reply is being read aloud (backup engine seam)
  f.instances[0].onresult(resultEvent(['the reply\u2019s own words coming back']));
  f.instances[0].onresult(resultEvent(['and its interims'], false));
  assert.deepEqual(transcripts, [], 'echo never reaches the composer');
  assert.deepEqual(interims, [], 'echo never renders as interim text');
  f.synthesis.speaking = false;
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [], 'echo never arms the auto-submit');
  // …and the mic hears the user again once the reply has drained.
  f.instances[0].onresult(resultEvent(['my actual words']));
  assert.deepEqual(transcripts, ['my actual words']);
  v.setVoiceMode(false, {});
});

test('voice: the echo guard and the hold work on the backup engine itself (no Kokoro involved)', async () => {
  const f = makeFakes();
  const { v, transcripts, submits } = voiceOn(f, 'voice');
  // The user's utterance lands and arms the auto-submit…
  f.instances[0].onresult(resultEvent(['question one']));
  assert.deepEqual(transcripts, ['question one']);
  // …then a reply starts speaking through speechSynthesis (no Kokoro
  // loader exists in this controller — the backup road is all there is).
  assert.equal(v.speak('the spoken answer', 'claude'), true);
  assert.equal(f.spoken.length, 1, 'the backup engine speaks the reply');
  // While it speaks, recognition results are the reply coming back: dropped.
  f.instances[0].onresult(resultEvent(['the spoken answer']));
  assert.deepEqual(transcripts, ['question one'], 'the reply\u2019s own audio is never transcribed');
  // The pending auto-submit holds while the reply plays…
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [], 'turn-taking: the send holds until the reply drains');
  // …and goes out once it ends.
  f.spoken[0].onend?.();
  await wait(700);
  assert.deepEqual(submits, [''], 'the held send fires after the reply drains');
});

test('voice: turning voice off before the bound cancels the pending auto-submit', async () => {
  const f = makeFakes();
  const { v, submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['never mind']));
  assert.equal(v.setVoiceMode(false, {}), true);
  await wait(VOICE_AUTO_SUBMIT_MS + 300);
  assert.deepEqual(submits, [], 'voice off stops everything, the pending send included');
});

test('voice: turning voice off while a send is held behind a reply cancels it too', async () => {
  const f = makeFakes();
  const { v, submits } = voiceOn(f, 'voice');
  f.instances[0].onresult(resultEvent(['held words']));
  f.synthesis.speaking = true; // a reply starts before the bound fires
  await wait(VOICE_AUTO_SUBMIT_MS + 200); // bound passed; the send is in its drain-hold
  assert.deepEqual(submits, []);
  assert.equal(v.setVoiceMode(false, {}), true);
  f.synthesis.speaking = false;
  await wait(800);
  assert.deepEqual(submits, [], 'the held send dies with voice mode, it does not fire late');
});

test('lockstep: app.js inline copy carries the two-way voice machinery and the seat map', async () => {
  const needles = [
    'const VOICE_AUTO_SUBMIT_MS = 1500',
    'function scheduleAutoSubmit',
    'function fireAutoSubmit',
    'function clearAutoSubmit',
    'if (voiceKind === \'voice\' && speechActive()) return;',
    "owner: 'bm_daniel'",
    "const SEAT_VOICE_POOL = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah']",
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle), `shared module has: ${needle}`);
  }
  assert.ok(appJs.includes('when you stop talking, your message sends itself'), 'app.js voice-chat explanation no longer tells the user to say "send it"');
});
