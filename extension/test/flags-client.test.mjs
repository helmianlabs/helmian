// Flags client against a mock of Paul's Flags API (docs/FLAGS_API.md on the
// shared-memory-mcp saas branch). See test-support/mock-flags-api.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_KEY, READ_ONLY_KEY, memoryStorage, startMockFlagsApi, SERVER_ONLY_SAMPLE } from '../test-support/mock-flags-api.mjs';
import {
  FLAGS_QUEUE_KEY, FLAGS_SETTINGS_KEY, LEGACY_QUEUE_KEY, MAX_QUEUE, SCAN_MAX_CHARS,
  classify, flushQueue, getFlagsSettings, isValidApiKey, markAlertsSeen, pollAlerts,
  reportFlag, safePageUrl, scanText, setFlagsSettings, sourceAiFor, toReportBody,
} from '../background/flags-client.js';

const FLAG = {
  id: 'flag-1', kind: 'privacy-leak', severity: 'high', rule: 'secret:api_key', signals: ['secret:api_key'],
  label: 'The reply shows an API key', site: 'chatgpt.com', lane: 'prose', excerpt: 'Your key is [REDACTED:api_key]',
  url: 'https://chatgpt.com/c/abc123?model=x#frag',
};
const DOCUMENTED_FIELDS = ['severity', 'category', 'reason', 'source_ai', 'excerpt', 'url', 'rule', 'reporter', 'context'];

async function withApi(fn, opts) {
  const api = await startMockFlagsApi(opts);
  try { await fn(api); } finally { await api.close(); }
}
async function enabled(api, extra = {}) {
  const storage = memoryStorage();
  await setFlagsSettings(storage, { enabled: true, baseUrl: api.url, apiKey: MOCK_KEY, ...extra });
  return storage;
}

// Captures console output so a test can prove the key is never logged.
function captureConsole() {
  const lines = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[m] = console[m];
    console[m] = (...args) => { lines.push(args.map(String).join(' ')); };
  }
  return { lines, restore: () => Object.assign(console, saved) };
}

test('OFF BY DEFAULT: no request, nothing queued, scan and alerts do nothing', async () => withApi(async (api) => {
  const storage = memoryStorage();
  assert.deepEqual(await reportFlag(storage, FLAG), { ok: true, skipped: 'not-enabled' });
  assert.equal((await scanText(storage, 'hello')).skipped, 'not-enabled');
  assert.equal((await pollAlerts(storage)).skipped, 'not-enabled');
  assert.equal(api.requests.length, 0);
  const s = await getFlagsSettings(storage);
  assert.equal(s.enabled, false);
  assert.equal(s.scanBeforeSend, false);
  assert.equal(s.queued, 0);
}));

test('API key: must be smk_…, is never returned by getFlagsSettings, and saving a new one clears a rejection', async () => {
  const storage = memoryStorage();
  assert.equal(isValidApiKey(MOCK_KEY), true);
  assert.equal(isValidApiKey('flags-token-aaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(isValidApiKey('smk_short'), false);
  await assert.rejects(setFlagsSettings(storage, { apiKey: 'Bearer smk_abc' }), /start with smk_/);
  const saved = await setFlagsSettings(storage, { enabled: true, baseUrl: 'https://memory.example.com/', apiKey: `  ${MOCK_KEY}  ` });
  assert.equal(saved.hasKey, true);
  assert.equal(saved.baseUrl, 'https://memory.example.com');
  assert.doesNotMatch(JSON.stringify(saved), /smk_/);
  // An empty key field on save keeps the stored key.
  await setFlagsSettings(storage, { apiKey: '' });
  assert.equal((await storage.get(FLAGS_SETTINGS_KEY)).apiKey, MOCK_KEY);
  await assert.rejects(setFlagsSettings(storage, { baseUrl: 'http://memory.example.com' }), /https/);
  await assert.rejects(setFlagsSettings(storage, { dailyBudget: 0 }), /budget/);
});

test('report: exactly one POST /api/flags per flag with Bearer smk_ key and only documented fields', async () => withApi(async (api) => {
  const storage = await enabled(api);
  const result = await reportFlag(storage, FLAG, { version: '0.4.0', browser: 'chrome' });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.equal(api.requests.length, 1);
  const req = api.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/flags');
  assert.equal(req.headers.authorization, `Bearer ${MOCK_KEY}`);
  assert.match(req.headers['content-type'], /application\/json/);
  assert.equal(req.headers.cookie, undefined);
  for (const key of Object.keys(req.body)) assert.ok(DOCUMENTED_FIELDS.includes(key), `undocumented field ${key}`);
  assert.deepEqual(req.body, {
    severity: 'high', category: 'secret', reason: 'The reply shows an API key', source_ai: 'chatgpt',
    rule: 'guard.privacy-leak.secret:api_key', reporter: 'guard-extension/0.4.0',
    context: { guard_flag_id: 'flag-1', lane: 'prose', browser: 'chrome' },
    excerpt: 'Your key is [REDACTED:api_key]', url: 'https://chatgpt.com/c/abc123',
  });
  assert.equal(api.flags[0].reporter, 'key:Guard extension (guard-extension/0.4.0)');
  assert.equal((await getFlagsSettings(storage)).queued, 0);
}));

test('category and severity follow the API vocabulary', () => {
  const cases = [
    [{ kind: 'evasion', rule: 'hedging' }, 'hedging', 'low'],
    [{ kind: 'harmful-code', rule: 'reverse-shell' }, 'harmful_code', 'critical'],
    [{ kind: 'harmful-code', rule: 'crypto-miner' }, 'harmful_code', 'high'],
    [{ kind: 'privacy-leak', rule: 'secret:private_key' }, 'secret', 'critical'],
    [{ kind: 'privacy-leak', rule: 'secret:bearer_token,pii:email' }, 'secret', 'high'],
    [{ kind: 'privacy-leak', rule: 'secret:credit_card' }, 'pii', 'high'],
    [{ kind: 'privacy-leak', rule: 'pii:ssn' }, 'pii', 'high'],
    [{ kind: 'privacy-leak', rule: 'pii:email,pii:phone' }, 'privacy', 'medium'],
  ];
  for (const [flag, category, severity] of cases) assert.deepEqual(classify(flag), { category, severity }, JSON.stringify(flag));
});

test('source_ai uses the checklist names; url keeps origin + path only, and only on the chat sites', () => {
  assert.equal(sourceAiFor('claude.ai'), 'claude.ai');
  assert.equal(sourceAiFor('chatgpt.com'), 'chatgpt');
  assert.equal(sourceAiFor('gemini.google.com'), 'gemini');
  assert.equal(sourceAiFor('grok.com'), 'grok');
  assert.equal(safePageUrl('https://claude.ai/chat/1?x=1#y'), 'https://claude.ai/chat/1');
  assert.equal(safePageUrl('https://evil.example/c/1'), undefined);
  assert.equal(safePageUrl('http://chatgpt.com/c/1'), undefined);
  const body = toReportBody({ kind: 'evasion', rule: 'x'.repeat(200), label: 'no', site: 'grok.com' });
  assert.equal(body.rule.length, 80);
  assert.ok(body.reason.length >= 3 && body.reason.length <= 1000);
  assert.equal(body.url, undefined);
  assert.equal(toReportBody({ kind: 'nope' }), null);
});

test('NEVER A RAW SECRET: excerpt and reason are redacted again before they leave', async () => withApi(async (api) => {
  const storage = await enabled(api);
  await reportFlag(storage, { ...FLAG, label: 'saw sk-proj-abcdefghijklmnop1234', excerpt: 'leaked sk-proj-abcdefghijklmnop1234 and bob@gmail.com' });
  const sent = api.requests[0].raw;
  assert.doesNotMatch(sent, /abcdefghijklmnop1234|bob@gmail\.com/);
  assert.match(sent, /\[REDACTED:api_key\]/);
}));

test('whsec_ is now redacted locally, before the server ever sees it', async () => withApi(async (api) => {
  const storage = await enabled(api);
  await reportFlag(storage, { ...FLAG, excerpt: 'secret whsec_' + 'B'.repeat(24) });
  assert.doesNotMatch(api.requests.at(-1).raw, /whsec_B/);
  assert.match(api.flags[0].excerpt, /\[REDACTED:api_key\]/);
}));

test('the server scan of the excerpt can add flags; the client reports them back', async () => withApi(async (api) => {
  const storage = await enabled(api);
  // A token format only the (mock) server knows: Guard cannot redact it, the server does.
  const result = await reportFlag(storage, { ...FLAG, excerpt: `secret ${SERVER_ONLY_SAMPLE}` });
  assert.equal(result.ok, true);
  assert.deepEqual(result.serverFlags, [{ category: 'secret', rule: 'secret.server_only_test_token', severity: 'high' }]);
  assert.match(api.flags[0].excerpt, /\[REDACTED:server_only_test_token\]/);
}));

test('401: key marked rejected, queue kept, nothing more sent until a new key is saved', async () => withApi(async (api) => {
  const storage = await enabled(api);
  api.state.revoked.add(MOCK_KEY);
  const first = await reportFlag(storage, FLAG);
  assert.equal(first.ok, false);
  assert.equal(first.stopped, 'key-rejected');
  assert.equal(first.queued, 1);
  assert.equal((await getFlagsSettings(storage)).keyRejected, true);
  await reportFlag(storage, { ...FLAG, id: 'flag-2' });
  assert.equal(api.requests.length, 1, 'no second call with a rejected key');
  api.state.revoked.delete(MOCK_KEY);
  await setFlagsSettings(storage, { apiKey: MOCK_KEY });
  const after = await flushQueue(storage);
  assert.equal(after.sent, 2);
}));

test('401 for a read-only key on report (missing flags.write scope)', async () => withApi(async (api) => {
  const storage = await enabled(api, { apiKey: READ_ONLY_KEY });
  const r = await reportFlag(storage, FLAG);
  assert.equal(r.stopped, 'key-rejected');
}));

test('402: paused until the next UTC day, queue kept, no calls while paused', async () => withApi(async (api) => {
  const storage = await enabled(api);
  const now = Date.parse('2026-10-22T15:00:00Z');
  const r = await reportFlag(storage, FLAG, { now });
  assert.equal(r.stopped, 'daily-limit');
  assert.equal(r.queued, 1);
  assert.equal((await getFlagsSettings(storage, { now })).pausedUntil, '2026-10-23T00:00:00.000Z');
  await reportFlag(storage, { ...FLAG, id: 'flag-2' }, { now: now + 1000 });
  assert.equal(api.requests.length, 1);
  api.state.callsPerDay = 1000;
  const next = await flushQueue(storage, { now: Date.parse('2026-10-23T00:00:01Z') });
  assert.equal(next.sent, 2);
}, { callsPerDay: 0 }));

test('400: that one flag is dropped, the rest still go', async () => withApi(async (api) => {
  const storage = await enabled(api);
  // A body the server rejects (bad severity), queued by an older build.
  await storage.set(FLAGS_QUEUE_KEY, [{ severity: 'notice', category: 'secret', reason: 'old' }]);
  const r = await reportFlag(storage, FLAG);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(r.queued, 0);
  assert.equal(api.requests.length, 2);
}));

test('5xx / unreachable: queued, retried in order, one request per flag, capped queue', async () => withApi(async (api) => {
  const storage = await enabled(api);
  api.state.failWith = 503;
  const failed = await reportFlag(storage, FLAG);
  assert.equal(failed.ok, false);
  assert.equal(failed.stopped, 'http-503');
  api.state.failWith = null;
  const next = await reportFlag(storage, { ...FLAG, id: 'flag-2' });
  assert.equal(next.sent, 2);
  assert.deepEqual(api.requests.slice(-2).map((r) => r.body.context.guard_flag_id), ['flag-1', 'flag-2']);

  const down = memoryStorage();
  await setFlagsSettings(down, { enabled: true, baseUrl: 'http://127.0.0.1:9', apiKey: MOCK_KEY, dailyBudget: 100000 });
  const unreachable = await reportFlag(down, FLAG);
  assert.equal(unreachable.stopped, 'network');
  const many = Array.from({ length: MAX_QUEUE + 5 }, (_, i) => ({ reason: `q${i}` }));
  await down.set(FLAGS_QUEUE_KEY, many);
  await reportFlag(down, { ...FLAG, id: 'last' });
  assert.equal((await down.get(FLAGS_QUEUE_KEY)).length, MAX_QUEUE);
}));

test('local daily budget: stops calling at the budget (calls shared by report, scan and alerts)', async () => withApi(async (api) => {
  const storage = await enabled(api, { dailyBudget: 2, scanBeforeSend: true });
  await reportFlag(storage, FLAG);
  await scanText(storage, 'hello there');
  const third = await reportFlag(storage, { ...FLAG, id: 'flag-3' });
  assert.equal(third.stopped, 'budget');
  assert.equal((await scanText(storage, 'again')).skipped, 'budget');
  assert.equal(api.requests.length, 2);
  assert.equal((await getFlagsSettings(storage)).callsToday, 2);
}));

test('scan: POST /api/flags/scan {text}, stores nothing, returns leaks; off unless scanBeforeSend', async () => withApi(async (api) => {
  const off = await enabled(api);
  assert.equal((await scanText(off, 'x')).skipped, 'not-enabled');
  const storage = await enabled(api, { scanBeforeSend: true });
  const r = await scanText(storage, `use ${SERVER_ONLY_SAMPLE} then rm -rf / now`);
  const req = api.requests.at(-1);
  assert.equal(req.path, '/api/flags/scan');
  assert.deepEqual(Object.keys(req.body), ['text']);
  assert.equal(r.ok, true);
  assert.equal(r.redactions, 1);
  assert.match(r.redacted, /\[REDACTED:server_only_test_token\]/);
  assert.deepEqual(r.leaks.map((l) => l.rule), ['secret.server_only_test_token']);
  assert.ok(r.findings.some((f) => f.category === 'harmful_code'));
  assert.equal(api.flags.length, 0, 'scan stored nothing');
}));

test('scan: text is redacted locally before it is sent; too long and slow answers are skipped', async () => withApi(async (api) => {
  const storage = await enabled(api, { scanBeforeSend: true });
  await scanText(storage, 'my key sk-proj-abcdefghijklmnop1234, card 4242 4242 4242 4242');
  assert.doesNotMatch(api.requests.at(-1).raw, /abcdefghijklmnop1234|4242 4242/);
  const before = api.requests.length;
  assert.equal((await scanText(storage, 'a'.repeat(SCAN_MAX_CHARS + 1))).skipped, 'too-long');
  assert.equal(api.requests.length, before);
  api.state.delayMs = 3000;
  const slow = await scanText(storage, 'hello');
  assert.equal(slow.ok, false);
  assert.equal(slow.skipped, 'network');
}));

test('alerts: GET /api/flags?min_severity=high, then since=<newest created_at>; merged by id; throttled', async () => withApi(async (api) => {
  const storage = await enabled(api);
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  await reportFlag(storage, { ...FLAG, excerpt: `secret ${SERVER_ONLY_SAMPLE}` }, { now: t0 });
  await reportFlag(storage, { kind: 'evasion', rule: 'hedging', label: 'Hedges', site: 'grok.com', id: 'low-1' }, { now: t0 });
  const first = await pollAlerts(storage, { now: t0 });
  const q1 = api.requests.at(-1);
  assert.equal(q1.path, '/api/flags');
  assert.equal(q1.query.min_severity, 'high');
  assert.equal(q1.query.since, undefined);
  assert.equal(first.alerts.length, 2, 'reported secret + server scanner flag; the low hedging flag is excluded');
  assert.equal(first.unseen, 2);
  const cached = await pollAlerts(storage, { now: t0 + 1000 });
  assert.equal(cached.cached, true);
  const calls = api.requests.length;
  const again = await pollAlerts(storage, { now: t0 + 61000 });
  assert.equal(api.requests.length, calls + 1);
  assert.equal(api.requests.at(-1).query.since, first.alerts.map((a) => a.created_at).sort().at(-1));
  assert.equal(again.alerts.length, 2, 'inclusive since does not duplicate');
  await markAlertsSeen(storage);
  assert.equal((await pollAlerts(storage, { now: t0 + 62000 })).unseen, 0);
}));

test('KEY NEVER LOGGED: no console output contains the key on success or any failure path', async () => withApi(async (api) => {
  const cap = captureConsole();
  try {
    const storage = await enabled(api, { scanBeforeSend: true });
    await reportFlag(storage, FLAG);
    api.state.failWith = 500; await reportFlag(storage, FLAG); await scanText(storage, 'x'); await pollAlerts(storage, { force: true });
    api.state.failWith = null; api.state.revoked.add(MOCK_KEY); await flushQueue(storage);
    const st = JSON.stringify(await getFlagsSettings(storage));
    assert.doesNotMatch(st, /smk_/);
  } finally { cap.restore(); }
  assert.ok(cap.lines.every((l) => !l.includes(MOCK_KEY)));
}));

test('0.3.0 settings for the provisional contract are dropped, never sent', async () => withApi(async (api) => {
  const storage = memoryStorage();
  await storage.set(FLAGS_SETTINGS_KEY, { enabled: true, flagsUrl: api.url, token: 'flags-token-aaaaaaaaaaaaaaaaaaaa' });
  await storage.set(LEGACY_QUEUE_KEY, [{ id: 'old', kind: 'evasion' }]);
  const s = await getFlagsSettings(storage);
  assert.equal(s.enabled, false);
  assert.equal(s.hasKey, false);
  assert.deepEqual(await storage.get(LEGACY_QUEUE_KEY), []);
  await reportFlag(storage, FLAG);
  assert.equal(api.requests.length, 0);
}));
