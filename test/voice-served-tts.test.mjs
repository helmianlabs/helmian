// Served TTS (lag bite 1, 2026-11-10): server-side synthesis is the
// primary voice road. The tab only fetches and plays finished audio,
// through ONE playback queue ordered by message order; the in-tab
// Kokoro engine and the speechSynthesis backup are the fallback when
// served audio is unavailable or fails. These tests pin: ordered,
// non-interrupting playback across replies; the per-seat voice and
// message ref riding each chunk (speaker icon proof, engine
// 'served'); fetch-ahead of the next chunk while one plays; failure
// handing the reply to the in-tab Kokoro road in order and latching
// the served road broken for the session; cancel orphaning an
// in-flight fetch; and the app.js inline copy carrying the same
// machinery as web/shared/voice-dictation.mjs (lockstep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVoiceController } from '../web/shared/voice-dictation.mjs';

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
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const sources = [];
  const makeAudioContext = () => ({
    state: 'running',
    destination: {},
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => {
      const src = { buffer: null, onended: null, started: false, connect() {}, start() { this.started = true; }, stop() {} };
      sources.push(src);
      return src;
    },
    resume: () => Promise.resolve(),
  });
  return { instances, FakeRecognition, spoken, synthesis, FakeUtterance, sources, makeAudioContext };
}

async function until(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function voiceOn(f, extraDeps = {}) {
  const v = createVoiceController({
    Recognition: f.FakeRecognition,
    synthesis: f.synthesis,
    Utterance: f.FakeUtterance,
    makeAudioContext: f.makeAudioContext,
    ...extraDeps,
  });
  assert.equal(v.setVoiceMode(true, { mode: 'voice', onTranscript() {}, onSubmit() {}, onState() {}, onError() {} }), true);
  f.instances[0].onstart();
  return v;
}

const okAudio = { audio: new Float32Array(240), sampling_rate: 24000 };

test('served road: two replies play whole, in message order, in their own seat voices — the second never interrupts the first', async () => {
  const f = makeFakes();
  const calls = [];
  const servedTts = async (text, { voice, seat, ref }) => { calls.push({ text, voice, seat, ref }); return okAudio; };
  const kokoroCalls = [];
  const kokoroLoader = async () => ({ generate: async (text, { voice } = {}) => { kokoroCalls.push({ text, voice }); return okAudio; } });
  const v = voiceOn(f, { servedTts, kokoroLoader });
  const events = [];
  v.setSpeakingListener((info) => events.push(info ? { ...info } : null));
  assert.equal(v.speak('Alpha one. Alpha two.', 'claude', 'msg-a'), true);
  assert.equal(v.speak('Bravo one.', 'grok', 'msg-b'), true);
  // First chunk of the first reply starts; nothing else has played.
  await until(() => f.sources.length === 1 && f.sources[0].started);
  assert.deepEqual(events.at(-1), { seat: 'claude', engine: 'served', ref: 'msg-a' });
  assert.equal(kokoroCalls.length, 0, 'the in-tab engine never generates on the served road');
  f.sources[0].onended();
  await until(() => f.sources.length === 2 && f.sources[1].started);
  assert.deepEqual(events.at(-1), { seat: 'claude', engine: 'served', ref: 'msg-a' }, 'second chunk of the same reply follows in order');
  f.sources[1].onended();
  await until(() => f.sources.length === 3 && f.sources[2].started);
  assert.deepEqual(events.at(-1), { seat: 'grok', engine: 'served', ref: 'msg-b' }, 'the second reply plays only after the first finished');
  f.sources[2].onended();
  await until(() => events.at(-1) === null);
  assert.deepEqual(calls.map((c) => c.text), ['Alpha one.', 'Alpha two.', 'Bravo one.'], 'synthesis was requested in message order');
  assert.deepEqual(calls.map((c) => c.voice), ['af_bella', 'af_bella', 'am_fenrir'], 'each chunk carried its seat voice');
  assert.equal(v.speakingNow, null);
});

test('served road: a served failure hands the reply to in-tab Kokoro in order and latches the served road broken', async () => {
  const f = makeFakes();
  let servedCalls = 0;
  const servedTts = async () => { servedCalls += 1; throw new Error('service down'); };
  const kokoroCalls = [];
  const kokoroLoader = async () => ({ generate: async (text, { voice } = {}) => { kokoroCalls.push({ text, voice }); return okAudio; } });
  const v = voiceOn(f, { servedTts, kokoroLoader });
  assert.equal(v.servedBroken, false);
  assert.equal(v.speak('Fallback reply.', 'gemini', 'msg-f'), true);
  await until(() => f.sources.length === 1 && f.sources[0].started);
  assert.deepEqual(kokoroCalls, [{ text: 'Fallback reply.', voice: 'af_nova' }], 'the failed chunk was generated in-tab with its seat voice');
  assert.equal(v.servedBroken, true, 'the failure latched');
  f.sources[0].onended();
  assert.equal(v.speak('Second reply.', 'gemini', 'msg-g'), true);
  await until(() => f.sources.length === 2 && f.sources[1].started);
  assert.equal(servedCalls, 1, 'a broken served road is not retried per reply');
  assert.deepEqual(kokoroCalls.at(-1), { text: 'Second reply.', voice: 'af_nova' });
  f.sources[1].onended();
});

test('served road: cancel orphans an in-flight fetch — its audio never plays', async () => {
  const f = makeFakes();
  let release;
  const gate = new Promise((r) => { release = r; });
  const servedTts = async () => { await gate; return okAudio; };
  const v = voiceOn(f, { servedTts });
  assert.equal(v.speak('Never heard.', 'claude', 'msg-c'), true);
  await new Promise((r) => setTimeout(r, 50));
  v.cancelSpeech();
  release();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.sources.length, 0, 'no buffer source was ever created for the cancelled fetch');
  assert.equal(v.speakingNow, null);
});

test('served road unavailable (nothing injected, no deploy token): the legacy road is untouched', async () => {
  const f = makeFakes();
  const kokoroCalls = [];
  const kokoroLoader = async () => ({ generate: async (text, { voice } = {}) => { kokoroCalls.push({ text, voice }); return okAudio; } });
  const v = voiceOn(f, { kokoroLoader });
  assert.equal(v.speak('Legacy reply.', 'claude', 'msg-l'), true);
  await until(() => f.sources.length === 1 && f.sources[0].started);
  assert.deepEqual(kokoroCalls, [{ text: 'Legacy reply.', voice: 'af_bella' }]);
  f.sources[0].onended();
});

test('lockstep: the app.js inline copy carries the same served-TTS machinery as the shared module', async () => {
  const needles = [
    "const SERVED_TTS_URL = 'https://voice.5-78-222-178.sslip.io'",
    'const SERVED_TTS_TIMEOUT_MS = 30000',
    'const servedQueue = []',
    'async function pumpServed()',
    'function servedFallback(failedItem)',
    'function servedCancel()',
    'function speakLegacyChunks(chunks, seat, ref)',
    "noteSpeaking(item.seat, 'served', item.ref, src)",
    "setVoiceStatus('Server voice', 'kokoro')",
    'if (!servedBroken && servedAvailable())',
    'get servedBroken() { return servedBroken; }',
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle.replace('const SERVED_TTS_URL', 'export const SERVED_TTS_URL')), `shared module has: ${needle}`);
  }
});
