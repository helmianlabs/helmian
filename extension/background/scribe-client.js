// Scribe "door-knock": poll Helmian Scribe for unread letters, badge + notify,
// open a letter and send a receipt. OPT-IN and OFF BY DEFAULT: nothing here
// makes a request unless the person enabled it in the popup, entered the Scribe
// URL (and granted that one origin) and pasted a token.
//
// Contract status (2026-10-29): Paul's door-knock contract
// (/workspace/scribe/door-knock-contract.md) has NOT landed yet. What is used:
//   GET  {base}/mailbox-status            EXISTS on Scribe main (f58c762):
//        {generated_at, mailboxes:[{tag:'for-<agent>', agent?, count, newest:{id,sender,created_at,subject}|null}]}
//        Bearer: smk_ key with mailbox.read (SaaS) or MAILBOX_STATUS_TOKEN (self-host).
//   GET  {base}/api/courier/messages/:id  PROVISIONAL (mocked) -> {id, from, subject, body, created_at}
//   POST {base}/api/courier/messages/:id/receipt  PROVISIONAL (mocked) -> {ok:true}
// Change SCRIBE_PATHS when the contract lands. The token is never returned to the
// popup or a page and is never logged.

export const SCRIBE_SETTINGS_KEY = 'helmion.scribe.settings';
export const SCRIBE_STATE_KEY = 'helmion.scribe.state';
export const SCRIBE_ALARM = 'helmion-scribe-poll';
export const SCRIBE_PATHS = Object.freeze({
  status: () => '/mailbox-status',
  letter: (id) => `/api/courier/messages/${encodeURIComponent(id)}`,
  receipt: (id) => `/api/courier/messages/${encodeURIComponent(id)}/receipt`,
});
export const MIN_PERIOD_MIN = 1; // chrome.alarms floor is 30 s in MV3; 1 min is well above it.
export const MAX_PERIOD_MIN = 2;
export const DEFAULT_PERIOD_MIN = 2;
export const DEFAULT_DAILY_BUDGET = 1000; // polls per UTC day; 1/min = 1440, 1/2min = 720.
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const TIMEOUT_MS = 5000;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export function isAllowedScribeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch { return false; }
}
export function scribeOriginPattern(value) {
  const u = new URL(String(value));
  return `${u.protocol}//${u.hostname}/*`;
}
export function clampPeriod(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_PERIOD_MIN;
  return Math.min(MAX_PERIOD_MIN, Math.max(MIN_PERIOD_MIN, v));
}
function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }
function nextUtcMidnight(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }

async function readObj(storage, key) { const v = await storage.get(key); return v && typeof v === 'object' ? v : {}; }
async function readSettings(storage) {
  const s = await readObj(storage, SCRIBE_SETTINGS_KEY);
  return {
    enabled: s.enabled === true, baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
    token: typeof s.token === 'string' ? s.token : '', mailbox: typeof s.mailbox === 'string' ? s.mailbox : '',
    periodMinutes: clampPeriod(s.periodMinutes ?? DEFAULT_PERIOD_MIN),
    dailyBudget: Number.isInteger(s.dailyBudget) ? s.dailyBudget : DEFAULT_DAILY_BUDGET,
    notify: s.notify !== false,
  };
}
export async function readScribeState(storage) { return readObj(storage, SCRIBE_STATE_KEY); }
async function patchState(storage, patch) {
  const next = { ...(await readScribeState(storage)), ...patch };
  await storage.set(SCRIBE_STATE_KEY, next);
  return next;
}

/** Public view of settings: never the token. */
export async function getScribeSettings(storage) {
  const s = await readSettings(storage);
  const st = await readScribeState(storage);
  const { token, ...rest } = s;
  return { ...rest, hasToken: Boolean(token), tokenRejected: st.tokenRejected === true };
}
export function isReady(s, st = {}) { return s.enabled && Boolean(s.baseUrl) && Boolean(s.token) && st.tokenRejected !== true; }

export async function setScribeSettings(storage, patch = {}) {
  const next = await readSettings(storage);
  if (typeof patch.baseUrl === 'string') {
    const t = patch.baseUrl.trim().replace(/\/+$/, '');
    if (t && !isAllowedScribeUrl(t)) throw new Error('Scribe URL must be https://, or http://localhost for local testing');
    next.baseUrl = t;
  }
  if (typeof patch.token === 'string' && patch.token.trim()) {
    const tok = patch.token.trim();
    if (!TOKEN.test(tok)) throw new Error('That does not look like a Scribe token');
    next.token = tok;
    await patchState(storage, { tokenRejected: false, lastError: null, failures: 0, nextAllowedAt: 0 });
  }
  if (typeof patch.mailbox === 'string') next.mailbox = patch.mailbox.trim().replace(/^for-/, '').slice(0, 80);
  if (patch.periodMinutes !== undefined) next.periodMinutes = clampPeriod(patch.periodMinutes);
  if (patch.dailyBudget !== undefined) {
    const n = Number(patch.dailyBudget);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('Daily poll budget must be a whole number from 1 to 10000');
    next.dailyBudget = n;
  }
  if (typeof patch.notify === 'boolean') next.notify = patch.notify;
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.clearToken === true) next.token = '';
  await storage.set(SCRIBE_SETTINGS_KEY, next);
  return getScribeSettings(storage);
}

async function call(s, path, { method = 'GET', body, fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`${s.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit', cache: 'no-store', ...(controller ? { signal: controller.signal } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, retryAfter: res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null };
  } finally { if (timer) clearTimeout(timer); }
}

export function backoffMs(failures) { return Math.min(MAX_BACKOFF_MS, 60000 * 2 ** Math.max(0, failures - 1)); }

/** Normalise /mailbox-status into the mailbox we care about (or all). */
export function summarise(json, mailbox) {
  const list = Array.isArray(json && json.mailboxes) ? json.mailboxes : [];
  const rows = list.map((m) => ({
    mailbox: String(m.tag || (m.agent ? `for-${m.agent}` : '')).slice(0, 90),
    count: Math.max(0, Number(m.count ?? m.unread) || 0),
    newest: m.newest && typeof m.newest === 'object' ? {
      id: String(m.newest.id), sender: String(m.newest.sender || '').slice(0, 80),
      createdAt: String(m.newest.created_at || ''), subject: String(m.newest.subject || '').slice(0, 200),
    } : null,
  })).filter((r) => r.mailbox && (!mailbox || r.mailbox === `for-${mailbox}`));
  return { unread: rows.reduce((n, r) => n + r.count, 0), mailboxes: rows };
}

/**
 * One poll. Returns {skipped} or {unread, mailboxes, fresh} where fresh is the
 * newest letters not seen by an earlier poll (for notifications).
 */
export async function pollScribe(storage, { fetchImpl, now = Date.now(), online = true, force = false } = {}) {
  const s = await readSettings(storage);
  const st = await readScribeState(storage);
  if (!s.enabled) return { skipped: 'not-enabled' };
  if (!s.baseUrl || !s.token) return { skipped: 'not-configured' };
  if (st.tokenRejected) return { skipped: 'token-rejected' };
  if (!online) { await patchState(storage, { offline: true }); return { skipped: 'offline' }; }
  if (!force && st.nextAllowedAt && now < st.nextAllowedAt) return { skipped: 'backing-off', until: st.nextAllowedAt };
  const day = utcDay(now);
  const used = st.budgetDay === day ? Number(st.budgetUsed) || 0 : 0;
  if (used >= s.dailyBudget) return { skipped: 'budget-spent', resetsAt: nextUtcMidnight(now) };
  await patchState(storage, { budgetDay: day, budgetUsed: used + 1, offline: false });
  let r;
  try { r = await call(s, SCRIBE_PATHS.status(), { fetchImpl }); }
  catch (error) {
    const failures = (Number(st.failures) || 0) + 1;
    await patchState(storage, { failures, nextAllowedAt: now + backoffMs(failures), lastError: 'network' });
    return { skipped: 'network-error', failures };
  }
  if (r.status === 401 || r.status === 403) {
    await patchState(storage, { tokenRejected: true, lastError: `rejected (${r.status})` });
    return { skipped: 'token-rejected' };
  }
  if (r.status === 402) { // Scribe's daily tenant limit: wait for the UTC reset.
    await patchState(storage, { nextAllowedAt: nextUtcMidnight(now), lastError: 'scribe daily limit reached' });
    return { skipped: 'scribe-limit', until: nextUtcMidnight(now) };
  }
  if (r.status === 429) {
    const ra = Number(r.retryAfter);
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_BACKOFF_MS) : backoffMs((Number(st.failures) || 0) + 1);
    await patchState(storage, { nextAllowedAt: now + wait, lastError: 'rate limited' });
    return { skipped: 'rate-limited', until: now + wait };
  }
  if (r.status !== 200) {
    const failures = (Number(st.failures) || 0) + 1;
    await patchState(storage, { failures, nextAllowedAt: now + backoffMs(failures), lastError: `http ${r.status}` });
    return { skipped: 'server-error', status: r.status };
  }
  const sum = summarise(r.json, s.mailbox);
  const seen = new Set(Array.isArray(st.notifiedIds) ? st.notifiedIds : []);
  const fresh = sum.mailboxes.filter((m) => m.newest && m.count > 0 && !seen.has(`${m.mailbox}:${m.newest.id}`));
  const notifiedIds = [...seen, ...fresh.map((m) => `${m.mailbox}:${m.newest.id}`)].slice(-200);
  await patchState(storage, { failures: 0, nextAllowedAt: 0, lastError: null, polledAt: now, unread: sum.unread, mailboxes: sum.mailboxes, notifiedIds });
  return { unread: sum.unread, mailboxes: sum.mailboxes, fresh: s.notify ? fresh : [] };
}

function cleanId(id) {
  const v = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error('bad letter id');
  return v;
}

export async function openLetter(storage, id, { fetchImpl } = {}) {
  const s = await readSettings(storage);
  if (!isReady(s, await readScribeState(storage))) throw new Error('Scribe door-knock is not set up');
  const r = await call(s, SCRIBE_PATHS.letter(cleanId(id)), { fetchImpl });
  if (r.status === 401 || r.status === 403) { await patchState(storage, { tokenRejected: true }); throw new Error('Scribe rejected the token'); }
  if (r.status !== 200 || !r.json) throw new Error(`Scribe answered ${r.status}`);
  const j = r.json;
  return { id: String(j.id ?? id), from: String(j.from ?? j.sender ?? ''), subject: String(j.subject ?? ''), body: String(j.body ?? j.text ?? '').slice(0, 20000), createdAt: String(j.created_at ?? '') };
}

export async function sendReceipt(storage, id, { fetchImpl } = {}) {
  const s = await readSettings(storage);
  if (!isReady(s, await readScribeState(storage))) throw new Error('Scribe door-knock is not set up');
  const r = await call(s, SCRIBE_PATHS.receipt(cleanId(id)), { method: 'POST', body: { mailbox: s.mailbox || undefined, via: 'helmion-guard' }, fetchImpl });
  if (r.status === 401 || r.status === 403) { await patchState(storage, { tokenRejected: true }); throw new Error('Scribe rejected the token'); }
  if (r.status !== 200 && r.status !== 201) throw new Error(`Scribe answered ${r.status}`);
  return { ok: true };
}

export function badgeFor(unread) {
  const n = Number(unread) || 0;
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
