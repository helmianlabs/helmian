// Scribe "door-knock": poll Helmian Scribe for unread letters, set a badge and
// notify. Guard NEVER writes to Scribe: receipts are automatic when the AI reads
// its mail over MCP (check_inbox -> delivered, read_message/mark_read -> read,
// ack_message -> ack). OPT-IN and OFF BY DEFAULT.
//
// Contract: /workspace/scribe/door-knock-contract.md v1 (troy83352/shared-memory-mcp
// PR #3, branch door-knock/courier-receipts).
//   GET {base}/mailbox/unread?agent=<mailbox>&since_id=<cursor>[&include_legacy=1]
//   Authorization: Bearer <MAILBOX_STATUS_TOKEN> (self-host) | smk_… mailbox.read / OAuth memory.read (SaaS)
//   200 {generated_at, poll_after_seconds, agent, unread_count, newest_id, cursor, new:[{id,from,subject,priority,created_at}], legacy?}
//   400 bad_request · 401/403 unauthorized · 404 feature off · 503 courier_not_installed · 500 unavailable
// The token is never returned to the popup or a page and is never logged.

export const SCRIBE_SETTINGS_KEY = 'helmion.scribe.settings';
export const SCRIBE_STATE_KEY = 'helmion.scribe.state';
export const SCRIBE_ALARM = 'helmion-scribe-poll';
export const ALARM_PERIOD_MIN = 1; // ticks every minute; each mailbox has its own nextAt. MV3 floor is 30 s.
export const MIN_POLL_S = 60;
export const MAX_POLL_S = 120;
export const JITTER_S = 15;
export const ERROR_BACKOFF_S = 300; // contract: back off to 5 min after 3 errors
export const NOT_INSTALLED_S = 900; // contract: 503 courier_not_installed -> every 15 min
export const FEATURE_OFF_S = 900; // 404: no token configured on the server
export const LEGACY_MIN_S = 300; // contract: include_legacy at most every 5 min
export const DEFAULT_DAILY_BUDGET = 2000; // requests per UTC day across all mailboxes
export const MAX_MAILBOXES = 8;
export const TIMEOUT_MS = 5000;
import { SCRIBE_DEFAULT_URL, mailboxSiteTable } from './defaults.js';
import { accessToken as oauthAccessToken, getAuth as getOAuth, inboxStatusViaMcp } from './scribe-auth.js';
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

// The contract's canonical mailboxes and aliases (PR #3 courier/mailboxes.ts).
// Normalised client-side only for display and de-duplication; the server is
// the authority and returns the canonical name in `agent`.
export const MAILBOX_ALIASES = Object.freeze({
  troy: ['owner', 'troy-halter'], paul: ['grok-bot', 'grokbot', 'grokbot-paul', 'grok-bot-paul'],
  muse: ['faith-and-light-news', 'faith-n-light', 'news'], 'claude-pc': ['claude-code', 'claude-desktop', 'claudepc', 'claude-on-pc'],
  'claude.ai': ['claude-ai', 'claudeai'], chatgpt: ['gpt', 'openai', 'chat-gpt'], gemini: ['google-gemini', 'bard'],
  grok: ['grok-x', 'xai'], mistral: ['le-chat', 'lechat'], social: ['social-bot'], youtube: ['yt'],
  sites: ['site', 'websites'], helmian: ['helmian-bot'], guard: ['helmian-guard', 'helium-guard'], writer: ['writer-bot'],
});
const ALIAS = new Map();
for (const [n, as] of Object.entries(MAILBOX_ALIASES)) { ALIAS.set(n, n); for (const a of as) ALIAS.set(a, n); }
// Where the "nudge" sends you for each AI mailbox (open the AI so it runs check_inbox).
export const MAILBOX_SITES = Object.freeze(mailboxSiteTable()); // from background/defaults.js AI_CHOICES

/** Same slug rule as PR #3 agentName(), then alias -> canonical. */
export function mailboxName(raw) {
  const n = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 40);
  if (!n || n === 'all') return null;
  return ALIAS.get(n) || n;
}

export function isAllowedScribeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch { return false; }
}
export function scribeOriginPattern(value) { const u = new URL(String(value)); return `${u.protocol}//${u.hostname}/*`; }
export function clampPollSeconds(n) { const v = Number(n); return Number.isFinite(v) ? Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, v)) : MIN_POLL_S; }
function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }
export function nextUtcMidnight(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }

async function readObj(storage, key) { const v = await storage.get(key); return v && typeof v === 'object' ? v : {}; }
export const DEFAULT_UNREAD_PATH = '/mailbox/unread';
const UNREAD_PATH = /^\/[A-Za-z0-9/_.-]{1,100}$/;
async function readSettings(storage) {
  const s = await readObj(storage, SCRIBE_SETTINGS_KEY);
  return {
    // 0.6.2: knock is ON unless the user turned it off. It still does nothing
    // until Scribe sign-in (or a token) and at least one mailbox exist.
    enabled: s.enabled !== false,
    // 0.6.2: the hosted Scribe server is prefilled (background/defaults.js).
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : SCRIBE_DEFAULT_URL,
    token: typeof s.token === 'string' ? s.token : '',
    mailboxes: Array.isArray(s.mailboxes) ? s.mailboxes.filter(Boolean) : [],
    includeLegacy: s.includeLegacy === true,
    dailyBudget: Number.isInteger(s.dailyBudget) ? s.dailyBudget : DEFAULT_DAILY_BUDGET,
    // 0.6.0: notices and the badge are OFF by default (Troy: no doorbell to click).
    // The code stays; the popup hides these switches under Advanced.
    notify: s.notify === true,
    showBadge: s.showBadge === true,
    // Configurable until Scribe's route is final (404 = not deployed yet).
    unreadPath: typeof s.unreadPath === 'string' && UNREAD_PATH.test(s.unreadPath) ? s.unreadPath : DEFAULT_UNREAD_PATH,
  };
}
export async function readScribeState(storage) {
  const st = await readObj(storage, SCRIBE_STATE_KEY);
  return { ...st, boxes: st.boxes && typeof st.boxes === 'object' ? st.boxes : {} };
}
async function writeState(storage, st) { await storage.set(SCRIBE_STATE_KEY, st); return st; }

export async function getScribeSettings(storage) {
  const s = await readSettings(storage);
  const st = await readScribeState(storage);
  const { token, ...rest } = s;
  const auth = await getOAuth(storage);
  const signedIn = auth.signedIn === true && auth.baseUrl === s.baseUrl;
  return { ...rest, hasToken: Boolean(token), signedIn, authMode: signedIn ? 'oauth' : (token ? 'token' : 'none'), tokenRejected: st.tokenRejected === true };
}
export function isConfigured(view) { return view.enabled && Boolean(view.baseUrl) && (view.signedIn || view.hasToken) && !view.tokenRejected && view.mailboxes.length > 0; }

export async function setScribeSettings(storage, patch = {}) {
  const next = await readSettings(storage);
  const st = await readScribeState(storage);
  if (typeof patch.baseUrl === 'string') {
    const t = patch.baseUrl.trim().replace(/\/+$/, '');
    if (t && !isAllowedScribeUrl(t)) throw new Error('Scribe URL must be https://, or http://localhost for local testing');
    if (t !== next.baseUrl) st.boxes = {}; // cursors belong to one server
    next.baseUrl = t;
  }
  if (typeof patch.token === 'string' && patch.token.trim()) {
    const tok = patch.token.trim();
    if (!TOKEN.test(tok)) throw new Error('That does not look like a Scribe mailbox token');
    next.token = tok;
    st.tokenRejected = false; st.serverState = null;
  }
  if (patch.mailboxes !== undefined) {
    const raw = Array.isArray(patch.mailboxes) ? patch.mailboxes : String(patch.mailboxes).split(',');
    const names = [...new Set(raw.map(mailboxName).filter(Boolean))];
    if (names.length > MAX_MAILBOXES) throw new Error(`Watch at most ${MAX_MAILBOXES} mailboxes`);
    next.mailboxes = names;
    for (const k of Object.keys(st.boxes)) if (!names.includes(k)) delete st.boxes[k];
  }
  if (typeof patch.includeLegacy === 'boolean') next.includeLegacy = patch.includeLegacy;
  if (patch.dailyBudget !== undefined) {
    const n = Number(patch.dailyBudget);
    if (!Number.isInteger(n) || n < 1 || n > 20000) throw new Error('Daily request budget must be a whole number from 1 to 20000');
    next.dailyBudget = n;
  }
  if (typeof patch.notify === 'boolean') next.notify = patch.notify;
  if (typeof patch.showBadge === 'boolean') next.showBadge = patch.showBadge;
  if (typeof patch.unreadPath === 'string') {
    const pth = patch.unreadPath.trim() || DEFAULT_UNREAD_PATH;
    if (!UNREAD_PATH.test(pth) || pth.includes('..')) throw new Error('Unread path must start with / and use only letters, digits, / _ . -');
    next.unreadPath = pth;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.clearToken === true) next.token = '';
  if (patch.clearRejected === true) { st.tokenRejected = false; st.serverState = null; }
  await storage.set(SCRIBE_SETTINGS_KEY, next);
  await writeState(storage, st);
  return getScribeSettings(storage);
}

async function call(s, url, { fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, {
      method: 'GET', headers: { authorization: `Bearer ${s.token}`, accept: 'application/json' },
      credentials: 'omit', cache: 'no-store', ...(controller ? { signal: controller.signal } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, retryAfter: res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null };
  } finally { if (timer) clearTimeout(timer); }
}

export function unreadUrl(base, agent, sinceId, legacy, path = DEFAULT_UNREAD_PATH) {
  const u = new URL(`${base}${path}`);
  u.searchParams.set('agent', agent);
  u.searchParams.set('since_id', String(Math.max(0, Math.floor(Number(sinceId) || 0))));
  if (legacy) u.searchParams.set('include_legacy', '1');
  return u.toString();
}
function jitter(rand) { return Math.round((rand() * 2 - 1) * JITTER_S * 1000); }
function cleanItem(x) {
  return { id: Number(x.id), from: String(x.from ?? '').slice(0, 80), subject: String(x.subject ?? '').slice(0, 200),
    priority: String(x.priority ?? 'normal').slice(0, 20), createdAt: String(x.created_at ?? '') };
}

/** Poll one mailbox now. Updates its box state; returns {fresh, kind}. */
async function pollBox(storage, s, st, name, { fetchImpl, now, rand, oauth }) {
  const box = st.boxes[name] || { cursor: 0, errors: 0 };
  const legacy = s.includeLegacy && (box.legacyAt == null || now - box.legacyAt >= LEGACY_MIN_S * 1000);
  let r;
  try {
    if (oauth) {
      // Signed in (no pasted key): count unread over MCP inbox_status with the OAuth token.
      r = await inboxStatusViaMcp(s.baseUrl, oauth.token, name, box.cursor, { fetchImpl });
      if (r.status === 401 || r.status === 403) {
        const fresh = await oauthAccessToken(storage, { fetchImpl, now, forceRefresh: true });
        if (fresh) { oauth.token = fresh; r = await inboxStatusViaMcp(s.baseUrl, fresh, name, box.cursor, { fetchImpl }); }
      }
    } else {
      r = await call(s, unreadUrl(s.baseUrl, name, box.cursor, legacy, s.unreadPath), { fetchImpl });
    }
  } catch { r = { status: 0 }; }
  const later = (sec) => now + sec * 1000 + jitter(rand);
  let fresh = [];
  if (r.status === 200 && r.json) {
    const j = r.json;
    const items = Array.isArray(j.new) ? j.new.map(cleanItem).filter((x) => x.id > (box.cursor || 0)) : [];
    fresh = items;
    Object.assign(box, {
      state: 'ok', errors: 0, unread: Math.max(0, Number(j.unread_count) || 0), newestId: j.newest_id ?? null,
      cursor: Math.max(Number(box.cursor) || 0, Number(j.cursor) || 0),
      recent: [...(box.recent || []), ...items].slice(-20), polledAt: now,
      nextAt: later(clampPollSeconds(j.poll_after_seconds)),
    });
    if (legacy && j.legacy) { box.legacyAt = now; box.legacyCount = Math.max(0, Number(j.legacy.recent_count) || 0); }
    st.serverState = 'ok';
  } else if (r.status === 401 || r.status === 403) {
    st.tokenRejected = true; st.serverState = 'reconnect';
  } else if (r.status === 503 && r.json && r.json.error === 'courier_not_installed') {
    Object.assign(box, { state: 'not-installed', nextAt: later(NOT_INSTALLED_S) }); st.serverState = 'not-installed';
  } else if (r.status === 404) {
    Object.assign(box, { state: 'feature-off', nextAt: later(FEATURE_OFF_S) }); st.serverState = 'feature-off';
  } else if (r.status === 400) {
    Object.assign(box, { state: 'bad-name', nextAt: Infinity }); // fix the name in settings
  } else if (r.status === 402) {
    Object.assign(box, { state: 'limit', nextAt: nextUtcMidnight(now) });
  } else if (r.status === 429) {
    const ra = Number(r.retryAfter);
    Object.assign(box, { state: 'rate-limited', nextAt: now + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : ERROR_BACKOFF_S) * 1000 });
  } else {
    box.errors = (Number(box.errors) || 0) + 1;
    Object.assign(box, { state: 'error', lastStatus: r.status || 'network', nextAt: later(box.errors >= 3 ? ERROR_BACKOFF_S : MIN_POLL_S) });
  }
  st.boxes[name] = box;
  return { fresh };
}

/**
 * One alarm tick. Polls each watched mailbox whose nextAt has passed.
 * Returns {skipped} or {unread, fresh:[{mailbox, items}], serverState}.
 */
export async function pollScribe(storage, { fetchImpl, now = Date.now(), online = true, idle = false, force = false, rand = Math.random } = {}) {
  const s = await readSettings(storage);
  const st = await readScribeState(storage);
  if (!s.enabled) return { skipped: 'not-enabled' };
  const auth = await getOAuth(storage);
  const useOAuth = auth.signedIn === true && auth.baseUrl === s.baseUrl;
  if (!s.baseUrl || (!s.token && !useOAuth) || !s.mailboxes.length) return { skipped: 'not-configured' };
  if (st.tokenRejected) return { skipped: 'token-rejected' };
  if (!online) { st.offline = true; await writeState(storage, st); return { skipped: 'offline' }; }
  // 0.6.8: keep polling while the computer is idle. Idle is exactly when the AIs
  // should get their mail; the old 'idle' skip stopped mail overnight.
  void idle;
  st.offline = false;
  const day = utcDay(now);
  if (st.budgetDay !== day) { st.budgetDay = day; st.budgetUsed = 0; }
  const fresh = [];
  let polled = 0;
  let oauth = null;
  if (useOAuth) {
    const t = await oauthAccessToken(storage, { fetchImpl, now });
    if (!t) { st.tokenRejected = true; st.serverState = 'reconnect'; await writeState(storage, st); return { skipped: 'token-rejected' }; }
    oauth = { token: t };
  }
  for (const name of s.mailboxes) {
    const box = st.boxes[name];
    if (!force && box && box.nextAt && now < box.nextAt) continue;
    if (box && box.state === 'bad-name' && !force) continue;
    if (st.budgetUsed >= s.dailyBudget) { st.budgetSpent = true; break; }
    st.budgetUsed += 1; polled += 1;
    const r = await pollBox(storage, s, st, name, { fetchImpl, now, rand, oauth });
    if (r.fresh.length) fresh.push({ mailbox: name, items: r.fresh });
    if (st.tokenRejected) break;
  }
  const unread = Object.values(st.boxes).reduce((n, b) => n + (b.state === 'ok' ? Number(b.unread) || 0 : 0), 0);
  st.unread = unread;
  await writeState(storage, st);
  if (st.tokenRejected) return { skipped: 'token-rejected' };
  if (!polled) return { skipped: st.budgetSpent && st.budgetUsed >= s.dailyBudget ? 'budget-spent' : 'not-due', unread };
  // `mail` is every fresh item (ids, from, subject only) for the auto-nudge policy;
  // `fresh` is only for notices, which are off by default.
  return { unread, fresh: s.notify ? fresh : [], mail: fresh, boxes: unreadByBox(st), showBadge: s.showBadge, serverState: st.serverState };
}

/** mailbox -> {count, newestId} for boxes the server answered for (state ok). */
export function unreadByBox(st) {
  const out = {};
  for (const [name, b] of Object.entries((st && st.boxes) || {})) if (b && b.state === 'ok') out[name] = { count: Math.max(0, Number(b.unread) || 0), newestId: b.newestId == null ? null : Number(b.newestId) };
  return out;
}

/** Popup view of the inbox: counts and subjects only. */
export async function inboxView(storage) {
  const s = await readSettings(storage);
  const st = await readScribeState(storage);
  return {
    unread: st.unread || 0, offline: st.offline === true, serverState: st.tokenRejected ? 'reconnect' : (st.serverState || null),
    mailboxes: s.mailboxes.map((name) => {
      const b = st.boxes[name] || {};
      return { mailbox: name, state: b.state || 'waiting', unread: b.unread || 0, recent: (b.recent || []).slice(-5).reverse(),
        polledAt: b.polledAt || null, legacyCount: b.legacyCount ?? null, site: MAILBOX_SITES[name] || null };
    }),
  };
}

export function badgeFor(unread) { const n = Number(unread) || 0; return n <= 0 ? '' : n > 99 ? '99+' : String(n); }
export function noticeText(mailbox, items) {
  const who = mailbox.charAt(0).toUpperCase() + mailbox.slice(1);
  return { title: `${who}: ${items.length} new letter${items.length === 1 ? '' : 's'}`, message: items.slice(-3).map((x) => `${x.from}: ${x.subject}`).join('\n') };
}
