// The service worker must revalidate the /app shell, never trust a stored
// copy's own freshness. Regression test for the 2026-10-25 invisible
// Maestro seat: the seat code was live and correct, but warm browser
// profiles kept executing the pre-seat envoy-workspace.js because the
// worker's network-first fetch() was satisfied by an HTTP-cache entry
// stored under the old `public, max-age=14400` — an entry whose lifetime
// the later server-side header fix and CDN purge could not shorten.
// These tests EXECUTE the real sw.js under fakes (the seat's earlier
// guard tests only read source text, which is why they passed while the
// seat was invisible). On the pre-fix worker the first test fails: the
// network call goes out with no cache mode, i.e. "default".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const ORIGIN = 'https://helmian.cloud';

async function loadWorker(fetchImpl) {
  const src = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const cacheStore = new Map();
  const cache = {
    addAll: async () => {},
    put: async (req, res) => { cacheStore.set(typeof req === 'string' ? req : req.url, res); },
    match: async (req) => cacheStore.get(typeof req === 'string' ? new URL(req, ORIGIN).href : req.url),
  };
  const caches = {
    open: async () => cache,
    keys: async () => [...cacheStore.keys()],
    delete: async () => true,
    match: async (req) => cache.match(req),
  };
  const self = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const sandbox = { self, caches, fetch: fetchImpl, URL, Promise, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { listeners, cacheStore };
}

function fetchEvent(url, { method = 'GET', mode = 'cors' } = {}) {
  const ev = {
    request: { method, url, mode },
    responded: null,
    respondWith(p) { ev.responded = p; },
  };
  return ev;
}

test('shell fetch revalidates: the worker asks the origin before any stored shell copy is used', async () => {
  const calls = [];
  const okRes = { ok: true, clone() { return this; } };
  const { listeners } = await loadWorker(async (input, init) => { calls.push({ input, init }); return okRes; });
  assert.equal(typeof listeners.fetch, 'function', 'the worker registers a fetch handler');
  const ev = fetchEvent(`${ORIGIN}/app/envoy-workspace.js`);
  listeners.fetch(ev);
  assert.ok(ev.responded, 'the worker answers shell requests');
  const res = await ev.responded;
  assert.equal(res, okRes, 'the network answer is what the page gets');
  assert.equal(calls.length, 1, 'exactly one network call');
  assert.equal(calls[0].init?.cache, 'no-cache',
    "the shell fetch must carry cache: 'no-cache' — without it, a stored entry still inside its own max-age is served without ever asking the origin, and a deploy stays invisible to warm profiles");
});

test('offline fallback survives: a failed network fetch still resolves from the worker cache', async () => {
  const cached = { ok: true, fromCache: true };
  const { listeners, cacheStore } = await loadWorker(async () => { throw new Error('network down'); });
  cacheStore.set(`${ORIGIN}/app/envoy-workspace.js`, cached);
  const ev = fetchEvent(`${ORIGIN}/app/envoy-workspace.js`);
  listeners.fetch(ev);
  const res = await ev.responded;
  assert.equal(res, cached, 'the cached shell is the offline answer');
});

test('the worker never touches API calls', async () => {
  let called = 0;
  const { listeners } = await loadWorker(async () => { called += 1; return { ok: true, clone() { return this; } }; });
  const ev = fetchEvent(`${ORIGIN}/api/admin/envoy/channels`);
  listeners.fetch(ev);
  assert.equal(ev.responded, null, 'no respondWith for /api/');
  assert.equal(called, 0, 'no network call made by the worker');
});

test('stamped shell fetch is cache-first: a stored stamped copy is served with no network call at all', async () => {
  // The companion case (2026-11-09, the shell stamp): a ?v= URL is a
  // content address — the same URL can never name different bytes —
  // so the worker answers from its cache and the origin is never
  // asked. The unstamped pin above is untouched: it is the
  // stale-shell guard, and it still rules every unstamped path.
  const stamped = `${ORIGIN}/app/envoy-workspace.js?v=0123456789abcdef`;
  const cached = { ok: true, fromCache: true };
  let calls = 0;
  const { listeners, cacheStore } = await loadWorker(async () => { calls += 1; return { ok: true, clone() { return this; } }; });
  cacheStore.set(stamped, cached);
  const ev = fetchEvent(stamped);
  listeners.fetch(ev);
  const res = await ev.responded;
  assert.equal(res, cached, 'the stored stamped copy is the answer');
  assert.equal(calls, 0, 'no network call — no revalidation round trip for a content address');
});

test('stamped shell fetch on a cache miss fetches WITHOUT the no-cache revalidation and stores the answer', async () => {
  const stamped = `${ORIGIN}/app/app.js?v=0123456789abcdef`;
  const calls = [];
  const netRes = { ok: true, clone() { return this; } };
  const { listeners, cacheStore } = await loadWorker(async (input, init) => { calls.push({ input, init }); return netRes; });
  const ev = fetchEvent(stamped);
  listeners.fetch(ev);
  const res = await ev.responded;
  assert.equal(res, netRes, 'the network answer is what the page gets');
  assert.equal(calls.length, 1, 'exactly one network call');
  assert.notEqual(calls[0].init?.cache, 'no-cache',
    "a stamped fetch must not carry cache: 'no-cache' — the URL's own immutable Cache-Control is the policy now");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cacheStore.get(stamped), netRes, 'the answer is stored under its exact stamped URL');
});
