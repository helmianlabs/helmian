// The opt-in findings upload, run against a Chrome-like storage stand-in.
//
// WHY THIS TEST EXISTS. Up to 0.2.3, upload.js called storage.get([keys]) and
// storage.set({patch}) — the raw chrome.storage.local shape — but the worker
// hands it the ledger wrapper (chromeStorage()), whose get(key)/set(key, value)
// take ONE key. Every read came back undefined and the upload threw. Unit tests
// with a plain object never noticed, so this test puts a stand-in that behaves
// like chrome.storage.local (async, bag-shaped results) underneath the REAL
// chromeStorage() wrapper and drives the real upload code through it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chromeStorage, appendEntry, makeEntry, LEDGER_KEY } from '../background/ledger.js';
import {
  UPLOAD_CURSOR_KEY,
  UPLOAD_ENABLED_KEY,
  UPLOAD_ENDPOINT,
  UPLOAD_TOKEN_KEY,
  getUploadSettings,
  setUploadSettings,
  uploadNewFindings,
} from '../background/upload.js';

/** chrome.storage.local look-alike: get(string|string[]|null) -> bag, set(bag), remove(string|string[]). */
function chromeLikeLocal(seed = {}) {
  const data = structuredClone(seed);
  const calls = [];
  const pick = (keys) => {
    if (keys == null) return structuredClone(data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const key of list) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
    return out;
  };
  return {
    data,
    calls,
    async get(keys) { calls.push(['get', keys]); return pick(keys); },
    async set(items) {
      calls.push(['set', items]);
      if (!items || typeof items !== 'object' || Array.isArray(items)) throw new TypeError('set expects an object');
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      calls.push(['remove', keys]);
      for (const key of [].concat(keys)) delete data[key];
    },
  };
}

function installChrome(local) {
  globalThis.chrome = { storage: { local } };
}

function mockFetch(responses) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const status = responses.length ? responses.shift() : 200;
    return { ok: status >= 200 && status < 300, status };
  };
  return seen;
}

function entry(i) {
  return makeEntry({ kind: 'destructive-command', site: 'chat.example', matched: 'rm -rf', text: `rm -rf /tmp/${i}` });
}

test('upload is skipped (not thrown) when the user never opted in', async () => {
  installChrome(chromeLikeLocal());
  const seen = mockFetch([]);
  const result = await uploadNewFindings(chromeStorage());
  assert.deepEqual(result, { ok: true, skipped: 'not-enabled' });
  assert.equal(seen.length, 0);
});

test('settings round-trip through the real chromeStorage() wrapper', async () => {
  const local = chromeLikeLocal();
  installChrome(local);
  const storage = chromeStorage();
  assert.deepEqual(await getUploadSettings(storage), { enabled: false, hasToken: false });
  const saved = await setUploadSettings(storage, { enabled: true, deviceToken: '  dev-token-1  ' });
  assert.deepEqual(saved, { enabled: true, hasToken: true });
  assert.equal(local.data[UPLOAD_ENABLED_KEY], true);
  assert.equal(local.data[UPLOAD_TOKEN_KEY], 'dev-token-1');
  assert.equal(local.data[UPLOAD_CURSOR_KEY], 0);
});

test('enabled upload posts pending findings, advances the cursor, and is idempotent', async () => {
  const local = chromeLikeLocal();
  installChrome(local);
  const storage = chromeStorage();
  for (let i = 0; i < 3; i++) await appendEntry(storage, entry(i));
  await setUploadSettings(storage, { enabled: true, deviceToken: 'dev-token-2' });
  const seen = mockFetch([200]);

  const first = await uploadNewFindings(storage);
  assert.deepEqual(first, { ok: true, uploaded: 3, remaining: 0 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, UPLOAD_ENDPOINT);
  assert.equal(seen[0].init.headers.authorization, 'Bearer dev-token-2');
  assert.equal(seen[0].body.findings.length, 3);
  assert.equal(seen[0].body.findings[0].source, 'browser-extension');
  assert.equal(local.data[UPLOAD_CURSOR_KEY], 3);
  assert.ok(Array.isArray(local.data[LEDGER_KEY]));

  const second = await uploadNewFindings(storage);
  assert.deepEqual(second, { ok: true, uploaded: 0 });
  assert.equal(seen.length, 1, 'nothing re-sent');
});

test('an auth failure leaves the cursor alone so nothing is lost', async () => {
  const local = chromeLikeLocal();
  installChrome(local);
  const storage = chromeStorage();
  await appendEntry(storage, entry(9));
  await setUploadSettings(storage, { enabled: true, deviceToken: 'bad-token' });
  const seen = mockFetch([401]);
  const result = await uploadNewFindings(storage);
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.equal(seen.length, 1, '401 is not retried');
  assert.equal(local.data[UPLOAD_CURSOR_KEY], 0);
});

test('every storage call uses the shapes chrome.storage.local accepts', async () => {
  const local = chromeLikeLocal();
  installChrome(local);
  const storage = chromeStorage();
  await appendEntry(storage, entry(1));
  await setUploadSettings(storage, { enabled: true, deviceToken: 't' });
  mockFetch([200]);
  await uploadNewFindings(storage);
  for (const [op, arg] of local.calls) {
    if (op === 'set') assert.equal(typeof arg, 'object');
    if (op === 'get') assert.equal(typeof arg, 'string', `get called with ${JSON.stringify(arg)}`);
  }
});
