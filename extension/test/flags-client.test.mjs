// Flags reports against a mock of the (not yet published) Flags API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, startMockFlagsApi } from '../test-support/mock-flags-api.mjs';
import {
  FLAGS_QUEUE_KEY, MAX_QUEUE, getFlagsSettings, reportFlag, setFlagsSettings, toWireFlag,
} from '../background/flags-client.js';

const FLAG = {
  id: 'flag-1', kind: 'privacy-leak', severity: 'high', rule: 'secret:api_key', label: 'The reply shows an API key',
  site: 'chatgpt.com', lane: 'prose', excerpt: 'Your key is [REDACTED:api_key]',
};

test('OFF BY DEFAULT: nothing is sent and nothing queued', async () => {
  const api = await startMockFlagsApi();
  try {
    const storage = memoryStorage();
    assert.deepEqual(await reportFlag(storage, FLAG), { ok: true, skipped: 'not-enabled' });
    assert.equal(api.requests.length, 0);
    assert.equal((await getFlagsSettings(storage)).queued, 0);
  } finally { await api.close(); }
});

test('enabled: one POST /v1/flags with the bearer token and the provisional shape', async () => {
  const api = await startMockFlagsApi();
  try {
    const storage = memoryStorage();
    await setFlagsSettings(storage, { enabled: true, flagsUrl: api.url, token: api.token });
    const result = await reportFlag(storage, FLAG, { version: '0.3.0' });
    assert.equal(result.ok, true);
    assert.equal(api.requests.length, 1);
    const req = api.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/flags');
    assert.equal(req.headers.authorization, `Bearer ${api.token}`);
    const [wire] = req.body.flags;
    assert.deepEqual(Object.keys(wire).sort(), ['detectedAt', 'excerpt', 'id', 'kind', 'label', 'lane', 'rule', 'severity', 'site', 'source', 'sourceVersion']);
    assert.equal(wire.source, 'helmian-guard-extension');
    assert.equal(wire.sourceVersion, '0.3.0');
    assert.equal((await getFlagsSettings(storage)).queued, 0);
  } finally { await api.close(); }
});

test('NEVER A RAW SECRET: an unredacted excerpt is redacted again before it leaves', async () => {
  const api = await startMockFlagsApi();
  try {
    const storage = memoryStorage();
    await setFlagsSettings(storage, { enabled: true, flagsUrl: api.url, token: api.token });
    await reportFlag(storage, { ...FLAG, excerpt: 'leaked sk-proj-abcdefghijklmnop1234 and bob@gmail.com' });
    const sent = JSON.stringify(api.requests[0].body);
    assert.doesNotMatch(sent, /abcdefghijklmnop1234|bob@gmail\.com/);
    assert.match(sent, /\[REDACTED:api_key\]/);
  } finally { await api.close(); }
});

test('a failed report is queued and goes out with the next one', async () => {
  const api = await startMockFlagsApi({ status: 503 });
  try {
    const storage = memoryStorage();
    await setFlagsSettings(storage, { enabled: true, flagsUrl: api.url, token: api.token });
    const failed = await reportFlag(storage, FLAG);
    assert.equal(failed.ok, false);
    assert.equal(failed.queued, 1);
    api.state.status = 200;
    const next = await reportFlag(storage, { ...FLAG, id: 'flag-2' });
    assert.equal(next.ok, true);
    assert.equal(next.sent, 2);
    assert.deepEqual(api.requests.at(-1).body.flags.map((f) => f.id), ['flag-1', 'flag-2']);
  } finally { await api.close(); }
});

test('a bad token is reported as fatal', async () => {
  const api = await startMockFlagsApi();
  try {
    const storage = memoryStorage();
    await setFlagsSettings(storage, { enabled: true, flagsUrl: api.url, token: 'wrong-token-zzzzzzzzzzzzzzzz' });
    const result = await reportFlag(storage, FLAG);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.fatal, true);
  } finally { await api.close(); }
});

test('an unreachable API never throws; the queue is capped', async () => {
  const storage = memoryStorage();
  await setFlagsSettings(storage, { enabled: true, flagsUrl: 'http://127.0.0.1:9', token: 'x'.repeat(30) });
  const big = Array.from({ length: MAX_QUEUE + 5 }, (_, i) => ({ ...FLAG, id: `f${i}`, excerpt: 'x', kind: 'evasion' }));
  await storage.set(FLAGS_QUEUE_KEY, big.map((f) => toWireFlag(f)));
  const result = await reportFlag(storage, { ...FLAG, id: 'newest' });
  assert.equal(result.ok, false);
  assert.equal((await storage.get(FLAGS_QUEUE_KEY)).length, MAX_QUEUE);
  assert.equal((await storage.get(FLAGS_QUEUE_KEY)).at(-1).id, 'newest');
});

test('malformed flags and bad URLs are refused', async () => {
  assert.equal(toWireFlag({ kind: 'gossip' }), null);
  const storage = memoryStorage();
  await assert.rejects(setFlagsSettings(storage, { flagsUrl: 'http://flags.example' }), /https/);
  await setFlagsSettings(storage, { enabled: true, flagsUrl: 'https://flags.example', token: 't'.repeat(30) });
  assert.deepEqual(await reportFlag(storage, { kind: 'gossip' }), { ok: false, error: 'malformed flag' });
});

test('the settings view never includes the token', async () => {
  const storage = memoryStorage();
  const view = await setFlagsSettings(storage, { enabled: true, flagsUrl: 'https://flags.example', token: 'secret-token-123456789012345' });
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
  assert.equal(view.hasToken, true);
});
