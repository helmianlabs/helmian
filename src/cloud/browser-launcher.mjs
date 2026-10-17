// Browser launcher (BROWSE-001, phase 2): a validated URL launcher, not a
// browser. The cloud NEVER fetches page content (fetching a user-supplied URL
// server-side is SSRF). On valid input the endpoint appends an audit event and
// returns the normalized URL; the frontend opens it in the user's own browser.
//
// URL validation mirrors the desktop policy
// (desktop/Helmion.Desktop.Core/EmbeddedBrowserPolicy.cs): public HTTPS hosts
// only. Localhost, private/loopback/link-local IPs, credentials embedded in
// the URL, and non-HTTPS schemes are denied. DNS is resolved and every
// returned address is re-checked, exactly like ValidateAsync.
//
// Route handling lives here next to the validator so the live admin handler
// only imports and delegates (live-admin.mjs is near the push tool's size
// limit).

import { promises as dns } from 'node:dns';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

export const BROWSER_NAVIGATE_PATH = '/api/admin/browser/navigate';

const MAX_URL_CHARS = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

function denied(message) {
  return Object.freeze({ allowed: false, url: null, message });
}

// --- IP parsing (mirrors BrowserReferenceReader.IsPublicAddress) ---

function parseIPv4(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function expandIPv6(host) {
  const lower = String(host).toLowerCase();
  // Pull off an embedded IPv4 tail ("::ffff:192.0.2.1").
  let v4Tail = null;
  let head = lower;
  const v4Match = lower.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[2]);
    if (!v4) return null;
    v4Tail = [((v4[0] << 8) | v4[1]) >>> 0, ((v4[2] << 8) | v4[3]) >>> 0];
    head = `${v4Match[1]}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s) => {
    if (s === '') return [];
    const groups = s.split(':');
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return null;
  let groups;
  if (v4Tail) {
    const rightWithoutPlaceholder = right.slice(0, Math.max(0, right.length - 2));
    groups = [
      ...left,
      ...new Array(8 - left.length - rightWithoutPlaceholder.length - 2).fill(0),
      ...rightWithoutPlaceholder,
      ...v4Tail,
    ];
  } else if (halves.length === 2) {
    groups = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

export function isPublicIPv4Bytes(bytes) {
  const [b0, b1, b2] = bytes;
  if (b0 === 0 || b0 === 10 || b0 === 127) return false;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return false;
  if (b0 === 169 && b1 === 254) return false;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return false;
  if (b0 === 192 && (b1 === 0 || b1 === 168)) return false;
  if (b0 === 198 && (b1 === 18 || b1 === 19 || b1 === 51)) return false;
  if (b0 === 203 && b1 === 0 && b2 === 113) return false;
  return b0 < 224;
}

export function isPublicIPv6Groups(groups) {
  const [h0, h1] = groups;
  const isLoopback = groups.every((g, i) => g === (i === 7 ? 1 : 0));
  if (isLoopback) return false;
  if ((h0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((h0 & 0xff00) === 0xff00) return false; // multicast
  if ((h0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if (groups.every((g) => g === 0)) return false; // unspecified
  if ((h0 & 0xfe00) === 0xfc00) return false; // unique-local
  if (h0 === 0x2001 && h1 === 0x0db8) return false; // documentation
  return true;
}

// True when the literal IP address is public. IPv4-mapped IPv6 addresses are
// judged as IPv4, mirroring the desktop's MapToIPv4 behavior.
export function isPublicIpLiteral(host) {
  const h = String(host).replace(/^\[([^\]]+)\]$/, '$1');
  const v4 = parseIPv4(h);
  if (v4) return isPublicIPv4Bytes(v4);
  const v6 = expandIPv6(h);
  if (!v6) return null; // not an IP literal
  // IPv4-mapped: ::ffff:a.b.c.d (first five groups zero, sixth 0xffff)
  const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
  if (mapped) {
    const hi = v6[6];
    const lo = v6[7];
    return isPublicIPv4Bytes([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  }
  return isPublicIPv6Groups(v6);
}

async function defaultResolveHost(host) {
  return dns.lookup(host, { all: true });
}

// validateBrowserUrl mirrors EmbeddedBrowserPolicy.ValidateSyntax +
// ValidateAsync. resolveHost is injectable for tests:
// (host) => Promise<[{ address, family }]>.
export async function validateBrowserUrl(value, { resolveHost = defaultResolveHost } = {}) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return denied('Enter a public HTTPS website address.');
  if (candidate.length > MAX_URL_CHARS) return denied('The website address is too long.');

  const withScheme = candidate.includes('://') ? candidate : `https://${candidate}`;
  let address;
  try {
    address = new URL(withScheme);
  } catch {
    return denied('Helmian Browser opens public HTTPS websites only.');
  }
  if (address.protocol !== 'https:' || !address.hostname) {
    return denied('Helmian Browser opens public HTTPS websites only.');
  }
  if (address.username || address.password) {
    return denied('Website addresses containing embedded credentials are refused.');
  }
  const host = address.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return denied('Local and private-network websites are outside the Browser boundary.');
  }
  const literal = isPublicIpLiteral(host);
  if (literal === false) {
    return denied('Local and private-network websites are outside the Browser boundary.');
  }
  if (literal === true) return Object.freeze({ allowed: true, url: address.href, message: 'Public HTTPS website is eligible for opening.' });

  // Hostname: resolve DNS and re-check every returned address.
  let resolved;
  try {
    resolved = await resolveHost(host);
  } catch {
    return denied('The website host could not be resolved.');
  }
  const addresses = Array.isArray(resolved) ? resolved : [];
  if (!addresses.length) return denied('The website host returned no usable network address.');
  for (const entry of addresses) {
    const ip = String(entry?.address ?? '');
    if (isPublicIpLiteral(ip) !== true) {
      return denied('The website resolves to a local or private-network address, so Helmian blocked it.');
    }
  }
  return Object.freeze({ allowed: true, url: address.href, message: 'Public HTTPS website is eligible for opening.' });
}

// --- trivial per-actor rate limit (boring by design) ---

const rateBuckets = new Map();

export function checkBrowserRateLimit(key, now = Date.now()) {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => t <= windowStart)) rateBuckets.delete(k);
      if (rateBuckets.size <= 4000) break;
    }
  }
  return true;
}

export function clearBrowserRateLimits() {
  rateBuckets.clear();
}

async function recordNavigation(pool, actor, url) {
  const context = {
    tenantId: actor.tenantId,
    actorSubject: actor.subject,
    actorRole: actor.role,
    sessionId: actor.sessionId,
    requestId: actor.requestId,
  };
  return withTenantTransaction(pool, context, async (client) => {
    await requireActiveTenantMembership(client, context);
    const receiptId = await appendAuditEvent(client, context, {
      actionType: 'browser.navigation_requested',
      canonicalTarget: { resource: 'browser_navigation', url },
      policyVersion: 'browser-launcher.v1',
      decision: 'ALLOW',
      privacySummary: 'User opened a validated public HTTPS URL in their own browser; the cloud never fetched page content',
      result: { url, execution: 'not_performed', pageFetch: 'not_performed' },
    });
    return { receiptId };
  });
}

// HTTP route handling for the browser launcher. Returns true when the
// request was handled, false when it is not a browser route.
export async function handleBrowserRoute({ request, response, requestUrl, pool, activeTenantActor, send, readJsonObject, exactKeys, TenantAuthorizationError }) {
  if (request.method !== 'POST' || requestUrl.pathname !== BROWSER_NAVIGATE_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    const actor = await activeTenantActor(request);
    const body = await readJsonObject(request);
    exactKeys(body, ['url']);
    if (Object.prototype.hasOwnProperty.call(body, 'tenantId')) throw new Error('tenant selector is not accepted');
    if (!checkBrowserRateLimit(`${actor.tenantId}:${actor.subject}`)) {
      send(response, 429, JSON.stringify({ valid: false, code: 'BROWSER_RATE_LIMITED' }));
      return true;
    }
    const decision = await validateBrowserUrl(body.url);
    if (!decision.allowed) {
      send(response, 400, JSON.stringify({ valid: false, code: 'BROWSER_URL_REJECTED', message: decision.message }));
      return true;
    }
    const receipt = await recordNavigation(pool, actor, decision.url);
    send(response, 200, JSON.stringify({ valid: true, ok: true, url: decision.url, receiptId: receipt.receiptId }));
  } catch (error) {
    const status = membershipError(error) ? 403 : 400;
    send(response, status, JSON.stringify({ valid: false, code: membershipError(error) ? 'BROWSER_MEMBERSHIP_REQUIRED' : 'BROWSER_NAVIGATE_INVALID' }));
  }
  return true;
}
