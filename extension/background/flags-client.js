// Reports Flags to the cross-AI Flags API. OPT-IN and OFF BY DEFAULT.
//
// CONTRACT STATUS: PROVISIONAL. The Flags API is owned by Paul in
// troy83352/shared-memory-mcp; on 2026-10-22 that repo had no `saas` branch and
// no docs/FLAGS_API.md, so this codes against the small interface below and is
// tested against a mock (test-support/mock-flags-api.mjs). When the real
// contract lands, only httpTransport() should need to change.
//
//   POST {flagsUrl}/v1/flags
//   Authorization: Bearer <flags token>
//   { "flags": [ { id, kind, severity, rule, label, site, lane, excerpt,
//                  detectedAt, source, sourceVersion } ] }
//   2xx -> { accepted: <number> }    401/403 -> stop (bad token)
//
// Only REDACTED excerpts ever leave the browser: every flag excerpt is run
// through redactSensitivePrompt() here again, whatever the content script did.
// Failed reports wait in a small capped queue and go out with the next report.

import { redactSensitivePrompt } from './redact.js';

export const FLAGS_SETTINGS_KEY = 'helmion.flags.settings';
export const FLAGS_QUEUE_KEY = 'helmion.flags.queue';
export const MAX_QUEUE = 200;
export const FLAG_KINDS = Object.freeze(['evasion', 'privacy-leak', 'harmful-code']);
const SEVERITIES = ['notice', 'medium', 'high'];

export function isAllowedFlagsUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Shapes and re-redacts one flag. Returns null for anything malformed. */
export function toWireFlag(flag, { version = '0.0.0', now = new Date() } = {}) {
  if (!flag || !FLAG_KINDS.includes(flag.kind)) return null;
  const clip = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: clip(flag.id, 80),
    kind: flag.kind,
    severity: SEVERITIES.includes(flag.severity) ? flag.severity : 'notice',
    rule: clip(flag.rule, 120),
    label: redactSensitivePrompt(clip(flag.label, 200)).text,
    site: clip(flag.site, 253).toLowerCase(),
    lane: flag.lane === 'code' ? 'code' : 'prose',
    excerpt: redactSensitivePrompt(clip(flag.excerpt, 300)).text,
    detectedAt: new Date(flag.detectedAt || now).toISOString(),
    source: 'helmian-guard-extension',
    sourceVersion: clip(version, 20),
  };
}

export function httpTransport({ flagsUrl, token, fetchImpl = (...args) => fetch(...args) }) {
  return async function send(flags) {
    const response = await fetchImpl(`${String(flagsUrl).replace(/\/+$/, '')}/v1/flags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ flags }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, fatal: response.status === 401 || response.status === 403 || response.status === 400 };
  };
}

async function readSettings(storage) {
  const value = await storage.get(FLAGS_SETTINGS_KEY);
  return value && typeof value === 'object' ? value : {};
}

export async function getFlagsSettings(storage) {
  const s = await readSettings(storage);
  const queue = (await storage.get(FLAGS_QUEUE_KEY)) || [];
  return { enabled: s.enabled === true, flagsUrl: s.flagsUrl || '', hasToken: Boolean(s.token), queued: queue.length };
}

export async function setFlagsSettings(storage, { enabled, flagsUrl, token } = {}) {
  const next = { ...(await readSettings(storage)) };
  if (typeof flagsUrl === 'string') {
    const trimmed = flagsUrl.trim().replace(/\/+$/, '');
    if (trimmed && !isAllowedFlagsUrl(trimmed)) throw new Error('Flags API URL must be https://, or http://localhost for a local mock');
    next.flagsUrl = trimmed;
  }
  if (typeof token === 'string') next.token = token.trim();
  if (typeof enabled === 'boolean') next.enabled = enabled;
  await storage.set(FLAGS_SETTINGS_KEY, next);
  return getFlagsSettings(storage);
}

/**
 * Queue a flag and try to deliver everything queued. Never throws.
 * `transport` is injectable for tests; by default it is the HTTP transport.
 */
export async function reportFlag(storage, flag, { version, transport, fetchImpl } = {}) {
  const s = await readSettings(storage);
  if (!s.enabled || !s.flagsUrl || !s.token) return { ok: true, skipped: 'not-enabled' };
  const wire = toWireFlag(flag, { version });
  if (!wire) return { ok: false, error: 'malformed flag' };

  const queue = ((await storage.get(FLAGS_QUEUE_KEY)) || []).filter((f) => f.id !== wire.id);
  queue.push(wire);
  while (queue.length > MAX_QUEUE) queue.shift();

  const send = transport || httpTransport({ flagsUrl: s.flagsUrl, token: s.token, fetchImpl });
  let result;
  try {
    result = await send(queue.slice(0, 25));
  } catch (error) {
    result = { ok: false, error: error && error.message ? error.message : String(error) };
  }
  if (result.ok) {
    const rest = queue.slice(25);
    await storage.set(FLAGS_QUEUE_KEY, rest);
    return { ok: true, sent: Math.min(queue.length, 25), queued: rest.length };
  }
  await storage.set(FLAGS_QUEUE_KEY, queue);
  return { ok: false, queued: queue.length, status: result.status, fatal: Boolean(result.fatal), error: result.error };
}
