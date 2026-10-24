// GitHub webhook receiver (G-2, events-in slice). Route-level tests run
// against an in-memory fake store, so they prove signature gating, event
// formatting, repo mapping and delivery-id idempotency without a database.
// The real store is exercised against Postgres only when
// HELMIAN_TEST_PG_URL points at a scratch database (same convention as
// test/envoy-mesh.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import {
  GITHUB_WEBHOOK_PATH,
  createGithubWebhookStore,
  formatGithubEvent,
  handleGithubWebhookRoute,
  parseRepoChannelMap,
  verifyGithubSignature,
} from '../../../src/cloud/github-webhook.mjs';
import { handleEnvoyAblyRoute } from '../../../src/cloud/envoy-ably.mjs';
import { createEnvoyStore } from '../../../src/cloud/envoy-chat.mjs';

const SECRET = 'test-webhook-secret-not-real';
const MAP = JSON.stringify({ 'helmianlabs/helmian': 'build' });

const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

// In-memory stand-in for createGithubWebhookStore with the same conflict
// semantics: one stored card per (channel, github:<delivery id>).
function fakeStore(channels = { build: { id: 'chan-1', tenantId: 'tenant-1', slug: 'build', title: 'build' } }) {
  const seen = new Map();
  const store = {
    messages: [],
    resolveCalls: 0,
    async resolveChannelBySlug(slug) {
      store.resolveCalls += 1;
      const channel = channels[slug] ?? null;
      return channel ? { channel, reason: null } : { channel: null, reason: 'channel_not_found' };
    },
    async postEventCard({ channel, deliveryId, text }) {
      const key = `${channel.id}|github:${deliveryId}`;
      if (seen.has(key)) return { durable: true, replayed: true, message: seen.get(key) };
      const message = { id: String(store.messages.length + 1), channelId: channel.id, authorSubject: 'system:github', authorKind: 'system', body: text, idempotencyKey: `github:${deliveryId}`, createdAt: new Date().toISOString() };
      seen.set(key, message);
      store.messages.push(message);
      return { durable: true, replayed: false, message };
    },
  };
  return store;
}

function webhookRequest({ event, delivery = 'd-1', payload, secret = SECRET, signature = undefined, method = 'POST' }) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const headers = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': signature === undefined ? sign(body, secret) : signature,
  };
  if (delivery === null) delete headers['x-github-delivery'];
  const request = { method, headers, async *[Symbol.asyncIterator]() { yield body; } };
  return { request, body };
}

async function callRoute({ request, store, env }) {
  const sent = [];
  const handled = await handleGithubWebhookRoute({
    request,
    response: {},
    requestUrl: new URL(`http://x${GITHUB_WEBHOOK_PATH}`),
    send: (_r, status, body) => sent.push([status, JSON.parse(body)]),
    env: env ?? { HELMION_GITHUB_WEBHOOK_SECRET: SECRET, HELMION_GITHUB_REPO_CHANNEL_MAP: MAP },
    store,
    log: () => {},
  });
  return { handled, sent };
}

const pushPayload = {
  ref: 'refs/heads/main',
  compare: 'https://github.com/helmianlabs/helmian/compare/aaa...bbb',
  pusher: { name: 'troy83352' },
  sender: { login: 'troy83352' },
  repository: { full_name: 'helmianlabs/helmian' },
  commits: [{ id: 'abcdef1234567890', message: 'Fix the thing\n\nLonger body here' }],
};

test('signature: valid accepted, wrong secret and missing header refused, nothing processed', async () => {
  assert.equal(verifyGithubSignature({ rawBody: Buffer.from('{}'), signatureHeader: sign(Buffer.from('{}')), secret: SECRET }), true);
  assert.equal(verifyGithubSignature({ rawBody: Buffer.from('{}'), signatureHeader: sign(Buffer.from('{}'), 'other'), secret: SECRET }), false);
  assert.equal(verifyGithubSignature({ rawBody: Buffer.from('{}'), signatureHeader: '', secret: SECRET }), false);

  const store = fakeStore();
  const bad = webhookRequest({ event: 'push', payload: pushPayload, secret: 'wrong-secret' });
  const refused = await callRoute({ request: bad.request, store });
  assert.equal(refused.handled, true);
  assert.deepEqual(refused.sent, [[401, { valid: false, code: 'GITHUB_SIGNATURE_INVALID' }]]);
  assert.equal(store.messages.length, 0);
  assert.equal(store.resolveCalls, 0, 'a refused signature must not reach the store');

  const missing = webhookRequest({ event: 'push', payload: pushPayload, signature: 'sha256=deadbeef' });
  const refused2 = await callRoute({ request: missing.request, store });
  assert.equal(refused2.sent[0][0], 401);
  assert.equal(store.messages.length, 0);
});

test('secret unset: 503 and no processing; wrong path passes through; wrong method is 405', async () => {
  const store = fakeStore();
  const { request } = webhookRequest({ event: 'ping', payload: { zen: 'hi' } });
  const sent = [];
  const handled = await handleGithubWebhookRoute({
    request, response: {}, requestUrl: new URL(`http://x${GITHUB_WEBHOOK_PATH}`),
    send: (_r, s, b) => sent.push([s, JSON.parse(b)]), env: {}, store, log: () => {},
  });
  assert.equal(handled, true);
  assert.deepEqual(sent, [[503, { valid: false, code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' }]]);

  const other = await handleGithubWebhookRoute({
    request, response: {}, requestUrl: new URL('http://x/api/admin/envoy/messages'),
    send: () => { throw new Error('must not send'); }, env: {}, store, log: () => {},
  });
  assert.equal(other, false);

  const get = webhookRequest({ event: 'ping', payload: {}, method: 'GET' });
  const methodResult = await callRoute({ request: get.request, store });
  assert.deepEqual(methodResult.sent, [[405, { valid: false, code: 'GITHUB_METHOD_NOT_ALLOWED' }]]);
});

test('ping is acknowledged and never posts', async () => {
  const store = fakeStore();
  const { request } = webhookRequest({ event: 'ping', payload: { zen: 'Keep it logically awesome.', hook_id: 123 } });
  const { handled, sent } = await callRoute({ request, store });
  assert.equal(handled, true);
  assert.deepEqual(sent, [[200, { valid: true, pong: true }]]);
  assert.equal(store.messages.length, 0);
});

test('push posts exactly one card; the same delivery id never posts twice', async () => {
  const store = fakeStore();
  const first = webhookRequest({ event: 'push', delivery: 'delivery-42', payload: pushPayload });
  const r1 = await callRoute({ request: first.request, store });
  assert.deepEqual(r1.sent, [[200, { valid: true, posted: true, replayed: false }]]);
  assert.equal(store.messages.length, 1);
  assert.match(store.messages[0].body, /^GitHub: troy83352 pushed 1 commit to helmianlabs\/helmian \(main\) — Fix the thing \(abcdef1\)/);
  assert.match(store.messages[0].body, /compare\/aaa\.\.\.bbb/);
  assert.equal(store.messages[0].idempotencyKey, 'github:delivery-42');
  assert.equal(store.messages[0].authorKind, 'system');

  const dupe = webhookRequest({ event: 'push', delivery: 'delivery-42', payload: pushPayload });
  const r2 = await callRoute({ request: dupe.request, store });
  assert.deepEqual(r2.sent, [[200, { valid: true, posted: true, replayed: true }]]);
  assert.equal(store.messages.length, 1, 'a retried delivery must not double-post');
});

test('unmapped repo is an honest 200 no-op and never reaches the store', async () => {
  const store = fakeStore();
  const payload = { ...pushPayload, repository: { full_name: 'someone/else' } };
  const { request } = webhookRequest({ event: 'push', payload });
  const { sent } = await callRoute({ request, store });
  assert.deepEqual(sent, [[200, { valid: true, posted: false, reason: 'repo_not_mapped' }]]);
  assert.equal(store.messages.length, 0);
  assert.equal(store.resolveCalls, 0);
});

test('mapped repo whose channel slug does not resolve is a no-op with the reason', async () => {
  const store = fakeStore({});
  const { request } = webhookRequest({ event: 'push', payload: pushPayload });
  const { sent } = await callRoute({ request, store });
  assert.deepEqual(sent, [[200, { valid: true, posted: false, reason: 'channel_not_found' }]]);
  assert.equal(store.messages.length, 0);
});

test('pull_request and issues: opened posts, merged reads merged, plain close reads closed, other actions ignored', async () => {
  const store = fakeStore();
  const pr = (action, merged) => ({
    action, number: 7, sender: { login: 'troy83352' }, repository: { full_name: 'helmianlabs/helmian' },
    pull_request: { number: 7, title: 'Add the webhook receiver', html_url: 'https://github.com/helmianlabs/helmian/pull/7', merged },
  });
  let r = await callRoute({ request: webhookRequest({ event: 'pull_request', delivery: 'pr-1', payload: pr('opened', false) }).request, store });
  assert.deepEqual(r.sent, [[200, { valid: true, posted: true, replayed: false }]]);
  assert.match(store.messages[0].body, /opened pull request #7 in helmianlabs\/helmian — Add the webhook receiver/);

  r = await callRoute({ request: webhookRequest({ event: 'pull_request', delivery: 'pr-2', payload: pr('closed', true) }).request, store });
  assert.equal(r.sent[0][1].posted, true);
  assert.match(store.messages[1].body, /merged pull request #7/);

  r = await callRoute({ request: webhookRequest({ event: 'pull_request', delivery: 'pr-3', payload: pr('closed', false) }).request, store });
  assert.match(store.messages[2].body, /closed pull request #7/);

  r = await callRoute({ request: webhookRequest({ event: 'pull_request', delivery: 'pr-4', payload: pr('synchronize', false) }).request, store });
  assert.deepEqual(r.sent, [[200, { valid: true, posted: false, reason: 'event_ignored' }]]);
  assert.equal(store.messages.length, 3);

  const issue = {
    action: 'opened', sender: { login: 'troy83352' }, repository: { full_name: 'helmianlabs/helmian' },
    issue: { number: 9, title: 'Cards please', html_url: 'https://github.com/helmianlabs/helmian/issues/9' },
  };
  r = await callRoute({ request: webhookRequest({ event: 'issues', delivery: 'is-1', payload: issue }).request, store });
  assert.equal(r.sent[0][1].posted, true);
  assert.match(store.messages[3].body, /opened issue #9 in helmianlabs\/helmian — Cards please/);
});

test('format: branch delete, multi-commit counts, and hostile text is flattened', () => {
  const del = formatGithubEvent('push', { ...pushPayload, deleted: true, commits: [] });
  assert.equal(del.text, 'GitHub: troy83352 deleted main in helmianlabs/helmian');
  const multi = formatGithubEvent('push', { ...pushPayload, commits: [{ id: 'aaaaaaa1', message: 'one' }, { id: 'bbbbbbb2', message: 'two\nlines' }] });
  assert.match(multi.text, /pushed 2 commits to/);
  assert.match(multi.text, /— two \(bbbbbbb\)/);
  const hostile = formatGithubEvent('issues', {
    action: 'opened', sender: { login: 'eve' }, repository: { full_name: 'helmianlabs/helmian' },
    issue: { number: 3, title: 'x\n### injected\r\nheading', html_url: 'https://github.com/helmianlabs/helmian/issues/3' },
  });
  assert.equal(hostile.text.split('\n').length, 2, 'title newlines are flattened: only the title line and the URL line remain');
  assert.match(hostile.text.split('\n')[0], /— x ### injected heading$/, 'the injected break collapses into the title line as literal text');
  assert.equal(formatGithubEvent('push', { repository: { full_name: 'not a repo' } }), null);
  assert.equal(formatGithubEvent('star', pushPayload), null);
});

test('repo channel map parsing: tolerant of bad config, strict about shapes', () => {
  assert.deepEqual(parseRepoChannelMap('').map, {});
  assert.deepEqual(parseRepoChannelMap('not json').error, 'invalid_json');
  assert.deepEqual(parseRepoChannelMap('[1]').error, 'not_an_object');
  const { map } = parseRepoChannelMap(JSON.stringify({ 'a/b': 'Build', 'bad repo': 'x', 'c/d': 'Not A Slug', 'e/f': 'ok-slug' }));
  assert.deepEqual(map, { 'a/b': 'build', 'e/f': 'ok-slug' });
});

test('delegate wiring: handleEnvoyAblyRoute serves the webhook path', async () => {
  const store = fakeStore();
  const prevSecret = process.env.HELMION_GITHUB_WEBHOOK_SECRET;
  const prevMap = process.env.HELMION_GITHUB_REPO_CHANNEL_MAP;
  process.env.HELMION_GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.HELMION_GITHUB_REPO_CHANNEL_MAP = MAP;
  try {
    const { request } = webhookRequest({ event: 'ping', payload: { zen: 'hi' } });
    const sent = [];
    // The delegate ignores the injected store (it builds its own), so use
    // ping here: it proves routing + signature without a database.
    const handled = await handleEnvoyAblyRoute({
      request, response: {}, requestUrl: new URL(`http://x${GITHUB_WEBHOOK_PATH}`),
      activeTenantActor: async () => { throw new Error('tenant auth must not run for webhooks'); },
      send: (_r, s, b) => sent.push([s, JSON.parse(b)]),
      TenantAuthorizationError: class extends Error {},
      readJson: async () => { throw new Error('readJson must not run: the signature needs the raw body'); },
    });
    assert.equal(handled, true);
    assert.deepEqual(sent, [[200, { valid: true, pong: true }]]);
    assert.equal(store.messages.length, 0);
  } finally {
    if (prevSecret === undefined) delete process.env.HELMION_GITHUB_WEBHOOK_SECRET; else process.env.HELMION_GITHUB_WEBHOOK_SECRET = prevSecret;
    if (prevMap === undefined) delete process.env.HELMION_GITHUB_REPO_CHANNEL_MAP; else process.env.HELMION_GITHUB_REPO_CHANNEL_MAP = prevMap;
  }
});

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = !pgUrl && 'HELMIAN_TEST_PG_URL not set';

test('real store on Postgres: resolve, post once, redelivery replays, slug ambiguity refuses', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const otherTenant = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'GH webhook test']);
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [otherTenant, 'GH webhook other']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const chat = createEnvoyStore(pool);
  const store = createGithubWebhookStore({ pool, publishImpl: async () => {} });
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'build', title: 'build', kind: 'team' });
    const resolved = await store.resolveChannelBySlug('build');
    assert.equal(resolved.channel.id, channel.id);
    assert.equal(resolved.channel.tenantId, tenantId);

    const text = 'GitHub: troy83352 pushed 1 commit to helmianlabs/helmian (main) — Fix the thing (abcdef1)';
    const first = await store.postEventCard({ channel: resolved.channel, deliveryId: 'pg-delivery-1', text });
    assert.equal(first.replayed, false);
    const second = await store.postEventCard({ channel: resolved.channel, deliveryId: 'pg-delivery-1', text });
    assert.equal(second.replayed, true);
    assert.equal(second.message.id, first.message.id);

    const listed = await chat.listMessages(owner, channel.id);
    const cards = listed.messages.filter((m) => m.idempotencyKey === 'github:pg-delivery-1');
    assert.equal(cards.length, 1, 'exactly one stored card per delivery');
    assert.equal(cards[0].authorKind, 'system');
    assert.equal(cards[0].body, text);

    // A second tenant with the same slug makes the mapping ambiguous.
    const otherOwner = { tenantId: otherTenant, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [otherTenant, otherOwner.subject, 'owner']);
    await chat.createChannel(otherOwner, { slug: 'build', title: 'build', kind: 'team' });
    const ambiguous = await store.resolveChannelBySlug('build');
    assert.equal(ambiguous.channel, null);
    assert.equal(ambiguous.reason, 'channel_ambiguous');
  } finally {
    await pool.query("delete from helmion.audit_events where tenant_id like 't-%'").catch(() => {});
    await pool.query("delete from helmion.tenants where tenant_id like 't-%'").catch(() => {});
    await pool.end();
  }
});
