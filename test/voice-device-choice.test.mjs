// Voice device-choice bite — tests for the WASM-only Kokoro load
// (loadKokoroEngine in web/shared/voice-dictation.mjs, mirrored into
// the app.js inline copy). History: the loader used to probe the GPU
// adapter and try WebGPU first (the adapter-first bite). That road
// is the "sounds like Chinese" break: on the vendored runtime
// versions (onnxruntime-web 1.22 + transformers.js 3.8.1) the q8
// model on WebGPU loads fine and then silently computes garbage —
// right length, right engine label, unintelligible tonal mush
// (published measurements on this model + runtime; heard live in
// Troy's own tab, 2026-11-08; full evidence in the kokoro-chinese
// findings). The vocoder bug was also measured at fp32, so no dtype
// swap rescues WebGPU, and every clean proof ran q8 on WASM. These
// tests pin the fix: the engine is requested on WASM always — even
// with a GPU adapter in hand, the adapter is never even probed, and
// no WebGPU attempt exists anywhere in either copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadKokoroEngine, KOKORO_MODEL } from '../web/shared/voice-dictation.mjs';

// A KokoroTTS-like module that records every from_pretrained call.
function fakeMod(calls) {
  return {
    KokoroTTS: {
      from_pretrained: async (model, opts) => {
        calls.push({ model, ...opts });
        return { device: opts.device };
      },
    },
  };
}

function stubNavigator(value) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  return () => {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete globalThis.navigator;
  };
}

// A navigator whose GPU hands back the given adapter ({} = a real
// adapter in hand, null = none), counting probes. Under the WASM-only
// loader the probe count must stay at zero in every case: the device
// decision the probe served no longer exists.
function gpuReturning(adapter, probes) {
  return {
    gpu: {
      requestAdapter: async () => { probes.push(1); return adapter; },
    },
  };
}

const WASM_ONLY = [{ model: KOKORO_MODEL, dtype: 'q8', device: 'wasm' }];

test('adapter in hand: the engine is STILL requested on WASM, and the adapter is never probed', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning({ limits: {} }, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 0, 'no adapter probe — there is no device decision left to feed one');
    assert.deepEqual(calls, WASM_ONLY, 'the only from_pretrained call is q8 on WASM, adapter or no adapter');
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('adapter null: WASM, unprobed', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning(null, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 0);
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('requestAdapter throws: the loader never touches it — WASM carries the load', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator({
    gpu: {
      requestAdapter() { probes.push(1); throw new Error('gpu blocked'); },
    },
  });
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 0, 'a throwing requestAdapter cannot matter — it is never called');
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('requestAdapter rejects: the loader never touches it — WASM carries the load', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator({
    gpu: {
      requestAdapter: async () => { probes.push(1); throw new Error('adapter denied'); },
    },
  });
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 0);
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('no WebGPU API at all: WASM', async () => {
  const calls = [];
  const restore = stubNavigator({}); // a navigator with no gpu property
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('no navigator at all: WASM', async () => {
  const calls = [];
  const restore = stubNavigator(undefined);
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('lockstep: both copies load WASM-only, and the WebGPU road is gone from both', async () => {
  const needles = [
    'async function loadKokoroEngine',
    "device: 'wasm'",
    'loadKokoroEngine(mod)',
  ];
  const gone = [
    "device: 'webgpu'",
    'requestAdapter',
    'kokoroPreferWasm',
    'preferWasm',
    'kokoroAdapterInHand',
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle), `shared module has: ${needle}`);
  }
  for (const needle of gone) {
    assert.ok(!appJs.includes(needle), `app.js inline copy no longer carries: ${needle}`);
    assert.ok(!shared.includes(needle), `shared module no longer carries: ${needle}`);
  }
});
