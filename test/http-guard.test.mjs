// Helmian Site Guard HTTP layer (src/cloud/http-guard.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {
  BASELINE_SECURITY_HEADERS,
  HTTP_GUARD_DEFAULTS,
  SERVER_TIMEOUTS,
  clientIp,
  createHttpGuard,
  credentialKey,
  hardenServerTimeouts,
  httpGuardConfigFromEnv,
} from '../src/cloud/http-guard.mjs';

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200, body: null, headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    end(b) { this.body = b; this.ended = true; },
  };
}
const req = (headers = {}, extra = {}) => ({ method: 'GET', url: '/api/admin/session', headers: { host: 'helmian.cloud', 'x-forwarded-proto': 'https', ...headers }, socket: { remoteAddress: '10.0.0.9' }, ...extra });

test('config: defaults, env overrides, and the off switch', () => {
  const d = httpGuardConfigFromEnv({});
  assert.equal(d.enabled, true);
  assert.equal(d.anonPerIp, HTTP_GUARD_DEFAULTS.anonPerIp);
  assert.equal(d.maxBodyBytes, 4 * 1024 * 1024);
  const o = httpGuardConfigFromEnv({ HELMIAN_HTTP_GUARD: 'off', HELMIAN_HTTP_RATE_ANON_PER_IP: '5', HELMIAN_HTTP_MAX_BODY_BYTES: 'junk' });
  assert.equal(o.enabled, false);
  assert.equal(o.anonPerIp, 5);
  assert.equal(o.maxBodyBytes, HTTP_GUARD_DEFAULTS.maxBodyBytes);
});

test('ip: Cloudflare\'s visitor header first, then Vercel\'s, then forwarded-for first hop, then the socket', () => {
  assert.equal(clientIp(req({ 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })), '1.2.3.4');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '5.6.7.8', 'x-vercel-forwarded-for': '172.70.1.1' })), '5.6.7.8');
  assert.equal(clientIp(req({ 'x-forwarded-for': '7.7.7.7, 10.0.0.1' })), '7.7.7.7');
  assert.equal(clientIp(req()), '10.0.0.9');
});

test('credential: bearer or session cookie, hashed, never the value', () => {
  const token = 'tok_abcdefghijklmnop';
  const key = credentialKey(req({ authorization: `Bearer ${token}` }));
  assert.ok(key && !key.includes(token));
  assert.equal(credentialKey(req({ cookie: `x=1; helmion_admin_session=${token}` })), key);
  assert.equal(credentialKey(req({ cookie: 'theme=dark' })), null);
  assert.equal(credentialKey(req()), null);
});

test('headers: baseline security headers are set, existing ones kept', () => {
  const guard = createHttpGuard({ env: {} });
  const res = fakeRes();
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  assert.equal(guard.check(req(), res), false);
  for (const k of Object.keys(BASELINE_SECURITY_HEADERS)) assert.ok(res.headers[k], k);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
});

test('https: plain http is redirected (GET) or refused (POST); localhost is exempt', () => {
  const guard = createHttpGuard({ env: {}, log: () => {} });
  const r1 = fakeRes();
  assert.equal(guard.check(req({ 'x-forwarded-proto': 'http' }), r1), true);
  assert.equal(r1.statusCode, 308);
  assert.equal(r1.headers.location, 'https://helmian.cloud/api/admin/session');
  const r2 = fakeRes();
  assert.equal(guard.check(req({ 'x-forwarded-proto': 'http' }, { method: 'POST' }), r2), true);
  assert.equal(r2.statusCode, 403);
  assert.equal(guard.check(req({ 'x-forwarded-proto': 'http', host: 'localhost:3000' }), fakeRes()), false);
  assert.equal(createHttpGuard({ env: { HELMIAN_HTTP_REQUIRE_HTTPS: 'off' } }).check(req({ 'x-forwarded-proto': 'http' }), fakeRes()), false);
});

test('size: a declared body over the ceiling is refused with 413', () => {
  const guard = createHttpGuard({ env: {}, log: () => {} });
  const res = fakeRes();
  assert.equal(guard.check(req({ 'content-length': String(5 * 1024 * 1024) }, { method: 'POST' }), res), true);
  assert.equal(res.statusCode, 413);
  assert.equal(guard.check(req({ 'content-length': '1024' }, { method: 'POST' }), fakeRes()), false);
});

test('rate: anonymous requests are limited per IP, with Retry-After, and recover', () => {
  let t = 0;
  const guard = createHttpGuard({ config: { anonPerIp: 5, windowMs: 1000 }, now: () => t, log: () => {} });
  const anon = req({ 'x-vercel-forwarded-for': '1.1.1.1' });
  for (let i = 0; i < 5; i += 1) assert.equal(guard.check(anon, fakeRes()), false);
  const res = fakeRes();
  assert.equal(guard.check(anon, res), true);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['retry-after']) >= 1);
  // A different IP is unaffected.
  assert.equal(guard.check(req({ 'x-vercel-forwarded-for': '2.2.2.2' }), fakeRes()), false);
  // Two windows later the count is clear.
  t = 2500;
  assert.equal(guard.check(anon, fakeRes()), false);
});

test('rate: credentialed requests count per credential, so one office IP is not one bucket', () => {
  const guard = createHttpGuard({ config: { anonPerIp: 2, perCredential: 3, windowMs: 60_000 }, now: () => 0, log: () => {} });
  const ip = { 'x-vercel-forwarded-for': '3.3.3.3' };
  for (let u = 0; u < 5; u += 1) {
    for (let i = 0; i < 3; i += 1) assert.equal(guard.check(req({ ...ip, authorization: `Bearer user-token-${u}-abcdefgh` }), fakeRes()), false, `user ${u} req ${i}`);
  }
  assert.equal(guard.check(req({ ...ip, authorization: 'Bearer user-token-0-abcdefgh' }), fakeRes()), true);
});

test('rate: the per-IP ceiling holds even when credentials rotate', () => {
  const guard = createHttpGuard({ config: { ipCeiling: 4, perCredential: 100, windowMs: 60_000 }, now: () => 0, log: () => {} });
  for (let i = 0; i < 4; i += 1) assert.equal(guard.check(req({ authorization: `Bearer rotating-${i}-abcdefgh` }), fakeRes()), false);
  assert.equal(guard.check(req({ authorization: 'Bearer rotating-9-abcdefgh' }), fakeRes()), true);
});

test('rate: the default limits leave the app\'s fastest poll (4 per second) untouched', () => {
  let t = 0;
  const guard = createHttpGuard({ env: {}, now: () => t, log: () => {} });
  const tab = req({ 'x-vercel-forwarded-for': '4.4.4.4', cookie: 'helmion_admin_session=sealed-session-value' });
  for (let i = 0; i < 4 * 60 * 3; i += 1) { t += 250; assert.equal(guard.check(tab, fakeRes()), false, `poll ${i}`); }
});

test('rate: the tracked-key map is bounded', () => {
  const guard = createHttpGuard({ config: { maxTrackedKeys: 50 }, now: () => 0, log: () => {} });
  for (let i = 0; i < 500; i += 1) guard.check(req({ 'x-vercel-forwarded-for': `9.0.${i >> 8}.${i & 255}` }), fakeRes());
  assert.ok(guard.trackedKeys() <= 150);
});

test('off: the switch disables every check', () => {
  const guard = createHttpGuard({ env: { HELMIAN_HTTP_GUARD: 'off' } });
  assert.equal(guard.check(req({ 'x-forwarded-proto': 'http', 'content-length': '999999999' }), fakeRes()), false);
});

test('timeouts: a Node server gets header, request and keep-alive bounds', () => {
  const server = hardenServerTimeouts(http.createServer());
  assert.equal(server.headersTimeout, SERVER_TIMEOUTS.headersTimeout);
  assert.equal(server.requestTimeout, SERVER_TIMEOUTS.requestTimeout);
  assert.equal(server.keepAliveTimeout, SERVER_TIMEOUTS.keepAliveTimeout);
  assert.equal(server.maxHeadersCount, SERVER_TIMEOUTS.maxHeadersCount);
  assert.ok(SERVER_TIMEOUTS.headersTimeout < SERVER_TIMEOUTS.requestTimeout);
});

test('website headers: HTTPS-only CSP, HSTS, and the anti-sniff / anti-frame set', async () => {
  const { readFileSync } = await import('node:fs');
  const vercel = JSON.parse(readFileSync(new URL('../web/marketing/vercel.json', import.meta.url), 'utf8'));
  const all = (vercel.headers ?? []).find((h) => h.source === '/(.*)').headers;
  const get = (k) => all.find((h) => h.key === k)?.value ?? '';
  const csp = get('Content-Security-Policy');
  assert.match(csp, /upgrade-insecure-requests/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // No plain-http or plain-ws source anywhere in the policy (mixed content).
  assert.doesNotMatch(csp, /\bhttp:\/\/|\bws:\/\//);
  assert.match(get('Strict-Transport-Security'), /^max-age=31536000; includeSubDomains/);
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get('X-Frame-Options'), 'DENY');
  assert.equal(get('X-Permitted-Cross-Domain-Policies'), 'none');
});
