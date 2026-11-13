// Scribe approvals in the toolbar pop-up (0.7.0).
//
// The approvals PAGE belongs to Scribe itself: the helmian-door app serves it
// at https://connect.helmian.cloud/approvals, Troy signs in with his Scribe
// passphrase, and the door — holding its own Executive Guard approver
// credential, which never reaches a browser — lists what the Guard is holding
// and forwards his decisions. This module is the extension's client for that
// door, nothing more: it never talks to the Guard, holds no Guard credential,
// and cannot decide anything the door would not let the page decide.
//
// THE CONTRACT IS THE DOOR'S OWN PAGES (helmian-door app/src/approvals.mjs,
// read line by line for this bite; there is no JSON API):
//   POST /approvals/login         form field `passphrase`; success sets the
//                                 `scribe_appr` cookie (HttpOnly, 30 min,
//                                 fixed expiry, NO renewal, NO logout route)
//                                 and 302s to /approvals; wrong passphrase is
//                                 a 401 page with the error in <p class="error">;
//                                 five failures lock the door for 15 minutes.
//   GET  /approvals               no session -> the login page; session -> the
//                                 pending list as HTML; Guard down -> 502 with
//                                 the login page + "Approvals are unavailable
//                                 right now. Please try again."
//   POST /approvals/:id/decide    form fields `csrf` + `verdict`
//                                 (approve|deny); the csrf value is per-session
//                                 and printed as a hidden field in every row
//                                 of the list page; success 302s back to the
//                                 list with the outcome in <p class="flash">.
// A waiting approval renders as a <div class="req">: a .sum line, a .meta line
// (Device / Asked / Expires — there is no separate reason field in the door's
// contract, so none is shown), and the decide form. parseApprovalsPage below
// is the ONLY place that knows this markup; a future door JSON endpoint
// replaces this one function and nothing else.
//
// THE PASSPHRASE IS NEVER STORED. It arrives in the sign-in call, goes out in
// exactly one HTTPS POST to the door's own login, and is dropped. What the
// door gives back — the session cookie — lives in the browser's cookie jar,
// is HttpOnly, and is never read, copied or forwarded by this code; requests
// simply use credentials:'include' and let the browser attach it. What IS
// stored here is the session STATE (in/out) and the last list the door
// rendered, so the pop-up can paint instantly and the badge can be right.
// The door kills sessions 30 minutes after sign-in no matter what; when a
// poll or a decide comes back as the login page this client flips its state
// to signed-out and the pop-up asks him to sign in again — in place, in one
// line. Nothing else in the extension reads this state.
//
// Polling is quiet by construction: a 1-minute alarm in the worker calls
// pollApprovals, which does nothing unless signed in and due (60 s cadence,
// 5-minute backoff after errors). No sound, no window, no notice — the badge
// is the signal, and the pop-up opens only when Troy clicks the icon.

export const APPROVALS_STATE_KEY = 'helmion.approvals.state';
export const APPROVALS_ALARM = 'helmion-approvals-poll';
export const DEFAULT_DOOR_URL = 'https://connect.helmian.cloud';
export const POLL_S = 60;
export const ERROR_BACKOFF_S = 300;
const TIMEOUT_MS = 8000;

export function isAllowedDoorUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function doorBase(state) {
  const raw = state && typeof state.doorUrl === 'string' ? state.doorUrl : DEFAULT_DOOR_URL;
  return (isAllowedDoorUrl(raw) ? raw : DEFAULT_DOOR_URL).replace(/\/+$/, '');
}

async function req(fetchImpl, url, init = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await doFetch(url, { credentials: 'include', cache: 'no-store', ...init, ...(ctl ? { signal: ctl.signal } : {}) });
    const text = typeof res.text === 'function' ? await res.text() : '';
    return { status: res.status, text };
  } finally { if (t) clearTimeout(t); }
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&');
}

function textOf(html) {
  return unescapeHtml(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Read one page the door rendered. Returns:
 *   { state: 'list',        approvals: [{id, summary, meta, csrf}], flash }
 *   { state: 'unavailable', error }   (session held, the Guard did not answer)
 *   { state: 'signed-out',  error? }  (the login page; error when the door
 *                                      printed one, e.g. a failed sign-in)
 */
export function parseApprovalsPage(html) {
  const page = String(html || '');
  const flash = page.match(/<p class="flash">([\s\S]*?)<\/p>/);
  const error = page.match(/<p class="error">([\s\S]*?)<\/p>/);
  const approvals = [];
  const chunks = page.split('<div class="req">').slice(1);
  for (const chunk of chunks) {
    const form = chunk.match(/<form method="POST" action="\/approvals\/([^"]+)\/decide">/);
    if (!form) continue;
    const csrf = chunk.match(/<input type="hidden" name="csrf" value="([^"]*)" \/>/);
    const sum = chunk.match(/<div class="sum">([\s\S]*?)<\/div>/);
    const meta = chunk.match(/<div class="meta">([\s\S]*?)<\/div>/);
    approvals.push({
      id: decodeURIComponent(form[1]),
      summary: sum ? textOf(sum[1]) : 'Action',
      meta: meta ? textOf(meta[1]) : '',
      csrf: csrf ? csrf[1] : '',
    });
  }
  if (approvals.length > 0 || /<p class="empty">/.test(page)) {
    return { state: 'list', approvals, flash: flash ? textOf(flash[1]) : '' };
  }
  const errorText = error ? textOf(error[1]) : '';
  if (/Approvals are unavailable/i.test(errorText)) {
    return { state: 'unavailable', error: errorText };
  }
  if (/action="\/approvals\/login"/.test(page)) {
    return { state: 'signed-out', error: errorText };
  }
  // A page in none of the door's shapes: fail closed, treat as signed-out so
  // the pop-up asks for a fresh sign-in rather than showing a stale list.
  return { state: 'signed-out', error: errorText };
}

const DEFAULT_STATE = Object.freeze({
  doorUrl: DEFAULT_DOOR_URL,
  session: 'out', // 'in' | 'out'
  items: [],
  count: 0,
  flash: '',
  lastError: '',
  updatedAt: 0,
  nextAt: 0,
  errors: 0,
  badgeOwned: false,
});

export async function getApprovalsState(storage) {
  const value = await storage.get(APPROVALS_STATE_KEY);
  const s = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_STATE,
    ...s,
    items: Array.isArray(s.items) ? s.items : [],
    count: Number.isFinite(s.count) ? s.count : (Array.isArray(s.items) ? s.items.length : 0),
  };
}

async function saveState(storage, state) {
  await storage.set(APPROVALS_STATE_KEY, state);
  return state;
}

export async function setApprovalsBadgeOwned(storage, owned) {
  const s = await getApprovalsState(storage);
  if (s.badgeOwned === owned) return s;
  return saveState(storage, { ...s, badgeOwned: owned });
}

/** What the pop-up renders. Items carry no csrf here: tokens stay in the worker. */
export function approvalsView(state) {
  return {
    session: state.session,
    state: state.session === 'in' ? (state.lastError && state.stale ? 'unavailable' : 'list') : 'signed-out',
    items: state.items.map(({ id, summary, meta }) => ({ id, summary, meta })),
    count: state.count,
    flash: state.flash || '',
    lastError: state.lastError || '',
    updatedAt: state.updatedAt || 0,
  };
}

function applyPage(state, page, now) {
  if (page.state === 'list') {
    return {
      ...state, session: 'in', items: page.approvals, count: page.approvals.length,
      flash: page.flash || '', lastError: '', stale: false, updatedAt: now, errors: 0,
      nextAt: now + POLL_S * 1000,
    };
  }
  if (page.state === 'unavailable') {
    // The session held; the Guard did not answer. Keep the last known list —
    // hiding waiting items because of a hiccup would be a lie by omission —
    // and say plainly that the list may be stale.
    return {
      ...state, session: 'in', lastError: page.error || 'Approvals are unavailable right now. Please try again.',
      stale: true, errors: state.errors + 1, nextAt: now + ERROR_BACKOFF_S * 1000,
    };
  }
  return {
    ...state, session: 'out', items: [], count: 0, flash: '',
    lastError: page.error || '', stale: false, updatedAt: now, errors: 0, nextAt: 0,
  };
}

/**
 * Sign in at the door. The passphrase is used for this one POST and never
 * stored. On success the landed page IS the current list, so the returned
 * view is already fresh.
 */
export async function signInToApprovals(storage, passphrase, { fetchImpl, now = Date.now(), doorUrl } = {}) {
  const before = await getApprovalsState(storage);
  const base = doorBase(doorUrl ? { doorUrl } : before);
  let r;
  try {
    r = await req(fetchImpl, `${base}/approvals/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ passphrase: String(passphrase || '') }).toString(),
    });
  } catch {
    return { ok: false, error: 'The approvals door could not be reached. Check your connection and try again.', view: approvalsView(before) };
  }
  const page = parseApprovalsPage(r.text);
  if (page.state === 'signed-out') {
    const next = await saveState(storage, { ...before, doorUrl: base, session: 'out', items: [], count: 0, lastError: page.error || '', nextAt: 0 });
    return { ok: false, error: page.error || 'Sign-in did not stick. Please try again.', view: approvalsView(next) };
  }
  const next = await saveState(storage, applyPage({ ...before, doorUrl: base }, page, now));
  return { ok: true, view: approvalsView(next) };
}

/** Fetch the list page once and fold it into the stored state. */
export async function fetchApprovalsView(storage, { fetchImpl, now = Date.now() } = {}) {
  const before = await getApprovalsState(storage);
  const base = doorBase(before);
  let r;
  try {
    r = await req(fetchImpl, `${base}/approvals`, { method: 'GET' });
  } catch {
    const next = await saveState(storage, {
      ...before, lastError: 'The approvals door could not be reached.', stale: before.session === 'in',
      errors: before.errors + 1, nextAt: now + ERROR_BACKOFF_S * 1000,
    });
    return { ok: false, error: next.lastError, view: approvalsView(next) };
  }
  const page = parseApprovalsPage(r.text);
  const next = await saveState(storage, applyPage(before, page, now));
  return { ok: page.state !== 'signed-out', view: approvalsView(next) };
}

/**
 * Decide one waiting approval. Sends the row's own csrf token from the last
 * list the door rendered. The landed page is the result: the item is gone
 * only because the door's new list no longer carries it, and the door's own
 * flash line says what happened. A failure leaves the item in place and
 * returns one plain error line — never a silent no-op.
 */
export async function decideApproval(storage, id, verdict, { fetchImpl, now = Date.now() } = {}) {
  const before = await getApprovalsState(storage);
  if (before.session !== 'in') return { ok: false, error: 'Please sign in again.', view: approvalsView(before) };
  const item = before.items.find((a) => a.id === String(id));
  if (!item) {
    const refreshed = await fetchApprovalsView(storage, { fetchImpl, now });
    return { ok: false, error: 'That request is no longer on the list.', view: refreshed.view };
  }
  const base = doorBase(before);
  let r;
  try {
    r = await req(fetchImpl, `${base}/approvals/${encodeURIComponent(item.id)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: item.csrf || '', verdict: verdict === 'approve' ? 'approve' : 'deny' }).toString(),
    });
  } catch {
    return { ok: false, error: 'The decision could not be sent. The request is still waiting.', view: approvalsView(before) };
  }
  if (r.status === 401) {
    const next = await saveState(storage, {
      ...before, session: 'out', items: [], count: 0, lastError: 'Please sign in again.', nextAt: 0,
    });
    return { ok: false, error: 'Please sign in again.', view: approvalsView(next) };
  }
  if (r.status === 403) {
    const refreshed = await fetchApprovalsView(storage, { fetchImpl, now });
    return { ok: false, error: 'That decision could not be sent. The list has been refreshed.', view: refreshed.view };
  }
  const page = parseApprovalsPage(r.text);
  const next = await saveState(storage, applyPage(before, page, now));
  if (page.state === 'signed-out') {
    return { ok: false, error: 'Please sign in again.', view: approvalsView(next) };
  }
  if (page.state === 'unavailable') {
    return { ok: false, error: page.error || 'Approvals are unavailable right now. Please try again.', view: approvalsView(next) };
  }
  const decided = !next.items.some((a) => a.id === item.id);
  if (page.flash && /could not be decided/i.test(page.flash)) {
    return { ok: false, error: page.flash, view: approvalsView(next) };
  }
  if (!decided) {
    return { ok: false, error: 'That decision could not be confirmed. The request is still waiting.', view: approvalsView(next) };
  }
  return { ok: true, flash: page.flash || '', view: approvalsView(next) };
}

/**
 * The poll the worker's alarm runs. Silent unless signed in and due; the
 * result is what the worker paints on the badge.
 */
export async function pollApprovals(storage, { fetchImpl, now = Date.now(), force = false } = {}) {
  const state = await getApprovalsState(storage);
  if (state.session !== 'in') return { skipped: 'signed-out', count: 0, session: 'out' };
  if (!force && state.nextAt && now < state.nextAt) return { skipped: 'not-due', count: state.count, session: 'in' };
  const r = await fetchApprovalsView(storage, { fetchImpl, now });
  const after = await getApprovalsState(storage);
  return { ok: r.ok, count: after.count, session: after.session, view: r.view };
}

export function badgeTextFor(count) {
  const n = Number(count) || 0;
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
