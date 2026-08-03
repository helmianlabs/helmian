import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  ABLY_TOKEN_TTL_MS,
  accountRealtimeChannels,
  canonicalCapability,
  createAblyTokenRequest,
  createAccountControlTokenRequest,
  createDesktopSessionTokenRequest,
  isAblyConfigured,
  realtimeChannels,
  tokenTtlForAccountControl,
  tokenTtlForDesktopSession,
  tokenTtlForDevice,
} from '../api/_herald-realtime.js';
import { createHeraldRealtimeTokenHandler } from '../api/herald-realtime-token.js';
import { createHeraldDesktopRealtimeTokenHandler } from '../api/herald-desktop-realtime-token.js';
import { createHeraldConfigHandler } from '../api/herald-config.js';

const CHANNEL = `herald_${'a'.repeat(24)}`;
const DEVICE_ID = `phone_${'b'.repeat(16)}`;
const DEVICE_TOKEN = 'c'.repeat(43);
const CONTROL_ID = `control_${'d'.repeat(24)}`;
const CONTROL_TOKEN = 'e'.repeat(43);
const DESKTOP_ID = `desktop_${'f'.repeat(24)}`;
const ISSUER_SECRET = 's'.repeat(32);
const ISSUER_KEY = `app_123.key_456:${ISSUER_SECRET}`;
const HTTP_NONCE = 'http-nonce-1234567890123456';

test('signed token request is device-identified and channel-minimal', () => {
  const timestamp = 1_785_550_000_000;
  const nonce = 'ably-nonce-1234567890123456';
  const value = createAblyTokenRequest({
    apiKey: ISSUER_KEY,
    channel: CHANNEL,
    deviceId: DEVICE_ID,
    ttl: ABLY_TOKEN_TTL_MS,
    timestamp,
    nonce,
  });
  const expectedChannels = realtimeChannels(CHANNEL, DEVICE_ID);
  assert.equal(value.tokenRequest.keyName, 'app_123.key_456');
  assert.equal(value.tokenRequest.clientId, `herald-phone:${DEVICE_ID}`);
  assert.deepEqual(JSON.parse(value.tokenRequest.capability), {
    [expectedChannels.results]: ['subscribe'],
    [expectedChannels.requests]: ['publish'],
  });
  assert.doesNotMatch(value.tokenRequest.capability, /\*/);

  const signed = `app_123.key_456\n${ABLY_TOKEN_TTL_MS}\n${value.tokenRequest.capability}\nherald-phone:${DEVICE_ID}\n${timestamp}\n${nonce}\n`;
  const expectedMac = createHmac('sha256', ISSUER_SECRET).update(signed, 'utf8').digest('base64');
  assert.equal(value.tokenRequest.mac, expectedMac);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(ISSUER_SECRET));
});

test('capability canonicalization is deterministic', () => {
  assert.equal(canonicalCapability({ z: ['subscribe', 'publish', 'publish'], a: ['subscribe'] }),
    '{"a":["subscribe"],"z":["publish","subscribe"]}');
});

test('account-control and registered-Desktop tokens are exact and complementary', () => {
  const timestamp = 1_785_550_000_000;
  const realtimeChannel = `herald_${'r'.repeat(24)}`;
  const secondGrant = `control_${'g'.repeat(24)}`;
  const phone = createAccountControlTokenRequest({
    apiKey: ISSUER_KEY, realtimeChannel, grantId: CONTROL_ID,
    ttl: ABLY_TOKEN_TTL_MS, timestamp, nonce: 'phone-nonce-1234567890123456',
  });
  const desktop = createDesktopSessionTokenRequest({
    apiKey: ISSUER_KEY, realtimeChannel, desktopId: DESKTOP_ID,
    grantIds: [CONTROL_ID, secondGrant], ttl: ABLY_TOKEN_TTL_MS,
    timestamp, nonce: 'desktop-nonce-1234567890123456',
  });
  const channels = accountRealtimeChannels(realtimeChannel, CONTROL_ID);
  assert.equal(phone.tokenRequest.clientId, `herald-control:${CONTROL_ID}`);
  assert.deepEqual(JSON.parse(phone.tokenRequest.capability), {
    [channels.results]: ['subscribe'], [channels.requests]: ['publish'],
  });
  assert.equal(desktop.tokenRequest.clientId, `herald-desktop:${DESKTOP_ID}`);
  assert.deepEqual(JSON.parse(desktop.tokenRequest.capability), {
    [channels.results]: ['publish'],
    [accountRealtimeChannels(realtimeChannel, secondGrant).results]: ['publish'],
    [channels.requests]: ['subscribe'],
  });
  assert.doesNotMatch(phone.tokenRequest.capability + desktop.tokenRequest.capability, /"\*"/);
});

test('token TTL cannot outlive the device or paired desktop session', () => {
  const now = 1_000_000;
  const device = {
    expires_at: new Date(now + 240_000),
    session_expires_at: new Date(now + 90_000),
  };
  assert.equal(tokenTtlForDevice(device, { now }), 90_000);
  assert.throws(() => tokenTtlForDevice({ ...device, session_expires_at: null }, { now }), /expiry is unavailable/);
  assert.throws(() => tokenTtlForDevice({
    expires_at: new Date(now + 20_000), session_expires_at: new Date(now + 20_000),
  }, { now }), /too close to expiry/);
});

test('account realtime TTL cannot outlive grant, session, or Desktop registration', () => {
  const now = 1_000_000;
  assert.equal(tokenTtlForAccountControl({
    expires_at: new Date(now + 80_000),
    session_expires_at: new Date(now + 120_000),
    desktop_credential_expires_at: new Date(now + 180_000),
  }, { now }), 80_000);
  assert.equal(tokenTtlForDesktopSession({
    credential_expires_at: new Date(now + 180_000),
    session_expires_at: new Date(now + 120_000),
    grants: [{ expires_at: new Date(now + 70_000) }],
  }, { now }), 70_000);
  assert.throws(() => tokenTtlForDesktopSession({ grants: [] }, { now }), /No active account control grant/i);
});

test('configuration check accepts only a complete scoped issuer key shape', () => {
  assert.equal(isAblyConfigured({ ABLY_API_KEY: ISSUER_KEY }), true);
  assert.equal(isAblyConfigured({ ABLY_API_KEY: 'app.key' }), false);
  assert.equal(isAblyConfigured({}), false);
});

test('PWA token endpoint authorizes Clerk account and selected control grant before signing', async () => {
  const now = 1_785_550_000_000;
  const authorizationCalls = [];
  const handler = createHeraldRealtimeTokenHandler({
    apiKey: () => ISSUER_KEY,
    now: () => now,
    accountResolver: {
      configured: true, configurationState: 'ready',
      resolve: async () => ({
        state: 'verified', provider: 'clerk', subject: 'user_troy123', displayName: null,
      }),
    },
    consumeAccountNonceFn: async (input) => authorizationCalls.push({ nonce: input }),
    authorizeGrantFn: async (input) => {
      authorizationCalls.push(input);
      return {
        grant_id: CONTROL_ID,
        realtime_channel: CHANNEL,
        expires_at: new Date(now + 480_000),
        session_expires_at: new Date(now + 600_000),
        desktop_credential_expires_at: new Date(now + 700_000),
      };
    },
  });
  const response = responseFixture();
  await handler({
    method: 'POST',
    headers: {
      cookie: `helmian_herald_control=${CONTROL_ID}.${CONTROL_TOKEN}`,
      'x-helmian-nonce': HTTP_NONCE,
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authorizationCalls, [{ nonce: {
    account: {
      state: 'verified', provider: 'clerk', subject: 'user_troy123', displayName: null,
    },
    nonce: HTTP_NONCE,
  } }, {
    account: {
      state: 'verified', provider: 'clerk', subject: 'user_troy123', displayName: null,
    },
    grantId: CONTROL_ID,
    token: CONTROL_TOKEN,
  }]);
  assert.equal(response.body.provider, 'ably');
  assert.equal(response.body.realtime, true);
  assert.equal(response.body.tokenRequest.ttl, ABLY_TOKEN_TTL_MS);
  assert.equal(response.body.tokenRequest.clientId, `herald-control:${CONTROL_ID}`);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(ISSUER_SECRET));
});

test('PWA token endpoint denies an unselected account before reading the issuer credential', async () => {
  let credentialRead = false;
  let grantAuthorized = false;
  const handler = createHeraldRealtimeTokenHandler({
    apiKey: () => { credentialRead = true; return ISSUER_KEY; },
    accountResolver: {
      configured: true, configurationState: 'ready',
      resolve: async () => ({
        state: 'verified', provider: 'clerk', subject: 'user_troy123', displayName: null,
      }),
    },
    consumeAccountNonceFn: async () => {},
    authorizeGrantFn: async () => { grantAuthorized = true; },
  });
  const response = responseFixture();
  await handler({ method: 'POST', headers: { 'x-helmian-nonce': HTTP_NONCE } }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'control_denied');
  assert.equal(credentialRead, false);
  assert.equal(grantAuthorized, false);
});

test('Desktop token endpoint authorizes registration, nonce, active session, and exact grants', async () => {
  const now = 1_785_550_000_000;
  const calls = [];
  const handler = createHeraldDesktopRealtimeTokenHandler({
    accountResolver: { configured: true, configurationState: 'ready' },
    apiKey: () => ISSUER_KEY,
    now: () => now,
    authorizeDesktopFn: async (value) => { calls.push({ kind: 'desktop', value }); },
    authorizeSessionFn: async (value) => {
      calls.push({ kind: 'session', value });
      return {
        realtime_channel: CHANNEL,
        credential_expires_at: new Date(now + 700_000),
        session_expires_at: new Date(now + 600_000),
        grants: [{ grant_id: CONTROL_ID, expires_at: new Date(now + 480_000) }],
      };
    },
  });
  const response = responseFixture();
  await handler(jsonRequest({ desktopId: DESKTOP_ID, sessionId: 'session-1' }, {
    authorization: `Bearer ${DEVICE_TOKEN}`, 'x-helmian-nonce': HTTP_NONCE,
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.role, 'registered-desktop');
  assert.equal(response.body.tokenRequest.clientId, `herald-desktop:${DESKTOP_ID}`);
  assert.deepEqual(calls, [
    { kind: 'desktop', value: { desktopId: DESKTOP_ID, token: DEVICE_TOKEN, nonce: HTTP_NONCE } },
    { kind: 'session', value: { desktopId: DESKTOP_ID, sessionId: 'session-1' } },
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(ISSUER_SECRET));
});

test('public config reveals only capability booleans, never the issuer credential', async () => {
  const handler = createHeraldConfigHandler({
    accountConfigured: () => false,
    accountConfigurationState: () => 'unconfigured',
    enrollmentConfigured: () => false,
    realtimeConfigured: () => true,
  });
  const response = responseFixture();
  await handler({ method: 'GET', headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    accountIdentity: {
      configured: false,
      state: 'unconfigured',
      desktopEnrollmentConfigured: false,
      publishableKey: null,
    },
    transport: {
      active: 'ably-scoped-realtime',
      realtimeClientActive: true,
      ablyTokenServiceConfigured: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /apiKey|secret|credentialValue/i);

  const rejected = responseFixture();
  await handler({ method: 'POST', headers: {} }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, 'GET');
});

function responseFixture() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function jsonRequest(body, headers = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST', headers,
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}
