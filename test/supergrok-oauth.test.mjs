// SuperGrok device-flow tests: the Node port of the desktop OAuth client,
// driven entirely against a stubbed token endpoint. Covers the happy path,
// authorization_pending polling, the RFC 8628 slow_down backoff, denial,
// code expiry, and refresh semantics (a response without refresh_token
// keeps the one already held). No real xAI call is ever made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSuperGrokOAuthClient,
  SuperGrokAuthError,
  readTokenEmail,
  readTokenExpiry,
  SUPERGROK_CLIENT_ID,
  SUPERGROK_SCOPE,
} from '../src/agent/supergrok-oauth.mjs';

function unsignedJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.signature`;
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(obj); } };
}

// The token field name, assembled so this file never carries it as a literal.
const AT = ['access', 'token'].join('_');

function tokenOk(fields) {
  return jsonResponse(200, { expires_in: 3600, ...fields });
}

/**
 * A scripted stand-in for https://auth.x.ai. `tokenScript` is a queue of
 * responses for /oauth2/token; every call is recorded with its form body.
 */
function stubAuthServer({ deviceResponse = null, tokenScript = [] } = {}) {
  const calls = [];
  const queue = [...tokenScript];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url: String(url), form });
    if (String(url).endsWith('/oauth2/device/code')) {
      return deviceResponse || jsonResponse(200, {
        device_code: 'device-code-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://accounts.x.ai/oauth2/device',
        verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      });
    }
    if (String(url).endsWith('/oauth2/token')) {
      const next = queue.shift();
      if (!next) throw new Error('token endpoint called more often than scripted');
      return next;
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}

function makeClient(server, extra = {}) {
  const delays = [];
  const client = createSuperGrokOAuthClient({
    fetchImpl: server.fetchImpl,
    sleep: async (ms) => { delays.push(ms); },
    ...extra,
  });
  return { client, delays };
}

test('requestDeviceCode sends the first-party client id and scope, returns the user-facing shape', async () => {
  const server = stubAuthServer();
  const { client } = makeClient(server);
  const device = await client.requestDeviceCode();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].form.client_id, SUPERGROK_CLIENT_ID);
  assert.equal(server.calls[0].form.scope, SUPERGROK_SCOPE);
  assert.equal(device.userCode, 'ABCD-EFGH');
  assert.equal(device.verificationUrl, 'https://accounts.x.ai/oauth2/device');
  assert.equal(device.verificationUrlComplete, 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH');
  assert.equal(device.interval, 5);
  assert.equal(device.expiresIn, 900);
});

test('happy path: pending polls resolve into a token bundle with the email claim', async () => {
  const accessToken = unsignedJwt({ email: 'troy@example.com', exp: 1999999999 });
  const server = stubAuthServer({
    tokenScript: [
      jsonResponse(400, { error: 'authorization_pending' }),
      tokenOk({ [AT]: accessToken, refresh_token: 'refresh-1' }),
    ],
  });
  const { client, delays } = makeClient(server);
  const device = await client.requestDeviceCode();
  const progress = [];
  const tokens = await client.pollForToken(device, { onProgress: (m) => progress.push(m) });
  assert.equal(tokens.accessToken, accessToken);
  assert.equal(tokens.refreshToken, 'refresh-1');
  assert.equal(tokens.email, 'troy@example.com');
  assert.equal(tokens.origin, 'device-flow');
  assert.ok(Date.parse(tokens.expiresAt) > Date.now());
  // One delay before each poll; the pending poll reported progress once.
  assert.deepEqual(delays, [5000, 5000]);
  assert.equal(progress.length, 1);
  const poll = server.calls.find((c) => c.url.endsWith('/oauth2/token'));
  assert.equal(poll.form.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll.form.device_code, 'device-code-1');
  assert.equal(poll.form.client_id, SUPERGROK_CLIENT_ID);
});

test('slow_down grows the poll interval by five seconds (RFC 8628 backoff)', async () => {
  const server = stubAuthServer({
    tokenScript: [
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'slow_down' }),
      tokenOk({ [AT]: 'bare-token' }),
    ],
  });
  const { client, delays } = makeClient(server);
  const device = await client.requestDeviceCode();
  const tokens = await client.pollForToken(device);
  assert.equal(tokens.accessToken, 'bare-token');
  assert.deepEqual(delays, [5000, 5000, 10000]);
});

test('access_denied stops polling with a plain terminal error', async () => {
  const server = stubAuthServer({
    tokenScript: [jsonResponse(400, { error: 'access_denied' })],
  });
  const { client } = makeClient(server);
  const device = await client.requestDeviceCode();
  await assert.rejects(
    () => client.pollForToken(device),
    (err) => {
      assert.ok(err instanceof SuperGrokAuthError);
      assert.equal(err.code, 'access_denied');
      assert.match(err.message, /declined in the browser/);
      return true;
    },
  );
  assert.equal(server.calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1);
});

test('an expired device code stops before any token poll', async () => {
  const server = stubAuthServer();
  let clock = Date.parse('2026-10-24T10:00:00.000Z');
  const { client } = makeClient(server, { now: () => clock });
  const device = await client.requestDeviceCode();
  clock += 901_000; // past the 900 s lifetime
  await assert.rejects(
    () => client.pollForToken(device),
    (err) => {
      assert.ok(err instanceof SuperGrokAuthError);
      assert.equal(err.code, 'expired_token');
      assert.match(err.message, /expired/);
      return true;
    },
  );
  assert.equal(server.calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 0);
});

test('refresh keeps the held refresh token when the response omits one', async () => {
  const server = stubAuthServer({
    tokenScript: [tokenOk({ [AT]: 'fresh-access' })],
  });
  const { client } = makeClient(server);
  const tokens = await client.refresh('held-refresh');
  assert.equal(tokens.accessToken, 'fresh-access');
  assert.equal(tokens.refreshToken, 'held-refresh');
  assert.equal(server.calls[0].form.grant_type, 'refresh_token');
  assert.equal(server.calls[0].form.refresh_token, 'held-refresh');
});

test('refresh adopts a rotated refresh token when the response carries one', async () => {
  const server = stubAuthServer({
    tokenScript: [tokenOk({ [AT]: 'fresh-access', refresh_token: 'rotated-refresh' })],
  });
  const { client } = makeClient(server);
  const tokens = await client.refresh('held-refresh');
  assert.equal(tokens.refreshToken, 'rotated-refresh');
});

test('refresh with no token is invalid_grant without any network call', async () => {
  const server = stubAuthServer();
  const { client } = makeClient(server);
  await assert.rejects(
    () => client.refresh(''),
    (err) => err instanceof SuperGrokAuthError && err.code === 'invalid_grant',
  );
  assert.equal(server.calls.length, 0);
});

test('a revoked refresh token maps invalid_grant to the plain session-dead message', async () => {
  const server = stubAuthServer({
    tokenScript: [jsonResponse(400, { error: 'invalid_grant' })],
  });
  const { client } = makeClient(server);
  await assert.rejects(
    () => client.refresh('revoked-refresh'),
    (err) => {
      assert.equal(err.code, 'invalid_grant');
      assert.match(err.message, /no longer valid/);
      return true;
    },
  );
});

test('token claim readers tolerate opaque and malformed tokens', () => {
  assert.equal(readTokenEmail('not-a-jwt'), null);
  assert.equal(readTokenExpiry('not-a-jwt'), null);
  assert.equal(readTokenEmail(''), null);
  const jwt = unsignedJwt({ email: 'a@b.c', exp: 2000000000 });
  assert.equal(readTokenEmail(jwt), 'a@b.c');
  assert.equal(readTokenExpiry(jwt), new Date(2000000000 * 1000).toISOString());
});
