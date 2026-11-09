// Kokoro engagement bite — smoke tests for the staged controller
// (web/shared/voice-dictation.mjs). Covers: warmup at voice-enable,
// speaks queueing behind an in-flight load, the shared single load,
// load failure -> labelled backup voice, the retry window, per-seat
// voices, the visible engine status, and the mic hold-off while a
// reply waits behind the load. Run together with the repo's existing
// test/voice-dictation.test.mjs (regression) against the staged module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController, voiceForSeat, SEAT_VOICES } from '../web/shared/voice-dictation.mjs';

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

function fakeEngine(calls) {
  return {
    generate: async (text, { voice } = {}) => {
      calls.push({ text, voice });
      return { audio: new Float32Array(240), sampling_rate: 24000 };
    },
  };
}

function withStatusDom(fn) {
  const els = [{ textContent: '', className: '' }, { textContent: '', className: '' }];
  const prev = globalThis.document;
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    querySelectorAll: (sel) => (sel === '.voice-engine' ? els : []),
  };
  const cleanup = () => { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; };
  return Promise.resolve()
    .then(() => fn(els))
    .finally(cleanup);
}

async function until(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function voiceOn(f, extraDeps = {}, handlers = {}) {
  const v = createVoiceController({
    Recognition: f.FakeRecognition,
    synthesis: f.synthesis,
    Utterance: f.FakeUtterance,
    makeAudioContext: f.makeAudioContext,
    ...extraDeps,
  });
  assert.equal(v.setVoiceMode(true, { mode: 'voice', onTranscript() {}, onSubmit() {}, onState() {}, onError() {}, ...handlers }), true);
  f.instances[0].onstart();
  return v;
}

test('voiceForSeat: house voice for Maestro and the unmapped, named seats distinct, pool stable', () => {
  assert.equal(voiceForSeat('maestro'), 'af_heart');
  assert.equal(voiceForSeat(null), 'af_heart');
  assert.equal(voiceForSeat(''), 'af_heart');
  assert.equal(voiceForSeat('chatgpt'), 'am_michael');
  assert.equal(voiceForSeat('Claude'), 'af_bella'); // case-insensitive
  assert.equal(SEAT_VOICES.claude, 'af_bella');
  const pool = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah', 'bm_daniel'];
  const a = voiceForSeat('custom-agent-x');
  assert.ok(pool.includes(a), `custom seat lands in the pool, got ${a}`);
  assert.equal(voiceForSeat('custom-agent-x'), a); // stable across calls
});

test('enabling voice chat warms Kokoro immediately; dictate does not', async () => {
  const f = makeFakes();
  let loads = 0;
  const calls = [];
  const kokoroLoader = async () => { loads += 1; return fakeEngine(calls); };
  const v = voiceOn(f, { kokoroLoader });
  await until(() => v.engineState === 'ready');
  assert.equal(loads, 1, 'loader ran at enable time, before any speak');

  const f2 = makeFakes();
  let loads2 = 0;
  const v2 = createVoiceController({
    Recognition: f2.FakeRecognition, synthesis: f2.synthesis, Utterance: f2.FakeUtterance,
    kokoroLoader: async () => { loads2 += 1; return fakeEngine([]); },
  });
  assert.equal(v2.setVoiceMode(true, { mode: 'dictate', onState() {}, onError() {} }), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(loads2, 0, 'dictate never warms (it never speaks)');
  assert.equal(v2.engineState, 'idle');
});

test('a speak during warmup waits for Kokoro and speaks in the seat voice — backup stays silent', async () => {
  await withStatusDom(async (els) => {
    const f = makeFakes();
    const calls = [];
    let resolveLoad;
    const kokoroLoader = () => new Promise((res) => { resolveLoad = () => res(fakeEngine(calls)); });
    const v = voiceOn(f, { kokoroLoader });
    assert.equal(v.engineState, 'loading');
    assert.equal(els[0].textContent, 'Voice loading…');
    assert.equal(v.speak('Hello there.', 'claude'), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.spoken.length, 0, 'backup voice must not speak while Kokoro loads');
    assert.equal(calls.length, 0, 'nothing generated before the model lands');
    resolveLoad();
    await until(() => f.sources.length === 1 && f.sources[0].started);
    assert.deepEqual(calls, [{ text: 'Hello there.', voice: 'af_bella' }]);
    assert.equal(f.spoken.length, 0, 'backup voice never spoke');
    assert.equal(els[0].textContent, 'Kokoro');
    assert.equal(els[1].textContent, 'Kokoro', 'status fans out to every .voice-engine element');
    f.sources[0].onended();
  });
});

test('warmup and speaks share ONE load', async () => {
  const f = makeFakes();
  let loads = 0;
  const calls = [];
  const kokoroLoader = async () => { loads += 1; return fakeEngine(calls); };
  const v = voiceOn(f, { kokoroLoader });
  v.speak('One.', null);
  v.speak('Two.', null); // replaces One in the queue before it drains
  await until(() => f.sources.length >= 1);
  assert.equal(loads, 1);
  f.sources[0].onended();
});

test('load failure: the backup voice speaks, labelled as the backup', async () => {
  await withStatusDom(async (els) => {
    const f = makeFakes();
    const kokoroLoader = async () => { throw new Error('network down'); };
    const v = voiceOn(f, { kokoroLoader });
    await until(() => v.engineState === 'failed');
    assert.match(els[0].textContent, /Backup voice/);
    assert.equal(v.speak('Backup please.'), true);
    await until(() => f.spoken.length === 1);
    assert.equal(f.spoken[0].text, 'Backup please.');
    assert.match(els[0].textContent, /Backup voice/);
    assert.match(els[0].className, /fallback/);
  });
});

test('retry window: no reload inside 60s, a real retry after it', async () => {
  const f = makeFakes();
  let loads = 0;
  const calls = [];
  const kokoroLoader = async () => {
    loads += 1;
    if (loads === 1) throw new Error('first attempt fails');
    return fakeEngine(calls);
  };
  const v = voiceOn(f, { kokoroLoader });
  await until(() => v.engineState === 'failed');
  assert.equal(v.speak('Still down.'), true);
  await until(() => f.spoken.length === 1);
  assert.equal(loads, 1, 'no reload attempt inside the retry window');

  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    assert.equal(v.speak('Try again now.'), true);
    await until(() => f.sources.length === 1 && f.sources[0].started);
    assert.equal(loads, 2, 'loader retried after the window');
    assert.deepEqual(calls, [{ text: 'Try again now.', voice: 'af_heart' }]);
    f.sources[0].onended();
  } finally {
    Date.now = realNow;
  }
});

test('per-seat voices reach generate: default af_heart, chatgpt am_michael', async () => {
  const f = makeFakes();
  const calls = [];
  const kokoroLoader = async () => fakeEngine(calls);
  const v = voiceOn(f, { kokoroLoader });
  await until(() => v.engineState === 'ready');
  v.speak('From the house.');
  await until(() => f.sources.length === 1 && f.sources[0].started);
  f.sources[0].onended();
  v.speak('From ChatGPT.', 'chatgpt');
  await until(() => f.sources.length === 2 && f.sources[1].started);
  f.sources[1].onended();
  assert.deepEqual(calls.map((c) => c.voice), ['af_heart', 'am_michael']);
});

test('mic hold-off: no new turn while a reply waits behind the load; resumes after it speaks', async () => {
  await withStatusDom(async () => {
    const f = makeFakes();
    const calls = [];
    let resolveLoad;
    const kokoroLoader = () => new Promise((res) => { resolveLoad = () => res(fakeEngine(calls)); });
    const v = voiceOn(f, { kokoroLoader });
    assert.equal(f.instances.length, 1);
    assert.equal(v.speak('Hold the mic.'), true);
    f.instances[0].onend(); // recognition turn ends; the loop wants to restart
    await new Promise((r) => setTimeout(r, 500)); // > the 400ms hold poll
    assert.equal(f.instances.length, 1, 'mic held while the reply waits behind the model load');
    resolveLoad();
    await until(() => f.sources.length === 1 && f.sources[0].started);
    f.sources[0].onended(); // reply finished; speech drains
    await until(() => f.instances.length === 2, 3000);
    assert.equal(f.instances[1].started, true, 'mic resumed once the reply drained');
  });
});
