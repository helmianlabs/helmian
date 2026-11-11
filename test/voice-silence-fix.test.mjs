// Voice-silence fix — tests for the bounded-wait law in the staged
// controller (web/shared/voice-dictation.mjs): a Kokoro load that never
// settles can no longer starve the room. Covers: backup speaks after
// the bound (labelled "still loading"), no fresh wait when the load is
// already older than the bound, a stuck load abandoned and retried
// fresh with Kokoro taking over, the failure reason staying distinct
// ("could not load"), the prime-after-enable seam, the mic gate across
// the wait, and the app.js inline copy carrying the same machinery.
// Run together with test/voice-dictation.test.mjs (repo regression) and
// test/voice-kokoro-bite.test.mjs (bite regression) against the staged
// module.
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

// A clock the test can advance without waiting: Date.now runs on the
// real clock plus an offset, so the harness's own timeouts still work
// in real time while the controller sees the advanced time.
function stubClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  return {
    advance(ms) { offset += ms; },
    restore() { Date.now = realNow; },
  };
}

const neverSettles = () => new Promise(() => {});

test('silence law: a load that never settles — the backup voice speaks the reply once the bounded wait passes', async () => {
  await withStatusDom(async (els) => {
    const clock = stubClock();
    try {
      const f = makeFakes();
      const v = voiceOn(f, { kokoroLoader: neverSettles });
      assert.equal(v.engineState, 'loading');
      assert.equal(v.speak('Can anybody hear me?', 'claude'), true);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(f.spoken.length, 0, 'inside the bound the reply still waits for Kokoro');
      clock.advance(16000); // past the 15s bound, measured from load start
      await until(() => f.spoken.length === 1);
      assert.equal(f.spoken[0].text, 'Can anybody hear me?');
      assert.match(els[0].textContent, /Backup voice — Kokoro still loading/);
      assert.match(els[0].className, /fallback/);
      assert.equal(v.engineState, 'loading', 'the load itself was never cancelled or failed');
      // While that load is still stuck, the next reply does not wait again.
      assert.equal(v.speak('Second reply.'), true);
      await until(() => f.spoken.length === 2);
      assert.equal(f.spoken[1].text, 'Second reply.');
    } finally {
      clock.restore();
    }
  });
});

test('silence law: a load already older than the bound when the reply arrives — backup speaks with no fresh wait', async () => {
  await withStatusDom(async (els) => {
    const clock = stubClock();
    try {
      const f = makeFakes();
      const v = voiceOn(f, { kokoroLoader: neverSettles });
      clock.advance(20000); // the load has been in flight 20s before any reply
      assert.equal(v.speak('Late reply.'), true);
      await until(() => f.spoken.length === 1, 1500);
      assert.equal(f.spoken[0].text, 'Late reply.');
      assert.match(els[0].textContent, /still loading/);
    } finally {
      clock.restore();
    }
  });
});

test('silence law: a stuck load is abandoned past the abandon bound and retried fresh; Kokoro takes over when the retry lands', async () => {
  await withStatusDom(async (els) => {
    const clock = stubClock();
    try {
      const f = makeFakes();
      const calls = [];
      let loads = 0;
      const kokoroLoader = () => {
        loads += 1;
        return loads === 1 ? neverSettles() : Promise.resolve(fakeEngine(calls));
      };
      const v = voiceOn(f, { kokoroLoader });
      assert.equal(loads, 1);
      assert.equal(v.speak('First reply.'), true);
      clock.advance(16000);
      await until(() => f.spoken.length === 1);
      assert.equal(f.spoken[0].text, 'First reply.');
      clock.advance(50000); // load age now 66s: past the 60s abandon bound
      assert.equal(v.warmup(), true); // the same ensureKokoro call the background retry timer makes
      await until(() => v.engineState === 'ready');
      assert.equal(loads, 2, 'a fresh load attempt started');
      assert.equal(els[0].textContent, 'Kokoro');
      assert.equal(v.speak('Second reply.', 'grok'), true);
      await until(() => f.sources.length === 1 && f.sources[0].started);
      assert.deepEqual(calls, [{ text: 'Second reply.', voice: 'am_fenrir' }]);
      assert.equal(f.spoken.length, 1, 'the backup voice did not speak the second reply');
      f.sources[0].onended();
    } finally {
      clock.restore();
    }
  });
});

test('reason split: a load that fails during the wait is labelled "could not load", never "still loading"', async () => {
  await withStatusDom(async (els) => {
    const f = makeFakes();
    const kokoroLoader = async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('boom');
    };
    const v = voiceOn(f, { kokoroLoader });
    assert.equal(v.speak('This will fall back.'), true);
    await until(() => f.spoken.length === 1);
    assert.equal(f.spoken[0].text, 'This will fall back.');
    assert.match(els[0].textContent, /Backup voice — Kokoro could not load/);
    assert.doesNotMatch(els[0].textContent, /still loading/);
    assert.equal(v.engineState, 'failed');
  });
});

test('prime-after-enable seam: a reply spoken after voice is enabled is never swallowed', async () => {
  const f = makeFakes();
  const calls = [];
  const v = createVoiceController({
    Recognition: f.FakeRecognition,
    synthesis: f.synthesis,
    Utterance: f.FakeUtterance,
    makeAudioContext: f.makeAudioContext,
    kokoroLoader: async () => fakeEngine(calls),
  });
  // The room primes its seen-set at boot, long before this enable; the
  // controller-side of the seam is that enabling voice and then
  // speaking always reaches an engine.
  assert.equal(v.setVoiceMode(true, { mode: 'voice', onTranscript() {}, onSubmit() {}, onState() {}, onError() {} }), true);
  f.instances[0].onstart();
  assert.equal(v.speak('Fresh reply.', 'claude'), true);
  await until(() => f.sources.length === 1 && f.sources[0].started);
  assert.deepEqual(calls, [{ text: 'Fresh reply.', voice: 'af_bella' }]);
  assert.equal(f.spoken.length, 0, 'the reply was spoken by Kokoro, not swallowed');
  f.sources[0].onended();
});

test('envoy prime pin (H2): speakNewMessages primes on first sight of a stream and never consults voice state', async () => {
  const js = await readFile(new URL('../web/marketing/app/envoy-workspace.js', import.meta.url), 'utf8');
  const start = js.indexOf('function speakNewMessages');
  assert.ok(start !== -1, 'speakNewMessages exists');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.ok(body.includes('if (!spokenPrimed.has(streamId))'), 'the prime is keyed on first sight of the stream');
  assert.ok(!body.includes('voiceKind'), 'priming does not consult the voice kind');
  assert.ok(!body.includes('setVoiceMode'), 'priming does not consult voice enablement');
  assert.ok(!body.includes('voiceMode'), 'priming does not consult the voice toggle');
});

test('mic gate (L1): a new turn opens while a reply waits behind the load; the waiting reply is cancelled, never spoken', async () => {
  const f = makeFakes();
  const calls = [];
  let resolveLoad;
  const kokoroLoader = () => new Promise((res) => { resolveLoad = () => res(fakeEngine(calls)); });
  const v = voiceOn(f, { kokoroLoader });
  assert.equal(f.instances.length, 1);
  assert.equal(v.speak('Hold the mic.'), true);
  f.instances[0].onend(); // recognition turn ends; the loop wants to restart
  // L1 gate: the restart keys on actual playback only, so a reply
  // that is merely waiting behind the load no longer holds the mic.
  await until(() => f.instances.length === 2, 3000);
  assert.equal(f.instances[1].started, true, 'mic reopened while the reply was still waiting behind the load');
  resolveLoad();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 0, 'the waiting reply was cancelled by the new turn before it ever generated');
  assert.equal(f.sources.length, 0, 'the cancelled reply never played');
  assert.equal(f.spoken.length, 0, 'the cancelled reply never fell back to the backup voice');
});

test('speak after a load failure keeps the precise label: "could not load", not "unavailable"', async () => {
  await withStatusDom(async (els) => {
    const f = makeFakes();
    const kokoroLoader = async () => { throw new Error('boom'); };
    const v = voiceOn(f, { kokoroLoader }); // warmup fires at enable; the load rejects fast
    await until(() => v.engineState === 'failed');
    assert.match(els[0].textContent, /Backup voice — Kokoro could not load/);
    assert.equal(v.speak('First reply after the failure.', 'claude'), true); // inside the retry window → backup branch
    await until(() => f.spoken.length === 1);
    assert.equal(f.spoken[0].text, 'First reply after the failure.');
    assert.match(els[0].textContent, /Backup voice — Kokoro could not load/,
      'the speak path must not erase the load-failure wording with the generic one (the owner saw exactly that flip)');
    assert.doesNotMatch(els[0].textContent, /Kokoro unavailable/);
    v.setVoiceMode(false, {});
  });
});

test('D2: turning voice OFF clears the engine status label', async () => {
  await withStatusDom(async (els) => {
    const f = makeFakes();
    const kokoroLoader = async () => { throw new Error('boom'); };
    const v = voiceOn(f, { kokoroLoader });
    await until(() => v.engineState === 'failed');
    assert.notEqual(els[0].textContent, '', 'the label is set while voice is on');
    assert.equal(v.setVoiceMode(false, {}), true);
    assert.equal(els[0].textContent, '', 'voice off must not leave a stale engine status standing');
  });
});

test('lockstep: the app.js inline copy carries the same silence-law machinery as the shared module', async () => {
  const needles = [
    'KOKORO_SPEAK_WAIT_MS = 15000',
    'KOKORO_LOAD_ABANDON_MS = 60000',
    'function kokoroEngineForSpeak',
    'function scheduleKokoroRetry',
    'kokoroBackupWhileLoading',
    'Backup voice — Kokoro still loading',
    "kokoroFallback(item, 'loading')",
    "kokoroFallback(item, 'failed')",
    "const KOKORO_GRAPH_VERSION = '2026-11-09.1'",
    "const KOKORO_LOCAL_URL = `/kokoro-js/kokoro-js@1.2.1.mjs?v=${KOKORO_GRAPH_VERSION}`",
    'async function importKokoro',
    "mod.env.localModelPath = KOKORO_MODEL_PATH",
    "if (kokoroState === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback')",
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle), `shared module has: ${needle}`);
  }
});

// ---------- Speaking proof (speaker-proof bite) ----------
// Troy's ask: a speaker icon on each seat's message that lights while
// that seat's voice is actually playing. The controller owns the
// signal (setSpeakingListener / speakingNow); these tests pin that it
// reflects ACTUAL playback on both engines — lit at playback start,
// cleared at playback end / cancel / voice-off — and never lights for
// dictate mode or text-only replies.

function watchSpeaking(v) {
  const events = [];
  v.setSpeakingListener((info) => events.push(info ? { ...info } : null));
  return events;
}

test('speaking proof: Kokoro road lights at buffer start with seat + ref, clears at onended', async () => {
  const f = makeFakes();
  const calls = [];
  const v = voiceOn(f, { kokoroLoader: async () => fakeEngine(calls) });
  const events = watchSpeaking(v);
  assert.equal(v.speak('Voice check one two three.', 'claude', 'msg-1'), true);
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { seat: 'claude', engine: 'kokoro', ref: 'msg-1' });
  assert.deepEqual(v.speakingNow, { seat: 'claude', engine: 'kokoro', ref: 'msg-1' });
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].started, true, 'the light waits for the buffer source to actually start');
  f.sources[0].onended();
  assert.equal(events.length, 2);
  assert.equal(events[1], null, 'playback end clears the light');
  assert.equal(v.speakingNow, null);
});

test('speaking proof: generation alone never lights the icon (no start, no light)', async () => {
  const f = makeFakes();
  let release;
  const gate = new Promise((r) => { release = r; });
  const engine = { generate: async () => { await gate; return { audio: new Float32Array(240), sampling_rate: 24000 }; } };
  const v = voiceOn(f, { kokoroLoader: async () => engine });
  const events = watchSpeaking(v);
  assert.equal(v.speak('Still being generated.', 'grok', 'msg-2'), true);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(events.length, 0, 'while generate() is still running nothing is playing, so nothing lights');
  release();
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { seat: 'grok', engine: 'kokoro', ref: 'msg-2' });
  f.sources[0].onended();
});

test('speaking proof: backup road lights at utterance speak with seat + ref, clears at onend', async () => {
  const f = makeFakes();
  const v = voiceOn(f, {}); // no loader, no AudioContext in this shell: backup road
  const events = watchSpeaking(v);
  assert.equal(v.speak('Backup voice speaking.', 'gemini', 'msg-3'), true);
  assert.equal(f.spoken.length, 1);
  assert.deepEqual(events, [{ seat: 'gemini', engine: 'backup', ref: 'msg-3' }]);
  f.spoken[0].onend();
  assert.deepEqual(events, [{ seat: 'gemini', engine: 'backup', ref: 'msg-3' }, null]);
  assert.equal(v.speakingNow, null);
});

test('speaking proof: backup chunks of one reply keep the seat across the chain', async () => {
  const f = makeFakes();
  const v = voiceOn(f, {});
  const events = watchSpeaking(v);
  const s1 = `${'Alpha '.repeat(28).trim()}.`;
  const s2 = `${'Bravo '.repeat(28).trim()}.`;
  assert.equal(v.speak(`${s1} ${s2}`, 'mistral', 'msg-4'), true);
  assert.equal(f.spoken.length, 1, 'first chunk is uttered first');
  assert.deepEqual(events.at(-1), { seat: 'mistral', engine: 'backup', ref: 'msg-4' });
  f.spoken[0].onend();
  assert.equal(f.spoken.length, 2, 'the chain advances to the second chunk');
  assert.deepEqual(events.at(-1), { seat: 'mistral', engine: 'backup', ref: 'msg-4' }, 'second chunk is the same seat + message');
  f.spoken[1].onend();
  assert.equal(events.at(-1), null);
  assert.equal(v.speakingNow, null);
});

test('speaking proof: a Kokoro generate failure hands the light to the backup with the same seat + ref', async () => {
  const f = makeFakes();
  const engine = { generate: async () => { throw new Error('generate broke'); } };
  const v = voiceOn(f, { kokoroLoader: async () => engine });
  const events = watchSpeaking(v);
  assert.equal(v.speak('This will fall back.', 'chatgpt', 'msg-5'), true);
  await until(() => f.spoken.length === 1);
  assert.deepEqual(events, [{ seat: 'chatgpt', engine: 'backup', ref: 'msg-5' }], 'the fallback utterance carries the Kokoro item’s seat + ref');
  f.spoken[0].onend();
  assert.equal(events.at(-1), null);
});

test('speaking proof: cancel and voice-off both clear the light', async () => {
  const f = makeFakes();
  const calls = [];
  const v = voiceOn(f, { kokoroLoader: async () => fakeEngine(calls) });
  const events = watchSpeaking(v);
  v.speak('First reply.', 'claude', 'msg-6');
  await until(() => events.length === 1 && events[0] !== null);
  v.cancelSpeech();
  assert.equal(events.at(-1), null, 'cancel clears the light');
  assert.equal(v.speakingNow, null);
  v.speak('Second reply.', 'grok', 'msg-7');
  await until(() => events.filter(Boolean).length === 2);
  assert.equal(v.setVoiceMode(false, {}), true);
  assert.equal(events.at(-1), null, 'turning voice off clears the light');
  assert.equal(v.speakingNow, null);
});

test('speaking proof: dictate mode and voice-off never light, never speak', async () => {
  const f = makeFakes();
  const v = createVoiceController({
    Recognition: f.FakeRecognition,
    synthesis: f.synthesis,
    Utterance: f.FakeUtterance,
    makeAudioContext: f.makeAudioContext,
    kokoroLoader: async () => fakeEngine([]),
  });
  const events = watchSpeaking(v);
  assert.equal(v.speak('Nobody is listening.', 'claude', 'msg-8'), false, 'voice off: no speak');
  assert.equal(v.setVoiceMode(true, { mode: 'dictate', onTranscript() {}, onSubmit() {}, onState() {}, onError() {} }), true);
  f.instances[0].onstart();
  assert.equal(v.speak('Dictated, not spoken.', 'claude', 'msg-8'), false, 'dictate mode never speaks');
  assert.equal(events.length, 0);
  assert.equal(f.spoken.length, 0);
  assert.equal(v.speakingNow, null);
});

test('lockstep: the app.js inline copy carries the same speaking-proof machinery as the shared module', async () => {
  const needles = [
    'function noteSpeaking(seat, engine, ref, source)',
    'function clearSpeaking(source)',
    'function setSpeakingListener(fn)',
    "noteSpeaking(item.seat, 'kokoro', item.ref, src)",
    "noteSpeaking(item.seat, 'backup', item.ref, utter)",
    'clearSpeaking(src)',
    'seat: seat ?? null, ref: ref ?? null',
    'synthEngine.enqueue(entries, { interrupt: false })',
    'get speakingNow() { return speakingNow; }',
    'speak(text, seat, ref)',
    'voice.setSpeakingListener',
    'voiceSpeak: (text, seat, ref)',
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles.slice(0, 10)) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle), `shared module has: ${needle}`);
  }
  for (const needle of needles.slice(10)) {
    assert.ok(appJs.includes(needle), `app.js wiring has: ${needle}`);
  }
});
