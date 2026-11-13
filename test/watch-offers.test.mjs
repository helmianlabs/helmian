import assert from 'node:assert/strict';
import test from 'node:test';
import { WATCH_OFFER_TTL_MS, handleRunnerPresenceRoute, normalizeWatchOffer } from '../src/cloud/runner-presence.mjs';

// Watch offers (live browser view, Bite 3): the executor's session
// reports, per browser seat, that its browser is open and which
// page it is on; the workspace poll carries the offers to the pane
// as one additive `watch` field beside `presence` and `activity`.
// An offer is device-token speech only — a member session can no
// more claim a watch than it can claim a connection — and it is
// stored apart from the presence rows, so offering a watch never
// moves a connected claim.

const NOW = new Date('2026-11-13T05:00:00.000Z');

test('watch offer: a live page normalizes with a 45 second expiry', () => {
  const offer = normalizeWatchOffer({ url: 'https://chat.mistral.ai/c/abc' }, 'mistral', NOW);
  assert.deepEqual(offer, {
    provider: 'mistral',
    clear: false,
    url: 'https://chat.mistral.ai/c/abc',
    at: '2026-11-13T05:00:00.000Z',
    expiresAt: new Date(NOW.getTime() + WATCH_OFFER_TTL_MS).toISOString(),
  });
});

test('watch offer: an open page that has not navigated yet offers with no address', () => {
  const offer = normalizeWatchOffer({}, 'gemini', NOW);
  assert.equal(offer.clear, false);
  assert.equal(offer.url, null);
});

test('watch offer: null clears, and only browser seats may offer', () => {
  assert.deepEqual(normalizeWatchOffer(null, 'claude', NOW), { provider: 'claude', clear: true, url: null });
  for (const seat of ['qwen', 'groq', 'deepseek', 'mistral-typo', '']) {
    assert.throws(() => normalizeWatchOffer({ url: 'https://a.example/' }, seat, NOW), /watch provider/, seat);
  }
});

test('watch offer: the address must be a short http(s) URL', () => {
  for (const url of ['ftp://a.example/', 'about:blank', 'javascript:alert(1)', `https://a.example/${'x'.repeat(2100)}`, 42]) {
    assert.throws(() => normalizeWatchOffer({ url }, 'mistral', NOW), undefined, String(url).slice(0, 40));
  }
});

function fakeStore(calls) {
  return {
    async list() { return []; },
    async listActivity() { return []; },
    async listWatch() { return [{ provider: 'mistral', url: 'https://chat.mistral.ai/c/1', updatedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30_000).toISOString() }]; },
    async reportWatch(tenantId, rawWatch, fallbackProvider) {
      calls.push({ tenantId, rawWatch, fallbackProvider });
      const offer = normalizeWatchOffer(rawWatch, fallbackProvider, NOW);
      return { ok: true, watch: offer.clear ? { provider: offer.provider, offered: false } : { provider: offer.provider, offered: true, url: offer.url, expiresAt: offer.expiresAt } };
    },
  };
}

async function callRoute({ method = 'GET', body = null, viaDeviceToken = true, store }) {
  const sent = [];
  const handled = await handleRunnerPresenceRoute({
    request: { method },
    response: {},
    requestUrl: new URL('https://helmian.cloud/api/admin/envoy/runner/presence'),
    activeTenantActor: async () => ({ tenantId: 'tenant-1', subject: 'subject-1', viaDeviceToken }),
    send: (response, status, text) => sent.push({ status, body: JSON.parse(text) }),
    TenantAuthorizationError: class TenantAuthorizationError extends Error {},
    readJson: async () => body,
    store,
    profileSyncJobs: { enqueue() {} },
  });
  return { handled, sent };
}

test('watch route: the executor device token posts an offer and a clear', async () => {
  const calls = [];
  const store = fakeStore(calls);
  const set = await callRoute({ method: 'POST', body: { provider: 'mistral', watch: { url: 'https://chat.mistral.ai/c/1' } }, store });
  assert.equal(set.handled, true);
  assert.equal(set.sent[0].status, 200);
  assert.equal(set.sent[0].body.watch.offered, true);
  const clear = await callRoute({ method: 'POST', body: { provider: 'mistral', watch: null }, store });
  assert.equal(clear.sent[0].body.watch.offered, false);
  assert.deepEqual(calls.map((c) => c.tenantId), ['tenant-1', 'tenant-1']);
});

test('watch route: a member session watch write is dropped whole', async () => {
  const calls = [];
  const store = fakeStore(calls);
  const res = await callRoute({ method: 'POST', body: { provider: 'mistral', watch: { url: 'https://chat.mistral.ai/c/1' } }, viaDeviceToken: false, store });
  assert.equal(res.handled, true);
  assert.equal(res.sent[0].status, 200);
  assert.equal(res.sent[0].body.watchAccepted, false);
  assert.equal(calls.length, 0, 'nothing was stored and no other write happened');
});

test('watch route: the poll carries the offers beside presence and activity', async () => {
  const res = await callRoute({ method: 'GET', store: fakeStore([]) });
  assert.equal(res.sent[0].status, 200);
  assert.ok(Array.isArray(res.sent[0].body.presence));
  assert.ok(Array.isArray(res.sent[0].body.activity));
  assert.equal(res.sent[0].body.watch.length, 1);
  assert.equal(res.sent[0].body.watch[0].provider, 'mistral');
});

test('watch route: a non-browser seat offer from the device is refused', async () => {
  const res = await callRoute({ method: 'POST', body: { provider: 'qwen', watch: { url: 'https://a.example/' } }, store: fakeStore([]) });
  assert.equal(res.sent[0].status, 400);
});
