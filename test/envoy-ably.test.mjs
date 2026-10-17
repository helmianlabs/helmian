// Envoy Ably push tests: publish payload shape, channel sanitizing,
// subscribe-only token scoping, graceful no-ops. Headless, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  envoyChannelName,
  envoyChannelPattern,
  parseAblyApiKey,
  ablyConfigured,
  publishEnvoyMessage,
  createBridgeTokenRequest,
  handleEnvoyAblyRoute,
  ENVOY_ABLY_TOKEN_PATH,
} from '../src/cloud/envoy-ably.mjs';

const KEY = 'appId.keyAbc123:supersecretvalue12345678';

test('channel names are sanitized to Ably-safe form', () => {
  assert.equal(envoyChannelName('org_1', 'ch-1'), 'envoy:org_1:ch-1');
  assert.equal(envoyChannelName('org 1/x', 'ch*1'), 'envoy:org-1-x:ch-1');
  assert.equal(envoyChannelPattern('org_1'), 'envoy:org_1:*');
});

test('publishEnvoyMessage posts the right shape with Basic auth', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201 };
  };
  const message = { id: 'm1', authorKind: 'human', authorSubject: 'user-1', body: 'hi', createdAt: '2026-01-01T00:00:00Z' };
  const out = await publishEnvoyMessage({ tenantId: 'org_1', channelId: 'ch-1', message, ablyKey: KEY, fetchImpl });
  assert.equal(out.published, true);
  assert.equal(out.channel, 'envoy:org_1:ch-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rest.ably.io/channels/envoy%3Aorg_1%3Ach-1/messages');
  const expectedAuth = `Basic ${Buffer.from('appId.keyAbc123:supersecretvalue12345678', 'utf8').toString('base64')}`;
  assert.equal(calls[0].opts.headers.authorization, expectedAuth);
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.name, 'message');
  assert.deepEqual(body.data, { id: 'm1', authorKind: 'human', authorSubject: 'user-1', body: 'hi', createdAt: '2026-01-01T00:00:00Z' });
});

test('publishEnvoyMessage no-ops gracefully when the key is unset', async () => {
  let called = false;
  const out = await publishEnvoyMessage({
    tenantId: 'org_1', channelId: 'ch-1', message: { id: 'm1' },
    ablyKey: undefined, fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(out.published, false);
  assert.equal(out.reason, 'ably_not_configured');
  assert.equal(called, false);
});

test('publishEnvoyMessage never throws on transport failure', async () => {
  const failed = await publishEnvoyMessage({
    tenantId: 'org_1', channelId: 'ch-1', message: { id: 'm1' },
    ablyKey: KEY, fetchImpl: async () => { throw new Error('down'); },
  });
  assert.equal(failed.published, false);
  const bad = await publishEnvoyMessage({
    tenantId: 'org_1', channelId: 'ch-1', message: { id: 'm1' },
    ablyKey: KEY, fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(bad.published, false);
  assert.equal(bad.reason, 'http_500');
});

test('createBridgeTokenRequest is subscribe-only on the tenant pattern', () => {
  const fixed = { timestamp: 1700000000000, nonce: 'abcdefghijklmnopqrstuvwx' };
  const out = createBridgeTokenRequest({ ablyKey: KEY, tenantId: 'org_1', subject: 'user-9', channelId: 'ch-1', ...fixed });
  // Least privilege: subscribe and nothing else, tenant-scoped wildcard.
  assert.equal(out.tokenRequest.capability, JSON.stringify({ 'envoy:org_1:*': ['subscribe'] }));
  assert.ok(!out.tokenRequest.capability.includes('publish'), 'no publish capability');
  assert.equal(out.channel, 'envoy:org_1:ch-1');
  assert.equal(out.channelPattern, 'envoy:org_1:*');
  assert.equal(out.tokenRequest.clientId, 'pc-bridge:user-9');
  // The MAC verifies against the Herald HMAC-SHA256 scheme.
  const signText = `appId.keyAbc123\n300000\n${out.tokenRequest.capability}\npc-bridge:user-9\n1700000000000\nabcdefghijklmnopqrstuvwx\n`;
  const mac = createHmac('sha256', 'supersecretvalue12345678').update(signText, 'utf8').digest('base64');
  assert.equal(out.tokenRequest.mac, mac);
});

test('createBridgeTokenRequest throws 503 when the key is unset', () => {
  assert.throws(
    () => createBridgeTokenRequest({ ablyKey: undefined, tenantId: 'org_1' }),
    (err) => err?.status === 503,
  );
  assert.equal(ablyConfigured(undefined), false);
  assert.equal(ablyConfigured(KEY), true);
});

function makeRouteHarness({ actor = { tenantId: 'org_1', subject: 'user-9' }, ablyKey = KEY, body = { channelId: 'ch-1' } } = {}) {
  const sent = [];
  return {
    sent,
    args: {
      request: { method: 'POST', headers: {} },
      response: {},
      requestUrl: new URL(`https://x${ENVOY_ABLY_TOKEN_PATH}`),
      activeTenantActor: async () => actor,
      send: (_res, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
      TenantAuthorizationError: class TenantAuthorizationError extends Error {},
      readJson: async () => body,
      ablyKey,
    },
  };
}

test('handleEnvoyAblyRoute mints a token for the device actor', async () => {
  const h = makeRouteHarness();
  const handled = await handleEnvoyAblyRoute(h.args);
  assert.equal(handled, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.valid, true);
  assert.ok(h.sent[0].body.tokenRequest?.mac);
  assert.equal(h.sent[0].body.channel, 'envoy:org_1:ch-1');
});

test('handleEnvoyAblyRoute returns 503 when Ably is not configured', async () => {
  const h = makeRouteHarness({ ablyKey: '' });
  await handleEnvoyAblyRoute(h.args);
  assert.equal(h.sent[0].status, 503);
  assert.equal(h.sent[0].body.code, 'ENVOY_ABLY_NOT_CONFIGURED');
});

test('handleEnvoyAblyRoute ignores other paths and methods', async () => {
  const h = makeRouteHarness();
  h.args.requestUrl = new URL('https://x/api/admin/envoy/messages');
  assert.equal(await handleEnvoyAblyRoute(h.args), false);
  const h2 = makeRouteHarness();
  h2.args.request = { method: 'GET', headers: {} };
  assert.equal(await handleEnvoyAblyRoute(h2.args), false);
});

test('handleEnvoyAblyRoute maps membership failures to 403', async () => {
  class TenantAuthorizationError extends Error {}
  const sent = [];
  const handled = await handleEnvoyAblyRoute({
    request: { method: 'POST', headers: {} },
    response: {},
    requestUrl: new URL(`https://x${ENVOY_ABLY_TOKEN_PATH}`),
    activeTenantActor: async () => { throw new TenantAuthorizationError('nope'); },
    send: (_res, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
    TenantAuthorizationError,
    readJson: async () => ({}),
    ablyKey: KEY,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].body.code, 'ENVOY_MEMBERSHIP_REQUIRED');
});

test('parseAblyApiKey rejects malformed keys', () => {
  assert.throws(() => parseAblyApiKey('nope'), /not configured/);
  assert.throws(() => parseAblyApiKey(''), /not configured/);
  const { keyName, keySecret } = parseAblyApiKey(KEY);
  assert.equal(keyName, 'appId.keyAbc123');
  assert.equal(keySecret, 'supersecretvalue12345678');
});
