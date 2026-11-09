// Voice-silence fix — tests for the bounded-wait law in the staged
// controller (web/shared/voice-dictation.mjs): a Kokoro load that never
// settles can no longer starve the room. Covers: backup speaks after
// the bound (labelled "still loading"), no fresh wait when the load is
// already older than the bound, a stuck load abandoned and retried
// fresh with Kokoro taking over, the failure reason staying distinct
// ("could not load"), the prime-after-enable seam, mic hold-off across
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

test('mic hold-off spans the bounded wait: no new turn while a reply waits, mic resumes after it speaks', async () => {
  const f = makeFakes();
  const calls = [];
  let resolveLoad;
  const kokoroLoader = () => new Promise((res) => { resolveLoad = () => res(fakeEngine(calls)); });
  const v = voiceOn(f, { kokoroLoader });
  assert.equal(f.instances.length, 1);
  assert.equal(v.speak('Hold the mic.'), true);
  f.instances[0].onend(); // recognition turn ends; the loop wants to restart
  await new Promise((r) => setTimeout(r, 500)); // > the 400ms hold poll
  assert.equal(f.instances.length, 1, 'mic held while the reply waits behind the load');
  resolveLoad();
  await until(() => f.sources.length === 1 && f.sources[0].started);
  f.sources[0].onended(); // reply finished; speech drains
  await until(() => f.instances.length === 2, 3000);
  assert.equal(f.instances[1].started, true, 'mic resumed once the reply drained');
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
    'kokoroPreferWasm',
    'Backup voice — Kokoro still loading',
    "kokoroFallback(item, 'loading')",
    "kokoroFallback(item, 'failed')",
    "const KOKORO_LOCAL_URL = '/kokoro-js/kokoro-js@1.2.1.mjs'",
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
