// Voice device-choice bite — tests for the adapter-first Kokoro load
// (loadKokoroEngine in web/shared/voice-dictation.mjs, mirrored into
// the app.js inline copy). The shipped device order — WebGPU whenever
// navigator.gpu exists — is the live load-stage break: where the API
// exists but requestAdapter() returns null, the WebGPU from_pretrained
// fails with "no available backend found" and poisons the follow-on
// WASM attempt, which fails instantly with the same WebGPU error
// (proven live in the real room browser, 2026-11-08). These tests pin
// the fix: the adapter is probed BEFORE any from_pretrained call,
// WebGPU is attempted only with an adapter in hand, and every other
// outcome goes straight to WASM with WebGPU never attempted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadKokoroEngine, KOKORO_MODEL } from '../web/shared/voice-dictation.mjs';

// A KokoroTTS-like module that records every from_pretrained call.
function fakeMod(calls, { webgpuFails = false } = {}) {
  return {
    KokoroTTS: {
      from_pretrained: async (model, opts) => {
        calls.push({ model, ...opts });
        if (webgpuFails && opts.device === 'webgpu') throw new Error('webgpu session died');
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
// adapter in hand, null = the live failure state), counting probes.
function gpuReturning(adapter, probes) {
  return {
    gpu: {
      requestAdapter: async () => { probes.push(1); return adapter; },
    },
  };
}

const WASM_ONLY = [{ model: KOKORO_MODEL, dtype: 'q8', device: 'wasm' }];

test('adapter granted: the probe runs once and WebGPU is attempted first', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning({ limits: {} }, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 1, 'the adapter was probed exactly once');
    assert.deepEqual(calls, [{ model: KOKORO_MODEL, dtype: 'q8', device: 'webgpu' }]);
    assert.equal(engine.device, 'webgpu');
  } finally { restore(); }
});

test('adapter null: straight to WASM — WebGPU is never attempted', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning(null, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 1, 'the adapter was probed');
    assert.deepEqual(calls, WASM_ONLY, 'the only from_pretrained call is the WASM one — no doomed WebGPU attempt to poison it');
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('requestAdapter throws: straight to WASM', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator({
    gpu: {
      requestAdapter() { probes.push(1); throw new Error('gpu blocked'); },
    },
  });
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 1);
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('requestAdapter rejects: straight to WASM', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator({
    gpu: {
      requestAdapter: async () => { probes.push(1); throw new Error('adapter denied'); },
    },
  });
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.equal(probes.length, 1);
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('requestAdapter hangs past the probe bound: straight to WASM', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator({
    gpu: {
      requestAdapter: () => { probes.push(1); return new Promise(() => {}); },
    },
  });
  try {
    const engine = await loadKokoroEngine(fakeMod(calls), { probeMs: 40 });
    assert.equal(probes.length, 1, 'the probe was started');
    assert.deepEqual(calls, WASM_ONLY, 'the hung probe could not stall the load — WASM carried it');
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('preferWasm (a load was abandoned as stuck): WASM without probing at all', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning({ limits: {} }, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls), { preferWasm: true });
    assert.equal(probes.length, 0, 'the probe never runs when WASM is preferred');
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('no WebGPU API at all: straight to WASM', async () => {
  const calls = [];
  const restore = stubNavigator({}); // a navigator with no gpu property
  try {
    const engine = await loadKokoroEngine(fakeMod(calls));
    assert.deepEqual(calls, WASM_ONLY);
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('adapter granted but the WebGPU load itself fails: the WASM catch-fallback still carries the load', async () => {
  const calls = [];
  const probes = [];
  const restore = stubNavigator(gpuReturning({ limits: {} }, probes));
  try {
    const engine = await loadKokoroEngine(fakeMod(calls, { webgpuFails: true }));
    assert.deepEqual(calls, [
      { model: KOKORO_MODEL, dtype: 'q8', device: 'webgpu' },
      { model: KOKORO_MODEL, dtype: 'q8', device: 'wasm' },
    ], 'WebGPU attempted with an adapter in hand, then the kept fallback');
    assert.equal(engine.device, 'wasm');
  } finally { restore(); }
});

test('lockstep: the app.js inline copy carries the same adapter-first device choice as the shared module', async () => {
  const needles = [
    'const KOKORO_ADAPTER_PROBE_MS = 10000',
    'async function kokoroAdapterInHand',
    'gpu.requestAdapter()',
    'async function loadKokoroEngine',
    "device: 'webgpu'",
    "device: 'wasm'",
    'loadKokoroEngine(mod, { preferWasm: kokoroPreferWasm })',
  ];
  const appJs = await readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../web/shared/voice-dictation.mjs', import.meta.url), 'utf8');
  for (const needle of needles) {
    assert.ok(appJs.includes(needle), `app.js inline copy has: ${needle}`);
    assert.ok(shared.includes(needle), `shared module has: ${needle}`);
  }
});
