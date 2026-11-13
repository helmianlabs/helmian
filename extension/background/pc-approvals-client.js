// PC approvals in the Guard extension (approvals pop-up build, Bite 1).
//
// The list on this road belongs to the Helmian app: its proxy
// (src/cloud/guard-pc-approvals.mjs) holds the Executive Guard approver
// token on the server, lets only the PC owner's account see or decide
// anything, and serves the pending PC actions an agent has asked the Guard
// to run on Troy's PC. This module is the extension's client for that
// proxy, nothing more: it holds no Guard credential, stores no credential
// of any kind, and cannot decide anything the web page could not decide.
//
// THE CONTRACT IS THE PROXY'S OWN ROUTES (read from guard-pc-approvals.mjs
// for the pop-up plan; there is no other API):
//   GET  /api/admin/guard/pc-approvals
//        -> 200 { approvals: [...] }, pending only. Each item, as the
//        proxy's publicApproval shapes it: { approvalId, status, summary,
//        reason, tool, site, deviceId, createdAt, expiresAt } — times as
//        ISO strings, summary capped at 500 chars, reason at 300, never
//        the raw action content.
//   POST /api/admin/guard/pc-approvals/decide   JSON { approvalId, approve }
//        -> 200 { approval }; 404 the item expired or is gone; 409 it was
//        already decided or expired; 502 the Guard was unreachable or
//        answered unreadably; 401 / 403 sign-in and owner problems; 503 PC
//        approvals are not set up for the account.
// The base is always https://helmian.cloud — the origin the manifest
// already grants a host permission for. It is a constant here, not a
// setting: there is no second Helmian a customer could point this at.
//
// THE ONLY SIGN-IN IS THE BROWSER'S OWN. Requests use
// credentials:'include' and let the browser attach Troy's Helmian session
// cookie; the cookie is never read, copied or forwarded by this code, and
// nothing about it is stored. What IS stored is the session state as this
// client last learned it (in / out / not-the-owner) and the last list the
// proxy returned, so the pop-up can paint instantly and the badge can be
// right. NOT YET PROVEN, and named as such: whether a fetch from an
// extension page actually carries that session cookie to the proxy is a
// browser behaviour no local source confirms. This client is built to the
// contract above either way; the real-road proof is Bite 2's job, and if
// the cookie does not ride along, these calls come back 401 and this
// client honestly reports signed-out rather than inventing a sign-in of
// its own (the plan's fallback is a compact web window, never a stored
// credential).
//
// THIS MODULE NEVER MIXES WITH THE SCRIBE DOOR CLIENT
// (background/approvals-client.js). Different origin, different list,
// different state key, different sign-in. The door's passphrase never
// comes near this code, and nothing stored here is read there. The SHAPE
// is deliberately the same function for function — stored state, list
// folding, stale-on-error, decide confirmed by refresh, quiet poll with
// backoff — because that shape is proven; the two clients share no state,
// no items and no code path at runtime.
//
// ONE DELIBERATE DIFFERENCE from the door client: the poll. The door
// client can go silent when signed out because its sign-in happens inside
// the extension. This client's sign-in happens on the website, in a tab,
// so a poll that stopped at the first 401 could never notice Troy signing
// back in. A signed-out result here keeps the normal 60-second cadence
// (nextAt is set, never zeroed), and the poll keeps quietly re-checking.
// Polling is still quiet by construction: a 1-minute alarm in the worker
// calls pollPcApprovals, which does nothing unless due (60 s cadence,
// 5-minute backoff after errors). No sound, no window, no notice — the
// badge is the signal.

export const PC_APPROVALS_STATE_KEY = 'helmion.pc-approvals.state';
export const PC_APPROVALS_ALARM = 'helmion-pc-approvals-poll';
export const PC_APPROVALS_BASE = 'https://helmian.cloud';
export const POLL_S = 60;
export const ERROR_BACKOFF_S = 300;
const TIMEOUT_MS = 8000;

const LIST_PATH = '/api/admin/guard/pc-approvals';
const DECIDE_PATH = '/api/admin/guard/pc-approvals/decide';

const SIGN_IN_LINE = 'Please sign in to Helmian.';
const NOT_OWNER_LINE = "PC actions are approved by the PC owner's account.";
const GUARD_DOWN_LINE = 'The Guard could not be reached.';
const NOT_SET_UP_LINE = 'PC approvals are not set up for this account.';
const UNREADABLE_LINE = 'Helmian answered in a shape that could not be read.';
const UNREACHABLE_LINE = 'Helmian could not be reached.';

function baseOf(baseUrl) {
  const raw = typeof baseUrl === 'string' && baseUrl ? baseUrl : PC_APPROVALS_BASE;
  return raw.replace(/\/+$/, '');
}

async function req(fetchImpl, url, init = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await doFetch(url, { credentials: 'include', cache: 'no-store', ...init, ...(ctl ? { signal: ctl.signal } : {}) });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON answer folds as unreadable */ }
    return { status: res.status, text, json };
  } finally { if (t) clearTimeout(t); }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Fold one raw proxy item into the shape the pages render:
 * { id, summary, tool, site, reason, createdAt, expiresAt }. The proxy's
 * deviceId is dropped on purpose — the pop-up plan's view shape does not
 * carry it. Anything that is not a pending item with an id folds to null.
 */
export function foldPcApproval(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.approvalId != null ? String(raw.approvalId) : (raw.id != null ? String(raw.id) : '');
  if (!id) return null;
  if (raw.status != null && raw.status !== 'pending') return null;
  return {
    id,
    summary: text(raw.summary) || 'Action',
    tool: text(raw.tool),
    site: text(raw.site),
    reason: text(raw.reason),
    createdAt: text(raw.createdAt),
    expiresAt: text(raw.expiresAt),
  };
}

/**
 * Fold a whole list response body. Returns the items soonest to expire
 * first (an item with no expiry sorts last), or null when the body is not
 * the proxy's shape — the caller folds that as "answered unreadably",
 * never as an empty list.
 */
export function foldPcApprovalsList(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.approvals)) return null;
  const items = [];
  for (const raw of json.approvals) {
    const item = foldPcApproval(raw);
    if (item) items.push(item);
  }
  items.sort((a, b) => {
    if (a.expiresAt === b.expiresAt) return 0;
    if (!a.expiresAt) return 1;
    if (!b.expiresAt) return -1;
    return a.expiresAt < b.expiresAt ? -1 : 1;
  });
  return items;
}

const DEFAULT_STATE = Object.freeze({
  // There is no extension-side sign-in to be out of, so the client starts
  // optimistic ('in'); the first fetch decides and records the truth.
  session: 'in', // 'in' | 'out'
  owner: true,
  items: [],
  count: 0,
  lastError: '',
  stale: false,
  updatedAt: 0,
  nextAt: 0,
  errors: 0,
});

export async function getPcApprovalsState(storage) {
  const value = await storage.get(PC_APPROVALS_STATE_KEY);
  const s = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_STATE,
    ...s,
    items: Array.isArray(s.items) ? s.items : [],
    count: Number.isFinite(s.count) ? s.count : (Array.isArray(s.items) ? s.items.length : 0),
  };
}

async function saveState(storage, state) {
  await storage.set(PC_APPROVALS_STATE_KEY, state);
  return state;
}

/** What the pop-up and the approvals window render. Data only, never markup. */
export function pcApprovalsView(state) {
  return {
    state: state.session === 'out' ? 'signed-out'
      : state.owner === false ? 'not-owner'
      : state.stale ? 'unavailable' : 'list',
    session: state.session,
    items: state.items.map(({ id, summary, tool, site, reason, createdAt, expiresAt }) =>
      ({ id, summary, tool, site, reason, createdAt, expiresAt })),
    count: state.count,
    lastError: state.lastError || '',
    stale: !!state.stale,
    updatedAt: state.updatedAt || 0,
  };
}

function applyList(state, items, now) {
  return {
    ...state, session: 'in', owner: true, items, count: items.length,
    lastError: '', stale: false, updatedAt: now, errors: 0,
    nextAt: now + POLL_S * 1000,
  };
}

function applySignedOut(state, now) {
  // nextAt keeps the normal cadence on purpose (see the header): the
  // sign-in lives on the website, so the poll must keep quietly checking
  // or it could never notice Troy signing back in.
  return {
    ...state, session: 'out', owner: true, items: [], count: 0,
    lastError: SIGN_IN_LINE, stale: false, updatedAt: now, errors: 0,
    nextAt: now + POLL_S * 1000,
  };
}

function applyNotOwner(state, now) {
  return {
    ...state, session: 'in', owner: false, items: [], count: 0,
    lastError: NOT_OWNER_LINE, stale: false, updatedAt: now, errors: 0,
    nextAt: now + POLL_S * 1000,
  };
}

function applyUnavailable(state, error, now) {
  // Keep the last known list — hiding waiting items because of a hiccup
  // would be a lie by omission — and mark it stale. updatedAt is left
  // alone: it is the time OF that list, which is what a stale banner
  // quotes.
  return {
    ...state, lastError: error, stale: true,
    errors: state.errors + 1, nextAt: now + ERROR_BACKOFF_S * 1000,
  };
}

/** Fold one list response into the stored state and save it. */
async function foldListResponse(storage, state, r, now) {
  if (r.status === 200) {
    const items = foldPcApprovalsList(r.json);
    if (items) return saveState(storage, applyList(state, items, now));
    return saveState(storage, applyUnavailable(state, UNREADABLE_LINE, now));
  }
  if (r.status === 401) return saveState(storage, applySignedOut(state, now));
  if (r.status === 403) return saveState(storage, applyNotOwner(state, now));
  if (r.status === 503) return saveState(storage, applyUnavailable(state, NOT_SET_UP_LINE, now));
  if (r.status === 502) return saveState(storage, applyUnavailable(state, GUARD_DOWN_LINE, now));
  return saveState(storage, applyUnavailable(state, `Helmian answered with an error (${r.status}).`, now));
}

/** Fetch the pending list once and fold it into the stored state. */
export async function fetchPcApprovalsView(storage, { fetchImpl, now = Date.now(), baseUrl } = {}) {
  const before = await getPcApprovalsState(storage);
  let r;
  try {
    r = await req(fetchImpl, `${baseOf(baseUrl)}${LIST_PATH}`, { method: 'GET' });
  } catch {
    const next = await saveState(storage, applyUnavailable(before, UNREACHABLE_LINE, now));
    return { ok: false, error: next.lastError, view: pcApprovalsView(next) };
  }
  const next = await foldListResponse(storage, before, r, now);
  const ok = next.session === 'in' && next.owner !== false && !next.stale;
  return { ok, ...(ok ? {} : { error: next.lastError || UNREACHABLE_LINE }), view: pcApprovalsView(next) };
}

/**
 * Decide one waiting PC approval. The item leaves the list only when the
 * refreshed list no longer carries it — a 200 from the decide route alone
 * is never taken as proof. Every failure path leaves the item waiting and
 * returns one plain error line; nothing here ever decides silently.
 */
export async function decidePcApproval(storage, id, verdict, { fetchImpl, now = Date.now(), baseUrl } = {}) {
  const before = await getPcApprovalsState(storage);
  const item = before.items.find((a) => a.id === String(id));
  if (!item) {
    const refreshed = await fetchPcApprovalsView(storage, { fetchImpl, now, baseUrl });
    return { ok: false, error: 'That request is no longer on the list.', view: refreshed.view };
  }
  const base = baseOf(baseUrl);
  let r;
  try {
    r = await req(fetchImpl, `${base}${DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: item.id, approve: verdict === 'approve' }),
    });
  } catch {
    return { ok: false, error: 'The decision could not be sent. The request is still waiting.', view: pcApprovalsView(before) };
  }
  if (r.status === 401) {
    const next = await saveState(storage, applySignedOut(before, now));
    return { ok: false, error: SIGN_IN_LINE, view: pcApprovalsView(next) };
  }
  if (r.status === 403) {
    const next = await saveState(storage, applyNotOwner(before, now));
    return { ok: false, error: NOT_OWNER_LINE, view: pcApprovalsView(next) };
  }
  if (r.status === 404 || r.status === 409) {
    const refreshed = await fetchPcApprovalsView(storage, { fetchImpl, now, baseUrl });
    return {
      ok: false,
      error: r.status === 404
        ? 'That request has expired or was already decided.'
        : 'That request was already decided.',
      view: refreshed.view,
    };
  }
  if (r.status === 502 || r.status === 503) {
    const next = await saveState(storage, applyUnavailable(before, r.status === 502 ? GUARD_DOWN_LINE : NOT_SET_UP_LINE, now));
    return { ok: false, error: next.lastError, view: pcApprovalsView(next) };
  }
  if (r.status !== 200) {
    return { ok: false, error: `The decision could not be sent (Helmian answered ${r.status}). The request is still waiting.`, view: pcApprovalsView(before) };
  }
  const refreshed = await fetchPcApprovalsView(storage, { fetchImpl, now, baseUrl });
  if (!refreshed.view.items.some((a) => a.id === item.id)) {
    return { ok: true, view: refreshed.view };
  }
  return { ok: false, error: 'That decision could not be confirmed. The request is still waiting.', view: refreshed.view };
}

/**
 * The poll the worker's alarm runs. Silent unless due; the result is what
 * the worker paints on the badge. Unlike the door client it does not skip
 * when signed out (see the header) — being due is the only gate.
 */
export async function pollPcApprovals(storage, { fetchImpl, now = Date.now(), force = false, baseUrl } = {}) {
  const state = await getPcApprovalsState(storage);
  if (!force && state.nextAt && now < state.nextAt) {
    return { skipped: 'not-due', count: state.count, session: state.session, view: pcApprovalsView(state) };
  }
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now, baseUrl });
  const after = await getPcApprovalsState(storage);
  return { ok: r.ok, count: after.count, session: after.session, view: r.view };
}

export function badgeTextFor(count) {
  const n = Number(count) || 0;
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
