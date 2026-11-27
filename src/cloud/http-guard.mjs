// Helmian Site Guard — HTTP layer: abuse limits and transport rules for
// the Helmian cloud function (web/marketing/api/helmian-admin.js) and
// slow-request timeouts for the Node servers.
//
// What this layer is, and is not:
//   - It is the application's own per-instance defense: per-IP and
//     per-credential request rates, a request-size ceiling, an HTTPS
//     rule, and baseline security headers. Counts live in this process
//     only (a serverless instance or one Node server); a deployment with
//     several instances enforces each window per instance.
//   - It is NOT a volumetric DDoS defense. A flood big enough to matter
//     must be stopped before it reaches a function or a server: Vercel
//     Firewall / Attack Challenge Mode for the website, Cloudflare (or the
//     host firewall) for the Hetzner box. docs/SECURITY_EDGE_AND_TRANSPORT.md
//     lists what to turn on there.
//
// Defaults are generous on purpose: the app polls (0.25 s to 15 s
// cadences), seat runners poll per device token, and several people can
// share one office IP. Requests that carry a credential are counted per
// credential (a hash of it, never the value), so one office or one box
// running many seats is not limited as a single IP. Anonymous requests
// are counted per IP. Every number is an environment setting, and
// HELMIAN_HTTP_GUARD=off turns the whole layer off.
//
// Env (all optional):
//   HELMIAN_HTTP_GUARD                 'off' disables the layer
//   HELMIAN_HTTP_RATE_WINDOW_MS        window length, default 60000
//   HELMIAN_HTTP_RATE_ANON_PER_IP      anonymous requests per IP per window, default 300
//   HELMIAN_HTTP_RATE_PER_CREDENTIAL   requests per credential per window, default 1200
//   HELMIAN_HTTP_RATE_IP_CEILING       all requests from one IP per window, default 6000
//   HELMIAN_HTTP_MAX_BODY_BYTES        declared request-size ceiling, default 4194304 (4 MB)
//   HELMIAN_HTTP_REQUIRE_HTTPS         'off' allows plain http (local dev only)

import { createHash } from 'node:crypto';

export const HTTP_GUARD_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  anonPerIp: 300,
  perCredential: 1200,
  ipCeiling: 6000,
  maxBodyBytes: 4 * 1024 * 1024,
  maxTrackedKeys: 20_000,
});

// Server timeouts for Node http servers. requestTimeout bounds how long
// a client may take to SEND its request (headers and body); it does not
// limit how long a response may stream, so long polls and SSE replies
// are unaffected. headersTimeout stops slowloris-style header dribbling.
export const SERVER_TIMEOUTS = Object.freeze({
  headersTimeout: 15_000,
  requestTimeout: 30_000,
  keepAliveTimeout: 5_000,
  maxHeadersCount: 100,
});

export const BASELINE_SECURITY_HEADERS = Object.freeze({
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'x-permitted-cross-domain-policies': 'none',
});

/** Apply SERVER_TIMEOUTS to a Node http/https server (or an Express app's server). */
export function hardenServerTimeouts(server, overrides = {}) {
  if (!server) return server;
  const t = { ...SERVER_TIMEOUTS, ...overrides };
  server.headersTimeout = t.headersTimeout;
  server.requestTimeout = t.requestTimeout;
  server.keepAliveTimeout = t.keepAliveTimeout;
  server.maxHeadersCount = t.maxHeadersCount;
  return server;
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function httpGuardConfigFromEnv(env = process.env) {
  return Object.freeze({
    enabled: String(env?.HELMIAN_HTTP_GUARD ?? '').trim().toLowerCase() !== 'off',
    requireHttps: String(env?.HELMIAN_HTTP_REQUIRE_HTTPS ?? '').trim().toLowerCase() !== 'off',
    windowMs: num(env?.HELMIAN_HTTP_RATE_WINDOW_MS, HTTP_GUARD_DEFAULTS.windowMs),
    anonPerIp: num(env?.HELMIAN_HTTP_RATE_ANON_PER_IP, HTTP_GUARD_DEFAULTS.anonPerIp),
    perCredential: num(env?.HELMIAN_HTTP_RATE_PER_CREDENTIAL, HTTP_GUARD_DEFAULTS.perCredential),
    ipCeiling: num(env?.HELMIAN_HTTP_RATE_IP_CEILING, HTTP_GUARD_DEFAULTS.ipCeiling),
    maxBodyBytes: num(env?.HELMIAN_HTTP_MAX_BODY_BYTES, HTTP_GUARD_DEFAULTS.maxBodyBytes),
    maxTrackedKeys: HTTP_GUARD_DEFAULTS.maxTrackedKeys,
  });
}

const header = (req, name) => {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : (v == null ? '' : String(v));
};

/**
 * The client IP. helmian.cloud is proxied by Cloudflare in front of
 * Vercel, so Vercel's own header holds a Cloudflare address and the
 * visitor's address is in cf-connecting-ip (Cloudflare overwrites it on
 * every proxied request). Order: cf-connecting-ip, x-vercel-forwarded-for,
 * x-real-ip, x-forwarded-for's first hop, the socket. A client that skips
 * Cloudflare and calls the Vercel URL directly can set cf-connecting-ip
 * itself and pick its own bucket; the edge rules, which see the real
 * address, are the defense there. Never trusted for anything but a rate
 * key.
 */
export function clientIp(req) {
  const first = (v) => v.split(',')[0].trim();
  const ip = first(header(req, 'cf-connecting-ip'))
    || first(header(req, 'x-vercel-forwarded-for'))
    || first(header(req, 'x-real-ip'))
    || first(header(req, 'x-forwarded-for'))
    || String(req?.socket?.remoteAddress ?? '');
  return ip.slice(0, 64) || 'unknown';
}

// The session cookie first; any other Helmian cookie as a fallback.
const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-|__Secure-)?helmion_admin_session=([^;]{8,})/i;
const OTHER_COOKIE = /(?:^|;\s*)(?:__Host-|__Secure-)?(?:helmion|helmian)_[\w-]*=([^;]{8,})/i;

/** A hash of the request's credential (bearer token or session cookie), or null. */
export function credentialKey(req) {
  const auth = header(req, 'authorization');
  const bearer = /^bearer\s+(\S{8,})/i.exec(auth)?.[1];
  const cookies = header(req, 'cookie');
  const cookie = SESSION_COOKIE.exec(cookies)?.[1] ?? OTHER_COOKIE.exec(cookies)?.[1];
  const value = bearer || cookie;
  if (!value) return null;
  return createHash('sha256').update(value).digest('base64url').slice(0, 22);
}

function isLocalHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

// A fixed window plus the previous window's count, weighted by how
// much of it still overlaps: close to a true sliding window at the cost
// of two numbers per key.
function windowCounter({ windowMs, maxTrackedKeys, now }) {
  const buckets = new Map();
  const evict = (t) => {
    for (const [k, v] of buckets) {
      if (buckets.size < maxTrackedKeys) return;
      if (t - v.start >= 2 * windowMs) buckets.delete(k);
    }
    while (buckets.size >= maxTrackedKeys) buckets.delete(buckets.keys().next().value);
  };
  return {
    hit(key) {
      const t = now();
      let b = buckets.get(key);
      if (b && t - b.start >= windowMs) {
        const rolled = t - b.start < 2 * windowMs;
        b = { start: rolled ? b.start + windowMs : t, count: 0, prev: rolled ? b.count : 0 };
        buckets.set(key, b);
      }
      if (!b) {
        if (buckets.size >= maxTrackedKeys) evict(t);
        b = { start: t, count: 0, prev: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      const overlap = Math.max(0, 1 - (t - b.start) / windowMs);
      return { estimate: b.count + b.prev * overlap, resetMs: Math.max(0, b.start + windowMs - t) };
    },
    size: () => buckets.size,
  };
}

/**
 * Build one guard (one per process / function instance). `check(req,
 * res)` runs before routing and returns true when it has answered the
 * request itself (redirect, 413, 429); the caller then stops.
 */
export function createHttpGuard({ env = process.env, config = null, now = () => Date.now(), log = (event) => console.log(JSON.stringify(event)) } = {}) {
  const cfg = config ? { ...httpGuardConfigFromEnv({}), ...config } : httpGuardConfigFromEnv(env);
  const perIp = windowCounter({ windowMs: cfg.windowMs, maxTrackedKeys: cfg.maxTrackedKeys, now });
  const perCred = windowCounter({ windowMs: cfg.windowMs, maxTrackedKeys: cfg.maxTrackedKeys, now });
  const anon = windowCounter({ windowMs: cfg.windowMs, maxTrackedKeys: cfg.maxTrackedKeys, now });

  const answer = (res, status, code, extraHeaders = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ valid: false, code }));
    return true;
  };

  function check(req, res) {
    if (!cfg.enabled) return false;
    for (const [k, v] of Object.entries(BASELINE_SECURITY_HEADERS)) {
      if (!res.getHeader?.(k)) res.setHeader(k, v);
    }
    const host = header(req, 'host');
    const proto = header(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
    if (cfg.requireHttps && proto === 'http' && !isLocalHost(host)) {
      log({ event: 'http_guard', action: 'https_required', method: req.method });
      if (req.method === 'GET' || req.method === 'HEAD') {
        return answer(res, 308, 'HTTPS_REQUIRED', { location: `https://${host}${req.url ?? '/'}` });
      }
      return answer(res, 403, 'HTTPS_REQUIRED');
    }
    const declared = Number(header(req, 'content-length') || 0);
    if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) {
      log({ event: 'http_guard', action: 'payload_too_large', bytes: declared });
      return answer(res, 413, 'PAYLOAD_TOO_LARGE');
    }
    const ip = clientIp(req);
    const ceiling = perIp.hit(ip);
    if (ceiling.estimate > cfg.ipCeiling) {
      log({ event: 'http_guard', action: 'rate_limited', scope: 'ip-ceiling' });
      return answer(res, 429, 'RATE_LIMITED', { 'retry-after': String(Math.ceil(ceiling.resetMs / 1000) || 1) });
    }
    const cred = credentialKey(req);
    const verdict = cred ? perCred.hit(cred) : anon.hit(ip);
    const limit = cred ? cfg.perCredential : cfg.anonPerIp;
    if (verdict.estimate > limit) {
      log({ event: 'http_guard', action: 'rate_limited', scope: cred ? 'credential' : 'anonymous-ip' });
      return answer(res, 429, 'RATE_LIMITED', { 'retry-after': String(Math.ceil(verdict.resetMs / 1000) || 1) });
    }
    return false;
  }

  return { check, config: cfg, trackedKeys: () => perIp.size() + perCred.size() + anon.size() };
}
