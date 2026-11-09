// Mic-hostage fix (2026-11-08): in voice kind, the echo guard and the
// auto-submit hold keyed on speechActive(), which counted a reply
// that was merely QUEUED or still GENERATING as "speaking" — and the
// Kokoro generate had no timeout at all. A slow cold-model generate
// (an incognito tab downloads the model fresh) or a wedged generate
// therefore held the microphone hostage for the whole queue drain, or
// forever: Troy pressed the mic button, spoke, and no text landed.
//
// The fix, pinned here on injected fakes:
//  - speechActive() means ACTUAL PLAYBACK only (a Kokoro buffer
//    source playing, or a backup utterance speaking). The echo guard
//    and the auto-submit hold key on it, so results are accepted and
//    sends fire while a reply is still being generated.
//  - The mic loop's restart keeps keying on speechInFlight() (the old
//    body): starting a turn cancels speech, so a restart while a
//    reply is being prepared would kill the reply before it played.
//    The hold is bounded now — the load wait and every generate have
//    hard bounds — so it delays a turn, never holds the mic hostage.
//  - Every generate is bounded by KOKORO_GENERATE_MS in the load
//    wait's own idiom (a Date.now deadline, polled). A generate that
//    never settles is treated as a generate failure: the backup voice
//    speaks the chunk, the queue moves on, the mic frees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVoiceController, VOICE_AUTO_SUBMIT_MS } from '../web/shared/voice-dictation.mjs';

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

function resultEvent(transcripts, final = true) {
  return { results: transcripts.map((t) => ({ isFinal: final, 0: { transcript: t }, length: 1 })) };
}

async function until(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A clock the test can advance without waiting: Date.now runs on the
// real clock plus an offset, so the harness's own timeouts still work
// in real time while the controller sees the advanced time (the same
// trick the silence-fix suite uses for the load bounds).
function stubClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  return {
    advance(ms) { offset += ms; },
    restore() { Date.now = realNow; },
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

function voiceOn(f, extraDeps = {}) {
  const transcripts = [];
  const submits = [];
  const interims = [];
  const errors = [];
  const v = createVoiceController({
    Recognition: f.FakeRecognition,
    synthesis: f.synthesis,
    Utterance: f.FakeUtterance,
    makeAudioContext: f.makeAudioContext,
    ...extraDeps,
  });
  const ok = v.setVoiceMode(true, {
    mode: 'voice',
    onTranscript: (t) => transcripts.push(t),
    onSubmit: (t) => submits.push(t),
    onInterim: (t) => interims.push(t),
    onError: (e) => errors.push(e),
    onState() {},
  });
  assert.equal(ok, true);
  f.instances[0].onstart();
  return { v, transcripts, submits, interims, errors };
}

// An engine whose generate() calls are recorded and gated: each call
// waits until release() before returning its audio, so a test can
// hold a generate open as long as it likes.
function gatedEngine(calls) {
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    release,
    engine: {
      generate: async (text, { voice } = {}) => {
        calls.push({ text, voice });
        await gate;
        return { audio: new Float32Array(240), sampling_rate: 24000 };
      },
    },
  };
}

const CHUNK_A = `${'Alpha '.repeat(28).trim()}.`;
const CHUNK_B = `${'Bravo '.repeat(28).trim()}.`;
const TWO_CHUNKS = `${CHUNK_A} ${CHUNK_B}`;

test('mic fix: results are accepted while a Kokoro generate is pending and more chunks are queued', async () => {
  const f = makeFakes();
  const calls = [];
  const { engine } = gatedEngine(calls);
  const { v, transcripts, interims, submits } = voiceOn(f, { kokoroLoader: async () => engine });
  assert.equal(v.speak(TWO_CHUNKS, 'claude'), true);
  await until(() => calls.length === 1);
  await wait(120);
  assert.equal(calls.length, 1, 'the second chunk is still queued behind the pending generate');
  assert.equal(v.speakingNow, null, 'nothing is playing yet — generation alone never lights the speaker proof');
  // The user's words land normally: the pending generate and the
  // queued chunk no longer close the mic.
  f.instances[0].onresult(resultEvent(['still talking'], false));
  assert.deepEqual(interims, ['still talking']);
  f.instances[0].onresult(resultEvent(['words while it generates']));
  assert.deepEqual(transcripts, ['words while it generates']);
  assert.equal(v.setVoiceMode(false, {}), true); // disarm the pending auto-submit
  assert.deepEqual(submits, []);
});

test('mic fix: results are dropped while the Kokoro reply is actually playing, accepted again when it ends', async () => {
  const f = makeFakes();
  const calls = [];
  const engine = {
    generate: async (text, { voice } = {}) => {
      calls.push({ text, voice });
      return { audio: new Float32Array(240), sampling_rate: 24000 };
    },
  };
  const { v, transcripts, interims } = voiceOn(f, { kokoroLoader: async () => engine });
  assert.equal(v.speak('Short reply.', 'claude'), true);
  await until(() => f.sources.length === 1 && f.sources[0].started); // playback
  f.instances[0].onresult(resultEvent(['the reply coming back through the mic']));
  f.instances[0].onresult(resultEvent(['its interims'], false));
  assert.deepEqual(transcripts, [], 'echo never reaches the composer while sound is playing');
  assert.deepEqual(interims, [], 'echo never renders as interim text while sound is playing');
  f.sources[0].onended();
  f.instances[0].onresult(resultEvent(['my actual words']));
  assert.deepEqual(transcripts, ['my actual words'], 'the mic hears the user again once playback ends');
  assert.equal(v.setVoiceMode(false, {}), true);
});

test('mic fix: a pending auto-submit fires while the reply is still generating — the hold is playback-only', async () => {
  const f = makeFakes();
  const calls = [];
  const { engine, release } = gatedEngine(calls);
  const { v, transcripts, submits } = voiceOn(f, { kokoroLoader: async () => engine });
  assert.equal(v.speak('A slow reply.'), true);
  await until(() => calls.length === 1); // generate in flight, nothing playing
  f.instances[0].onresult(resultEvent(['send this anyway']));
  assert.deepEqual(transcripts, ['send this anyway']);
  await wait(VOICE_AUTO_SUBMIT_MS + 400);
  assert.deepEqual(submits, [''], 'the send does not wait for a reply that has not started playing');
  release();
  await until(() => f.sources.length === 1 && f.sources[0].started);
  f.sources[0].onended();
  assert.equal(v.setVoiceMode(false, {}), true);
});

test('mic fix: a pending auto-submit holds while the reply is actually playing and fires when playback ends', async () => {
  const f = makeFakes();
  const calls = [];
  const { engine, release } = gatedEngine(calls);
  const { v, submits } = voiceOn(f, { kokoroLoader: async () => engine });
  assert.equal(v.speak('A held reply.'), true);
  await until(() => calls.length === 1);
  f.instances[0].onresult(resultEvent(['held words'])); // arms the auto-submit
  release(); // playback begins well inside the silence bound
  await until(() => f.sources.length === 1 && f.sources[0].started);
  await wait(VOICE_AUTO_SUBMIT_MS + 400);
  assert.deepEqual(submits, [], 'turn-taking: the send holds while sound is playing');
  f.sources[0].onended();
  await until(() => submits.length === 1);
  assert.deepEqual(submits, [''], 'the held send fires once the playback ends');
  assert.equal(v.setVoiceMode(false, {}), true);
});

test('mic fix: a generate that never resolves times out, falls back to the backup voice, and frees the microphone', async () => {
  await withStatusDom(async (els) => {
    const clock = stubClock();
    try {
      const f = makeFakes();
      const calls = [];
      const engine = {
        generate: (text, { voice } = {}) => {
          calls.push({ text, voice });
          return new Promise(() => {}); // never settles — the wedged worker
        },
      };
      const { v, transcripts } = voiceOn(f, { kokoroLoader: async () => engine });
      assert.equal(v.speak('A wedged reply.', 'claude'), true);
      await until(() => calls.length === 1); // the generate is in flight
      // While the reply is in flight the loop's restart still holds —
      // starting a turn would cancel the reply — but the hold is
      // bounded now, not a hostage-taking.
      f.instances[0].onend();
      await wait(500); // > the 400ms hold poll
      assert.equal(f.instances.length, 1, 'mic restart held while the reply is in flight');
      clock.advance(16000); // past the 15s generate bound
      await until(() => f.spoken.length === 1);
      assert.equal(f.spoken[0].text, 'A wedged reply.', 'the backup voice speaks the chunk the wedged generate could not');
      assert.match(els[0].textContent, /Backup voice — Kokoro unavailable/);
      // The microphone is free: once the fallback playback ends, the
      // held restart starts a fresh turn and words land again.
      f.spoken[0].onend();
      await until(() => f.instances.length === 2, 3000);
      assert.equal(f.instances[1].started, true);
      f.instances[1].onresult(resultEvent(['I can talk again']));
      assert.deepEqual(transcripts, ['I can talk again']);
      assert.equal(v.setVoiceMode(false, {}), true);
    } finally {
      clock.restore();
    }
  });
});

test('lockstep: the app.js inline copy carries the same mic-hostage fix as the shared module', async () => {
  const needles = [
    'const KOKORO_GENERATE_MS = 15000',
    'function speechInFlight()',
    'async function kokoroGenerateBounded(engine, item)',
    'out = await kokoroGenerateBounded(engine, item);',
    'if (speechInFlight()) {',
    'try { return !!(synthesis?.speaking); } catch { return false; }',
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const [name, js] of [['app.js', appJs], ['shared', shared]]) {
    for (const needle of needles) {
      assert.ok(js.includes(needle), `${name} has: ${needle}`);
    }
    // speechActive itself is playback-only: its body consults neither
    // the queue nor the in-flight generate.
    const body = js.slice(js.indexOf('function speechActive()'), js.indexOf('function speechInFlight()'));
    assert.ok(body.includes('if (activeSource) return true;'), `${name}: speechActive keys on actual playback`);
    assert.ok(!body.includes('kokoroQueue'), `${name}: speechActive no longer counts the queue as speaking`);
    assert.ok(!body.includes('kokoroPlaying'), `${name}: speechActive no longer counts a pending generate as speaking`);
    // The cancelled-mid-generate guard stands on both generate exits —
    // the success path (pre-existing) and the failure path (this fix).
    assert.ok(js.split('cancelled mid-generate').length - 1 >= 2, `${name}: both generate exits guard a cancelled chunk`);
  }
});
