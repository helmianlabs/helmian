// Helmian Site Guard — outbound redaction. The inbound screen
// (site-guard.mjs) stops attacks before they reach a seat; this is the
// second line: every seat reply is scanned at the one road replies are
// written by (envoy-mesh.mjs postAsAgent) and anything secret-shaped is
// replaced before the row is stored. The desk, the Discord and Slack
// bridges, and the public chat all read the stored row, so all of them
// get the redacted text. Nothing un-redacted is kept anywhere.
//
// What is redacted:
//   - every pattern src/agent/redact.mjs already knows (provider API
//     keys, GitHub/Slack/Stripe/AWS/Discord tokens, JWTs, PEM private
//     keys, Bearer tokens, database URLs with passwords, …) — reused by
//     import, not copied;
//   - labeled secrets: "password: hunter2!", "api_key=…",
//     "client_secret = …" (the "password is …" form only when the value
//     has a digit or symbol, so "the password is wrong" stays);
//   - credentials inside any URL: scheme://user:pass@host;
//   - public IPv4 addresses (the server's address is not for visitors).
//     Private, loopback, link-local, CGNAT, documentation, multicast
//     and well-known public resolver addresses are left alone, and so
//     is anything that reads as a version ("v1.2.3.4");
//   - IP-in-hostname names (1-2-3-4.sslip.io, 1.2.3.4.nip.io), which
//     carry the server address in the name.
// What is deliberately NOT redacted: bare hex strings (git SHAs,
// checksums, UUIDs), ordinary numbers, and words like "password" or
// "token" with no value next to them.
//
// The result names kinds and counts only — never the redacted text —
// so the metadata and the findings entry are safe to store.

import { redactSecrets } from '../agent/redact.mjs';

export const SITE_GUARD_OUTBOUND_KIND = 'helmian-site-guard-outbound-redaction';
export const SITE_GUARD_OUTBOUND_CLASS = 'outbound-secret';
export const OUTBOUND_MARK = Object.freeze({
  SECRET: '[REDACTED]',
  ADDRESS: '[REDACTED-ADDRESS]',
});

const MARKER = /\[REDACTED[^\]]*\]/g;
const countMarks = (s) => (s.match(MARKER) ?? []).length;

const LABEL = '(?:password|passwd|pwd|passphrase|secret|client[_ -]?secret|api[_ -]?key|apikey|access[_ -]?key|secret[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|private[_ -]?key|bearer[_ -]?token|db[_ -]?password|database[_ -]?password|token)';
// "label: value" / "label = value" / "LABEL=value" (env style).
const LABELED_ASSIGN = new RegExp(`(\\b[A-Za-z0-9_]*${LABEL}[A-Za-z0-9_]*["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED)([^\\s"',;]{4,})`, 'gi');
// "the password is X" where X has a digit or a symbol.
const LABELED_IS = new RegExp(`(\\b${LABEL}\\s+(?:is|was|=)\\s+["'\`]?)(?!\\[REDACTED)(?=[^\\s"'\`]*[0-9!@#$%^&*_+=~])([^\\s"'\`]{4,})`, 'gi');
const URL_CREDS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:/@]{1,128}):(?!\[REDACTED)([^\s@/]{1,256})@/gi;
const IPV4 = /(?<![\w.\-])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?![\w-]|\.\d)/g;
const IP_HOSTNAME = /\b(?:\d{1,3}[-.]){3}\d{1,3}\.(?:sslip\.io|nip\.io|xip\.io)\b/gi;
const PUBLIC_RESOLVERS = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220']);

/** True for an IPv4 address that is routable on the public internet. */
export function isPublicIpv4(ip) {
  const o = String(ip).split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/**
 * Redact one outbound text. Pure. Returns
 *   { text, redacted, redactions: [{ kind, count }] }
 * `redacted` is true when anything changed.
 */
export function redactOutbound(input) {
  if (typeof input !== 'string' || !input) return Object.freeze({ text: input ?? '', redacted: false, redactions: Object.freeze([]) });
  const counts = new Map();
  const bump = (kind, n) => { if (n > 0) counts.set(kind, (counts.get(kind) ?? 0) + n); };
  let text = input;

  const before = countMarks(text);
  text = redactSecrets(text);
  bump('known-token', countMarks(text) - before);

  text = text.replace(URL_CREDS, (_m, scheme, user) => { bump('url-credentials', 1); return `${scheme}${user}:${OUTBOUND_MARK.SECRET}@`; });
  text = text.replace(LABELED_ASSIGN, (m, label, value) => {
    // "x = value" always counts. The "label: value" form is also how
    // prose reads ("The secret: keep practicing"), so there the value
    // must look like a secret: a digit or symbol, or 16+ characters.
    if (!label.includes('=') && !/[0-9!@#$%^&*_+=~\-]/.test(value) && value.length < 16) return m;
    bump('labeled-secret', 1);
    return `${label}${OUTBOUND_MARK.SECRET}`;
  });
  text = text.replace(LABELED_IS, (_m, label) => { bump('labeled-secret', 1); return `${label}${OUTBOUND_MARK.SECRET}`; });
  text = text.replace(IP_HOSTNAME, () => { bump('server-address', 1); return OUTBOUND_MARK.ADDRESS; });
  text = text.replace(IPV4, (m, ip, offset, whole) => {
    if (!isPublicIpv4(ip) || PUBLIC_RESOLVERS.has(ip)) return m;
    const lead = whole.slice(Math.max(0, offset - 12), offset);
    if (/(?:\bv|version\s*|ver\.?\s*|release\s*|build\s*)$/i.test(lead)) return m;
    bump('server-address', 1);
    return OUTBOUND_MARK.ADDRESS;
  });

  const redactions = [...counts].map(([kind, count]) => Object.freeze({ kind, count }));
  return Object.freeze({ text, redacted: redactions.length > 0, redactions: Object.freeze(redactions) });
}

/** The metadata record a redacted reply carries (kinds and counts only). */
export function siteGuardOutboundRecord(result) {
  return Object.freeze({
    kind: SITE_GUARD_OUTBOUND_KIND,
    redactions: result.redactions.map((r) => ({ kind: r.kind, count: r.count })),
  });
}

/**
 * The findings-store input for one redacted reply, or null when
 * nothing was redacted. Same source and fingerprint scheme as the
 * intake screen's findings.
 */
export function siteGuardOutboundFinding(result, { channelId, channelSlug = null, messageId, provider = null, at }) {
  if (!result?.redacted) return null;
  const where = channelSlug ? ` in #${channelSlug}` : '';
  return Object.freeze({
    fingerprint: `helmian-site-guard:${SITE_GUARD_OUTBOUND_CLASS}:${String(messageId)}`,
    source: 'site-guard',
    severity: 'warning',
    title: `Helmian Site Guard redacted secret-looking text from a seat reply${where}`,
    detail: Object.freeze({
      kind: SITE_GUARD_OUTBOUND_KIND,
      class: SITE_GUARD_OUTBOUND_CLASS,
      hits: result.redactions.map((r) => `${r.kind} x${r.count}`),
      action: 'redact',
      stopped: false,
      channelId: String(channelId),
      ...(channelSlug ? { channelSlug: String(channelSlug) } : {}),
      messageId: String(messageId),
      ...(provider ? { provider: String(provider) } : {}),
      screenedAt: String(at),
    }),
    pageRef: null,
  });
}
