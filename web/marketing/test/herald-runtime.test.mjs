import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  accountIdentityResolver,
  createAccountIdentityResolver,
  publicDeviceIdentity,
  publicTransportStatus,
  resolveAccountForRequest,
} from '../api/_herald-identity.js';
import {
  ACCOUNT_IDENTITY_STATES,
  CONNECTION_STATES,
  DELIVERY_STATES,
  createDeliveryTracker,
  createHeraldTransport,
  createSameOriginPollingAdapter,
  describeAccountIdentity,
  normalizeAccountIdentity,
} from '../herald/runtime.js';

test('account identity stays explicitly unconfigured until a server verifier is injected', async () => {
  const request = { headers: { 'x-user-id': 'browser-controlled' } };
  assert.equal(accountIdentityResolver.configured, false);
  assert.deepEqual(await accountIdentityResolver.resolve(request), {
    state: 'unconfigured', provider: null, subject: null, displayName: null,
  });
  assert.match(describeAccountIdentity(await accountIdentityResolver.resolve(request)), /not configured/i);

  const verified = createAccountIdentityResolver({
    verifyAccount: async () => ({ provider: 'clerk', subject: 'user_123', displayName: 'Troy' }),
  });
  assert.equal(verified.configured, true);
  assert.deepEqual(await verified.resolve(request), {
    state: 'verified', provider: 'clerk', subject: 'user_123', displayName: 'Troy',
  });

  const signedOut = createAccountIdentityResolver({ verifyAccount: async () => null });
  await assert.rejects(
    () => resolveAccountForRequest(signedOut, request),
    (error) => error.status === 401 && error.code === 'account_denied',
  );
});

test('public runtime identity projections contain no device token or provider credential', () => {
  const device = {
    device_id: `phone_${'d'.repeat(16)}`,
    display_name: 'My phone',
    expires_at: '2026-08-02T00:00:00.000Z',
    last_desktop_seen_at: '2026-08-01T23:59:50.000Z',
    scopes: ['session:read'],
    token_hash: 'must-not-leak',
    desktop_token_hash: 'must-not-leak',
  };
  const projection = publicDeviceIdentity(device);
  const transport = publicTransportStatus(device);
  assert.equal(projection.displayName, 'My phone');
  assert.equal(projection.token_hash, undefined);
  assert.equal(transport.realtime, false);
  assert.equal(transport.realtimeProvider, 'not-configured');
  assert.doesNotMatch(JSON.stringify({ projection, transport }), /must-not-leak/);
});

test('browser identity normalizer does not display unverified provider claims', () => {
  const identity = normalizeAccountIdentity({
    state: ACCOUNT_IDENTITY_STATES.UNCONFIGURED,
    provider: 'pretend-provider', subject: 'pretend-user', displayName: 'Pretend',
  });
  assert.deepEqual(identity, {
    state: 'unconfigured', provider: null, subject: null, displayName: null,
  });
});

test('same-origin polling adapter relies on HttpOnly cookies and adds no authorization credential', async () => {
  const calls = [];
  const adapter = createSameOriginPollingAdapter({
    nonceFactory: () => 'nonce-1234567890123456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ accepted: true, cursor: 0, messages: [] }) };
    },
  });
  await adapter.send({ requestId: 'request-1', action: 'session.read', payload: {} });
  await adapter.poll(4);
  assert.equal(adapter.realtime, false);
  assert.equal(adapter.credentialMode, 'http-only-cookie');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].url, '/api/herald-phone?after=4');
});

test('transport reports connecting, paired, and live as distinct states', async () => {
  const states = [];
  let scheduled = false;
  const transport = createHeraldTransport({
    adapter: {
      id: 'fixture', realtime: false, credentialMode: 'http-only-cookie',
      send: async () => ({ accepted: true }),
      poll: async () => ({ cursor: 2, messages: [] }),
    },
    onBatch: async () => ({ live: true }),
    onState: ({ state }) => states.push(state),
    schedule: () => { scheduled = true; return 1; },
    cancelSchedule: () => {},
  });
  await transport.start({ requestSession: false });
  assert.deepEqual(states, [
    CONNECTION_STATES.CONNECTING,
    CONNECTION_STATES.PAIRED,
    CONNECTION_STATES.LIVE,
  ]);
  assert.equal(transport.state, CONNECTION_STATES.LIVE);
  assert.equal(scheduled, true);
  transport.stop();
});

test('transport distinguishes an offline phone from a stale desktop', async () => {
  const states = [];
  let online = false;
  const transport = createHeraldTransport({
    adapter: {
      id: 'fixture', realtime: false,
      send: async () => { throw new TypeError('Failed to fetch'); },
      poll: async () => { throw Object.assign(new Error('Desktop stale'), { status: 503 }); },
    },
    isNetworkOnline: () => online,
    onState: ({ state }) => states.push(state),
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  await assert.rejects(() => transport.send('session.read'), /Failed to fetch/);
  assert.equal(states.at(-1), CONNECTION_STATES.NETWORK_OFFLINE);
  online = true;
  await assert.rejects(() => transport.pollOnce(), /Desktop stale/);
  assert.equal(states.at(-1), CONNECTION_STATES.DESKTOP_OFFLINE);
});

test('an initial generic server failure is relay-unavailable, not connected', async () => {
  const states = [];
  const transport = createHeraldTransport({
    adapter: {
      id: 'fixture', realtime: false,
      send: async () => { throw Object.assign(new Error('Server error'), { status: 500 }); },
      poll: async () => ({ cursor: 0, messages: [] }),
    },
    isNetworkOnline: () => true,
    onState: ({ state }) => states.push(state),
  });
  await assert.rejects(() => transport.send('session.read'), /Server error/);
  assert.equal(states.at(-1), CONNECTION_STATES.RELAY_UNAVAILABLE);
});

test('delivery tracker distinguishes relay acceptance from desktop acknowledgement', () => {
  let time = 1_000;
  const tracker = createDeliveryTracker({ now: () => time, delayedAfterMs: 30_000 });
  assert.equal(tracker.queued('request-1', 'instruction.submit').state, DELIVERY_STATES.QUEUED);
  time += 30_001;
  assert.equal(tracker.list()[0].state, DELIVERY_STATES.DELAYED);
  time += 1;
  const settled = tracker.settle({ requestId: 'request-1', state: 'ok', payload: {} });
  assert.equal(settled.state, DELIVERY_STATES.DELIVERED);
  assert.match(settled.message, /Acknowledged by Helmian Desktop/);
});

test('delivery tracker reload state contains no instruction content or credential', () => {
  let time = 5_000;
  const tracker = createDeliveryTracker({ now: () => time });
  tracker.queued('request-2', 'instruction.submit');
  const stored = tracker.exportPending();
  assert.deepEqual(stored, [{
    requestId: 'request-2', action: 'instruction.submit', state: 'queued',
    queuedAt: 5_000, updatedAt: 5_000,
  }]);
  assert.equal(JSON.stringify(stored).includes('instruction text'), false);

  time += 100;
  const restored = createDeliveryTracker({ now: () => time, initial: [
    ...stored,
    { requestId: '../../bad', action: 'shell.exec', state: 'queued', queuedAt: 1, token: 'secret' },
  ] });
  assert.equal(restored.list().length, 1);
  assert.equal(restored.settle({ requestId: 'request-2', state: 'ok' }).state, DELIVERY_STATES.DELIVERED);
  assert.deepEqual(restored.exportPending(), []);
});

test('PWA source contains no embedded Clerk or Ably credential', async () => {
  const source = await Promise.all([
    readFile(new URL('../herald/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../herald/runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../herald/shell.js', import.meta.url), 'utf8'),
    readFile(new URL('../herald/index.html', import.meta.url), 'utf8'),
  ]);
  const joined = source.join('\n');
  assert.doesNotMatch(joined, /(?:ABLY_API_KEY|CLERK_SECRET_KEY|CLERK_PUBLISHABLE_KEY)\s*[:=]/);
  assert.doesNotMatch(joined, /(?:Basic|Bearer)\s+[A-Za-z0-9+/_=-]{20,}/);
});

test('disconnected page visibly renders the full Helmian workspace without making live claims', async () => {
  const html = await readFile(new URL('../herald/index.html', import.meta.url), 'utf8');
  assert.match(html, /<main class="workspace" id="workspace">/);
  assert.doesNotMatch(html, /id="workspace"[^>]*hidden/);
  for (const text of [
    'TEAM COLLABORATION', 'Helmian Console', 'Desktop not connected',
    'Team providers not connected', 'Connect Slack', 'Connect Discord',
    'Disconnected', 'Unknown, not safe',
  ]) assert.match(html, new RegExp(text.replace('/', '\\/')));
  assert.match(html, /<textarea id="messageInput"/);
  assert.doesNotMatch(html, /<textarea id="messageInput"[^>]+disabled/);
  assert.doesNotMatch(html, /Personal Pilot|Helmian Remote Control|NOT PAIRED/);
  for (const asset of ['/herald/styles.css', '/herald/shell.js']) {
    assert.match(html, new RegExp(
      `(?:href|src)="${asset.replaceAll('/', '\\/')}(?:\\?[^\"]*)?"`,
    ));
  }
});

test('service worker caches only shell assets and never intercepts Herald APIs', async () => {
  const [worker, manifestText] = await Promise.all([
    readFile(new URL('../herald/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../herald/manifest.webmanifest', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.scope, '/herald/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.type === 'image/png'));
  assert.match(worker, /pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker.match(/const SHELL[\s\S]+?\]\);/)?.[0] ?? '', /\/api\//);
});
