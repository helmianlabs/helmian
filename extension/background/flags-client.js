// Flags API client (Paul's shared-memory-mcp, branch `saas`, docs/FLAGS_API.md).
// OPT-IN and OFF BY DEFAULT. Nothing here makes a request unless the person
// turned reporting on in the popup, entered the base URL and pasted an API key.
//
// Contract used (read from the saas branch at 052f2bd on 2026-10-22):
//   POST {base}/api/flags        report one flag        scope flags.write   -> 201
//   GET  {base}/api/flags        list (alerts)          scope flags.read    -> 200
//   POST {base}/api/flags/scan   scan without storing   scope flags.read    -> 200
//   Authorization: Bearer smk_…   400 bad body, 401 bad/revoked key or scope,
//   402 over the tenant's daily call limit (resets at the UTC day).
//
// Only REDACTED text leaves the browser for reports: reason and excerpt are run
// through redactSensitivePrompt() here again, whatever the content script did.
// The API key is stored in extension storage like the Executive Guard token,
// is never returned to the popup or a page, and is never logged.

import { redactSensitivePrompt } from './redact.js';

export const FLAGS_SETTINGS_KEY = 'helmion.flags.settings';
export const FLAGS_STATE_KEY = 'helmion.flags.state';
export const FLAGS_QUEUE_KEY = 'helmion.flags.queue.v2';
export const LEGACY_QUEUE_KEY = 'helmion.flags.queue';
export const MAX_QUEUE = 200;
export const SEND_PER_TRIGGER = 5;
export const DEFAULT_DAILY_BUDGET = 100;
export const SCAN_MAX_CHARS = 50000;
export const ALERT_POLL_MIN_MS = 60 * 1000;
export const ALERT_KEEP = 20;
export const TIMEOUT_MS = 4000;
export const SCAN_TIMEOUT_MS = 2500;

export const FLAG_KINDS = Object.freeze(['evasion', 'privacy-leak', 'harmful-code']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const CATEGORIES = Object.freeze(['secret', 'pii', 'harmful_code', 'hedging', 'privacy', 'moderation', 'other']);
const API_KEY = /^smk_[A-Za-z0-9_-]{20,200}$/;

// docs/FLAGS_API.md checklist item 3 names these source_ai values.
const SOURCE_AI = Object.freeze({
  'claude.ai': 'claude.ai',
  'chatgpt.com': 'chatgpt',
  'gemini.google.com': 'gemini',
  'grok.com': 'grok',
});
const CRITICAL_CODE = new Set(['reverse-shell', 'credential-theft']);

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

export function isValidApiKey(value) {
  return typeof value === 'string' && API_KEY.test(value);
}

export function sourceAiFor(site) {
  const host = String(site || '').toLowerCase().replace(/^www\./, '');
  return SOURCE_AI[host] || (host ? host.slice(0, 60) : 'unknown');
}

// Page URL without query or fragment, and only for the four chat sites.
export function safePageUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return undefined;
    if (!SOURCE_AI[url.hostname.replace(/^www\./, '')]) return undefined;
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return undefined;
  }
}

function signalsOf(flag) {
  if (Array.isArray(flag.signals)) return flag.signals.map(String);
  return String(flag.rule || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Guard flag -> {category, severity} in the Flags API's vocabulary. */
export function classify(flag) {
  if (flag.kind === 'evasion') return { category: 'hedging', severity: 'low' };
  if (flag.kind === 'harmful-code') return { category: 'harmful_code', severity: CRITICAL_CODE.has(flag.rule) ? 'critical' : 'high' };
  const signals = signalsOf(flag);
  const secrets = signals.filter((s) => s.startsWith('secret:') && s !== 'secret:credit_card');
  if (secrets.length) return { category: 'secret', severity: secrets.includes('secret:private_key') ? 'critical' : 'high' };
  if (signals.some((s) => s === 'secret:credit_card' || s === 'pii:ssn')) return { category: 'pii', severity: 'high' };
  return { category: 'privacy', severity: 'medium' };
}

function clean(text, max) {
  return redactSensitivePrompt(String(text ?? '').slice(0, max)).text.replace(/\s+/g, ' ').trim();
}

/** Shapes one Guard flag as a POST /api/flags body. Returns null for anything malformed. */
export function toReportBody(flag, { version = '0.0.0', browser } = {}) {
  if (!flag || !FLAG_KINDS.includes(flag.kind)) return null;
  const { category, severity } = classify(flag);
  let reason = clean(flag.label, 1000);
  if (reason.length < 3) reason = `Helmion Guard flag: ${flag.kind}`;
  const body = {
    severity,
    category,
    reason,
    source_ai: sourceAiFor(flag.site),
    rule: `guard.${flag.kind}.${String(flag.rule || 'unknown')}`.slice(0, 80),
    reporter: `guard-extension/${String(version).slice(0, 20)}`,
    context: {
      guard_flag_id: String(flag.id || '').slice(0, 80),
      lane: flag.lane === 'code' ? 'code' : 'prose',
      ...(browser ? { browser: String(browser).slice(0, 20) } : {}),
    },
  };
  const excerpt = clean(flag.excerpt, 5000);
  if (excerpt) body.excerpt = excerpt;
  const url = safePageUrl(flag.url);
  if (url) body.url = url;
  return body;
}

// ─── storage ────────────────────────────────────────────────────────────────

async function readObject(storage, key) {
  const value = await storage.get(key);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function readSettings(storage) {
  const s = await readObject(storage, FLAGS_SETTINGS_KEY);
  // 0.3.0 (unreleased) stored {flagsUrl, token} for a provisional contract.
  // That token was never an smk_ key; drop it rather than send it anywhere.
  if (s.token !== undefined || s.flagsUrl !== undefined) {
    const migrated = { enabled: false, baseUrl: s.baseUrl || '', apiKey: s.apiKey || '' };
    await storage.set(FLAGS_SETTINGS_KEY, migrated);
    await storage.set(LEGACY_QUEUE_KEY, []);
    return migrated;
  }
  return s;
}

const readState = (storage) => readObject(storage, FLAGS_STATE_KEY);
async function patchState(storage, patch) {
  const next = { ...(await readState(storage)), ...patch };
  await storage.set(FLAGS_STATE_KEY, next);
  return next;
}
async function readQueue(storage) {
  const q = await storage.get(FLAGS_QUEUE_KEY);
  return Array.isArray(q) ? q : [];
}

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export async function getFlagsSettings(storage, { now = Date.now() } = {}) {
  const s = await readSettings(storage);
  const st = await readState(storage);
  const queue = await readQueue(storage);
  const used = st.budgetDay === utcDay(now) ? st.budgetUsed || 0 : 0;
  return {
    enabled: s.enabled === true,
    baseUrl: s.baseUrl || '',
    hasKey: isValidApiKey(s.apiKey),
    scanBeforeSend: s.scanBeforeSend === true,
    dailyBudget: s.dailyBudget || DEFAULT_DAILY_BUDGET,
    callsToday: used,
    queued: queue.length,
    keyRejected: st.keyRejected === true,
    pausedUntil: st.pausedUntil && st.pausedUntil > now ? new Date(st.pausedUntil).toISOString() : null,
    lastError: st.lastError || null,
    lastReportAt: st.lastReportAt || null,
  };
}

export async function setFlagsSettings(storage, { enabled, baseUrl, apiKey, scanBeforeSend, dailyBudget } = {}) {
  const next = { ...(await readSettings(storage)) };
  if (typeof baseUrl === 'string') {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (trimmed && !isAllowedFlagsUrl(trimmed)) throw new Error('Flags server URL must be https://, or http://localhost for local testing');
    next.baseUrl = trimmed;
  }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    const key = apiKey.trim();
    if (!isValidApiKey(key)) throw new Error('That is not a Flags API key (they start with smk_)');
    next.apiKey = key;
    await patchState(storage, { keyRejected: false, lastError: null });
  }
  if (typeof scanBeforeSend === 'boolean') next.scanBeforeSend = scanBeforeSend;
  if (dailyBudget !== undefined) {
    const n = Number(dailyBudget);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error('Daily call budget must be a whole number from 1 to 100000');
    next.dailyBudget = n;
  }
  if (typeof enabled === 'boolean') next.enabled = enabled;
  await storage.set(FLAGS_SETTINGS_KEY, next);
  return getFlagsSettings(storage);
}

// ─── transport ──────────────────────────────────────────────────────────────

async function call(s, path, { method = 'GET', body, timeoutMs = TIMEOUT_MS, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(`${s.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${s.apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, error: error && error.name === 'AbortError' ? 'timed out' : 'could not reach the Flags server' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Checks configuration, the key, a 402 pause and the local daily budget, and
// counts the call. Returns the settings to use or a reason to skip.
async function permit(storage, now) {
  const s = await readSettings(storage);
  if (s.enabled !== true) return { skip: 'not-enabled' };
  if (!s.baseUrl || !isAllowedFlagsUrl(s.baseUrl)) return { skip: 'no-url' };
  if (!isValidApiKey(s.apiKey)) return { skip: 'no-key' };
  const st = await readState(storage);
  if (st.keyRejected) return { skip: 'key-rejected' };
  if (st.pausedUntil && st.pausedUntil > now) return { skip: 'daily-limit' };
  const day = utcDay(now);
  const used = st.budgetDay === day ? st.budgetUsed || 0 : 0;
  if (used >= (s.dailyBudget || DEFAULT_DAILY_BUDGET)) return { skip: 'budget' };
  await patchState(storage, { budgetDay: day, budgetUsed: used + 1 });
  return { s };
}

// Shared handling of the statuses every endpoint documents.
async function noteFailure(storage, result, now) {
  if (result.status === 401) {
    await patchState(storage, { keyRejected: true, lastError: 'The Flags server refused the API key (wrong, revoked, or missing a scope).' });
    return 'key-rejected';
  }
  if (result.status === 402) {
    await patchState(storage, { pausedUntil: nextUtcMidnight(now), lastError: 'The Flags account is over its daily call limit; paused until the next UTC day.' });
    return 'daily-limit';
  }
  if (result.status === 404) {
    await patchState(storage, { lastError: 'The Flags server has no /api/flags here. Check the URL (the REST API needs SaaS mode).' });
    return 'not-found';
  }
  await patchState(storage, { lastError: result.status ? `The Flags server answered ${result.status}.` : result.error });
  return result.status ? `http-${result.status}` : 'network';
}

// ─── report (POST /api/flags) ───────────────────────────────────────────────

/**
 * Queue a flag and send what is queued, one POST per flag (the API takes one
 * flag per request). Never throws. 400 drops that flag; 401/402/404 stop and
 * keep the queue; network errors and 5xx keep the queue for the next trigger.
 */
export async function reportFlag(storage, flag, { version, browser, fetchImpl, now = Date.now() } = {}) {
  const s = await readSettings(storage);
  if (s.enabled !== true) return { ok: true, skipped: 'not-enabled' };
  const body = flag ? toReportBody(flag, { version, browser }) : null;
  if (flag && !body) return { ok: false, error: 'malformed flag' };
  let queue = await readQueue(storage);
  if (body) {
    const id = body.context.guard_flag_id;
    queue = queue.filter((q) => !id || q.context?.guard_flag_id !== id);
    queue.push(body);
    while (queue.length > MAX_QUEUE) queue.shift();
    await storage.set(FLAGS_QUEUE_KEY, queue);
  }
  return flushQueue(storage, { fetchImpl, now });
}

export async function flushQueue(storage, { fetchImpl, now = Date.now() } = {}) {
  let queue = await readQueue(storage);
  let sent = 0;
  const serverFlags = [];
  let stopped = null;
  for (let i = 0; i < SEND_PER_TRIGGER && queue.length; i += 1) {
    const p = await permit(storage, now);
    if (p.skip) { stopped = p.skip; break; }
    const result = await call(p.s, '/api/flags', { method: 'POST', body: queue[0], fetchImpl });
    if (result.status === 201) {
      queue = queue.slice(1);
      sent += 1;
      const flags = Array.isArray(result.json?.flags) ? result.json.flags : [];
      for (const f of flags) if (f && f.origin === 'scanner') serverFlags.push({ category: String(f.category || ''), rule: String(f.rule || ''), severity: String(f.severity || '') });
      await storage.set(FLAGS_QUEUE_KEY, queue);
      await patchState(storage, { lastReportAt: new Date(now).toISOString(), lastError: null });
      continue;
    }
    if (result.status === 400) {
      // The server will never accept this body; keep the rest.
      queue = queue.slice(1);
      await storage.set(FLAGS_QUEUE_KEY, queue);
      await patchState(storage, { lastError: 'The Flags server rejected one flag as malformed; it was dropped.' });
      continue;
    }
    stopped = await noteFailure(storage, result, now);
    break;
  }
  const ok = !stopped || stopped === 'not-enabled';
  return { ok, sent, queued: queue.length, ...(stopped ? { stopped } : {}), ...(serverFlags.length ? { serverFlags } : {}) };
}

// ─── scan without storing (POST /api/flags/scan) ───────────────────────────

const REDACTING = new Set(['secret', 'pii']);

/**
 * Cross-check text with the server's scanner before it is sent to an AI.
 * Runs only if reporting AND scanBeforeSend are on. The text is redacted
 * locally first; Guard calls this only for text its own scan found clean.
 */
export async function scanText(storage, text, { fetchImpl, now = Date.now() } = {}) {
  const s = await readSettings(storage);
  if (s.enabled !== true || s.scanBeforeSend !== true) return { ok: false, skipped: 'not-enabled' };
  const input = String(text ?? '');
  if (!input.trim()) return { ok: true, redacted: input, redactions: 0, findings: [] };
  if (input.length > SCAN_MAX_CHARS) return { ok: false, skipped: 'too-long' };
  const local = redactSensitivePrompt(input).text;
  const p = await permit(storage, now);
  if (p.skip) return { ok: false, skipped: p.skip };
  const result = await call(p.s, '/api/flags/scan', { method: 'POST', body: { text: local }, timeoutMs: SCAN_TIMEOUT_MS, fetchImpl });
  if (result.status !== 200 || !result.json || typeof result.json.redacted !== 'string' || !Array.isArray(result.json.findings)) {
    const why = result.status === 200 ? 'bad-response' : await noteFailure(storage, result, now);
    return { ok: false, skipped: why };
  }
  const findings = result.json.findings.slice(0, 50).map((f) => ({
    category: String(f?.category || '').slice(0, 40),
    rule: String(f?.rule || '').slice(0, 80),
    severity: SEVERITIES.includes(f?.severity) ? f.severity : 'low',
    reason: String(f?.reason || '').slice(0, 300),
  }));
  return {
    ok: true,
    redacted: result.json.redacted,
    redactions: Number(result.json.redactions) || 0,
    findings,
    leaks: findings.filter((f) => REDACTING.has(f.category)),
  };
}

// ─── alerts (GET /api/flags?since=…&min_severity=high) ──────────────────────

function cleanAlert(f) {
  return {
    id: Number(f.id),
    severity: SEVERITIES.includes(f.severity) ? f.severity : 'low',
    category: String(f.category || '').slice(0, 40),
    rule: f.rule ? String(f.rule).slice(0, 80) : null,
    origin: String(f.origin || '').slice(0, 20),
    source_ai: f.source_ai ? String(f.source_ai).slice(0, 60) : null,
    reason: String(f.reason || '').slice(0, 300),
    excerpt: f.excerpt ? String(f.excerpt).slice(0, 300) : null,
    created_at: String(f.created_at || ''),
  };
}

/** Polls for high and critical flags. At most once a minute unless forced by a click. */
export async function pollAlerts(storage, { force = false, fetchImpl, now = Date.now() } = {}) {
  const st = await readState(storage);
  const cached = Array.isArray(st.alerts) ? st.alerts : [];
  const view = (extra) => ({
    alerts: cached,
    unseen: cached.filter((a) => a.id > (st.seenMaxId || 0)).length,
    polledAt: st.alertsPolledAt || null,
    ...extra,
  });
  if (!force && st.alertsPolledAt && now - Date.parse(st.alertsPolledAt) < ALERT_POLL_MIN_MS) return { ok: true, ...view({ cached: true }) };
  const p = await permit(storage, now);
  if (p.skip) return { ok: p.skip === 'not-enabled', ...view({ skipped: p.skip }) };
  const q = new URLSearchParams({ min_severity: 'high', limit: String(ALERT_KEEP) });
  if (st.alertsSince) q.set('since', st.alertsSince);
  const result = await call(p.s, `/api/flags?${q}`, { fetchImpl });
  if (result.status !== 200 || !Array.isArray(result.json?.flags)) {
    const why = result.status === 200 ? 'bad-response' : await noteFailure(storage, result, now);
    return { ok: false, ...view({ skipped: why }) };
  }
  const byId = new Map(cached.map((a) => [a.id, a]));
  for (const f of result.json.flags) { const a = cleanAlert(f); if (Number.isFinite(a.id)) byId.set(a.id, a); }
  const alerts = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ALERT_KEEP);
  // `since` is inclusive (created_at >= since); duplicates are merged by id above.
  const newest = alerts.reduce((m, a) => (a.created_at > m ? a.created_at : m), st.alertsSince || '');
  const next = await patchState(storage, { alerts, alertsSince: newest || undefined, alertsPolledAt: new Date(now).toISOString(), lastError: null });
  return { ok: true, alerts, unseen: alerts.filter((a) => a.id > (next.seenMaxId || 0)).length, polledAt: next.alertsPolledAt, installed: result.json.installed !== false };
}

export async function markAlertsSeen(storage) {
  const st = await readState(storage);
  const max = (Array.isArray(st.alerts) ? st.alerts : []).reduce((m, a) => Math.max(m, a.id), st.seenMaxId || 0);
  await patchState(storage, { seenMaxId: max });
  return { ok: true, seenMaxId: max };
}
