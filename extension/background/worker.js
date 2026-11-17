// The extension's background service worker.
//
// It exists because the checking has to happen somewhere that can load ES
// modules, and a Chrome content script cannot. The worker imports the copied
// Helmian modules and answers three messages:
//
//   helmion:scan    code blocks in, per-block destructive-command verdicts out
//   helmion:claims  prose in, per-passage unsourced-claim findings out
//   helmion:badge   set the toolbar badge for the tab that asked
//
// THE BADGE BELONGS TO helmion:scan ALONE. A red count means somebody handed
// Troy a command that would destroy something. Unsourced claims are advisory,
// they are wrong often enough that their own source file lists the ways, and
// letting them light the same indicator would teach him to ignore it. They are
// drawn beside the sentence they are about and nowhere else.
//
// Nothing here touches the network and nothing here calls a model. Phase 1 is a
// regular expression run against text, on this machine, and that is all.
//
// It is also the seam for later phases: when the local model verifier arrives,
// it plugs in here and the content script does not change. The claim detector's
// own two-stage design expects exactly that — every finding it returns carries
// `needsLookup` and the extracted referent so a stage two can check ONE claim
// instead of a whole reply.

import { scanBlocks } from './scan.js';
import {
  ALARM_PERIOD_MIN,
  MAILBOX_SITES,
  SCRIBE_ALARM,
  badgeFor,
  getScribeSettings,
  inboxView,
  isConfigured as scribeConfigured,
  noticeText,
  pollScribe, readScribeState, unreadByBox,
  setScribeSettings,
} from './scribe-client.js';
import { AI_CHOICES, mailboxesForAis, nudgeSitesForAis, redirectUrlFor, DEFAULT_NUDGE_IDLE_MIN, DEFAULT_NUDGE_DAILY_CAP, SCRIBE_DEFAULT_URL } from './defaults.js';
import { getAuth as getScribeAuth, signIn as scribeSignIn, signOut as scribeSignOut } from './scribe-auth.js';
import {
  APPROVALS_ALARM,
  approvalsView,
  badgeTextFor as approvalsBadgeText,
  decideApproval,
  getApprovalsState,
  pollApprovals,
  setApprovalsBadgeOwned,
  signInToApprovals,
} from './approvals-client.js';
import {
  PC_APPROVALS_ALARM,
  badgeTextFor as pcBadgeText,
  decidePcApproval,
  getPcApprovalsState,
  pcApprovalsView,
  pollPcApprovals,
} from './pc-approvals-client.js';
import {
  getNudgeSettings, queuePending, readNudgeLog, runNudges, setNudgeSettings, noteTab, siteForHost, siteForUrl,
} from './nudge-policy.js';
import { scanProse } from './claims.js';
import {
  getUploadSettings,
  setUploadSettings,
  uploadNewFindings,
} from './upload.js';
import {
  getExecutiveSettings,
  pairExecutive,
  pollApproval,
  requestDecision,
  setExecutiveSettings,
} from './executive.js';
import {
  getFlagsSettings,
  markAlertsSeen,
  pollAlerts,
  reportFlag,
  scanText,
  setFlagsSettings,
} from './flags-client.js';
import {
  KIND_UNVERIFIED_DECISION,
  appendEntry,
  chromeStorage,
  clearLedger,
  exportBundle,
  ledgerStats,
  makeEntry,
  readLedger,
} from './ledger.js';

// The one place the storage permission is used.
const ledger = chromeStorage();

// Approvals this browser session asked Executive Guard for: approvalId ->
// { nonce, actionHash }. Kept in memory on purpose; the content script asks
// again if the worker was evicted. Only approvals in here are ever polled.
const pendingApprovals = new Map();

function extensionVersion() {
  try { return chrome.runtime.getManifest().version; } catch { return '0.0.0'; }
}

// Sent with Flags reports as context.browser. Only the family, never the full UA.
function browserFamily() {
  const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'unknown';
}

// A message from one of this extension's own content scripts (in a tab).
function isFromOwnContentScript(sender) {
  if (!sender || !sender.tab || sender.id !== chrome.runtime.id) return false;
  // An extension page opened in a tab also has sender.tab; a content script's
  // sender.url is the web page's.
  try {
    return !String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  } catch {
    return false;
  }
}

// What a content script may send for a decision. Raw page text never reaches
// the worker for this: the content script sends a redacted summary and a hash.
const DECIDE_KINDS = new Set(['prompt.send', 'prompt.paste', 'code.reveal']);
function cleanAction(input) {
  const a = input && typeof input === 'object' ? input : {};
  if (!DECIDE_KINDS.has(a.kind)) throw new Error(`unsupported action kind: ${String(a.kind)}`);
  if (!/^[0-9a-f]{64}$/.test(String(a.contentHash))) throw new Error('action needs a sha256 contentHash');
  return {
    kind: a.kind,
    site: String(a.site || 'unknown-site').toLowerCase().slice(0, 253),
    contentHash: String(a.contentHash),
    riskSignals: Array.isArray(a.riskSignals) ? a.riskSignals.map(String).slice(0, 32) : [],
    summary: String(a.summary || '').slice(0, 500),
  };
}

const RED = '#b3261e';
const AMBER = '#c77700';
const BLUE = '#4a5b7a';

let latestStatus = {
  protection: 'unknown',
  claims: 'unknown',
};

function setBadge(tabId, info) {
  if (typeof tabId !== 'number') return;
  try {
    if (info.broken) {
      chrome.action.setBadgeText({ tabId, text: '!' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: AMBER });
      chrome.action.setTitle({ tabId, title: 'Helmian Guard needs attention — open for details' });
      return;
    }
    const dangerous = Number(info.dangerous) || 0;
    if (dangerous > 0) {
      chrome.action.setBadgeText({ tabId, text: String(dangerous) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: RED });
      chrome.action.setTitle({
        tabId,
        title: `Helmian Guard flagged ${dangerous} destructive code block(s) on this page`,
      });
      return;
    }
    if (info.degraded) {
      chrome.action.setBadgeText({ tabId, text: '•' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: BLUE });
      chrome.action.setTitle({ tabId, title: 'Helmian Guard is active — open for status' });
      return;
    }
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Helmian Guard is watching this page' });
  } catch (error) {
    // A tab that closed mid-flight is not a failure worth surfacing.
    console.warn('[Helmian Guard] badge update failed:', error.message);
  }
}

// Three messages hand back, or destroy, the whole conversation ledger — the
// excerpts of the user's chats this extension keeps as evidence. Everything else
// here is stateless pattern-matching on text the caller already had.
//
// manifest.json declares no `externally_connectable`, so a web page cannot reach
// this listener today, and that is the real protection. This is the second lock:
// before 2026-08-03 the sender was not examined at ALL (it was read once, for a
// tab id), so the day someone adds externally_connectable — or a content script
// on one of the four matched origins is compromised — the ledger reads out to
// whoever asks and clears with no confirmation. Only the popup needs these.
const PRIVILEGED_TYPES = new Set([
  'helmion:ledger',
  'helmion:ledger-export',
  'helmion:ledger-clear',
  'helmion:guard-upload',
  'helmion:guard-upload-settings',
  'helmion:executive-settings',
  'helmion:executive-pair',
  'helmion:flags-settings',
  'helmion:flags-alerts',
  'helmion:scribe-settings',
  'helmion:scribe-inbox',
  'helmion:scribe-nudge',
  'helmion:scribe-signin',
  'helmion:nudge-settings',
  'helmion:approvals-view',
  'helmion:approvals-signin',
  'helmion:approvals-decide',
  'helmion:pc-approvals-view',
  'helmion:pc-approvals-decide',
  'helmion:pc-approvals-open-window',
  'helmion:onboarding',
]);

// 0.6.2 FIX: this used to refuse any sender with a `tab`. The popup opened
// as a full tab (chrome-extension://<id>/popup/popup.html), the options page
// and the welcome page all have a tab, so every settings save and the Scribe
// sign-in were refused with "only accepted from the extension popup"
// (reproduced in Chromium 141 with the 0.6.0 build). What matters is WHO
// sent it: our own extension page, by URL. A content script's sender.url is the
// web page's URL, never chrome-extension://<our id>/, so it is still refused.
// 0.7.0 port: the approvals window (popup/approvals-window.html) is NOT a
// general own page; it keeps its narrow contract (PC_WINDOW_TYPES below).
export const OWN_PAGE_DIRS = Object.freeze(['popup/', 'onboarding/']);
const APPROVALS_WINDOW_PAGE = 'popup/approvals-window.html';
export function isOwnExtensionPage(sender, runtime = chrome.runtime) {
  if (!sender) return false;
  if (sender.id !== runtime.id) return false;
  try {
    const url = String(sender.url || '');
    if (url.startsWith(runtime.getURL(APPROVALS_WINDOW_PAGE))) return false;
    return OWN_PAGE_DIRS.some((dir) => url.startsWith(runtime.getURL(dir)));
  } catch {
    // getURL unavailable. Fail CLOSED — an unverifiable sender does not get the
    // ledger. A safety tool's evidence log is the last thing to hand out on a
    // maybe.
    return false;
  }
}

// The approvals window (Bite 5) is the one own page that legitimately
// carries a tab: chrome.windows.create puts its page in a tab inside the
// popup window, so the no-tab rule above would refuse the very page the
// window exists for. The window's whole contract is the two PC approvals
// messages below, sent from that exact page; every other privileged type
// from a tab-carried sender is still refused, every other page is still
// refused, and a content script can never present this sender — its URL
// is the web page it runs on, never an extension page. Same fail-closed
// shape as above: an unverifiable sender gets nothing.
const PC_WINDOW_TYPES = new Set([
  'helmion:pc-approvals-view',
  'helmion:pc-approvals-decide',
]);

function isFromOwnApprovalsWindow(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  try {
    return String(sender.url || '').startsWith(chrome.runtime.getURL('popup/approvals-window.html'));
  } catch {
    return false;
  }
}

// 0.7.0 port: who may send which privileged type.
// - Approval decisions (Scribe approvals and PC approvals) keep 0.7.0's strict
//   rule: only the real toolbar pop-up (no tab), or, for the two PC window
//   types, the approvals window page itself.
// - Every other privileged type accepts any of Guard's own pages, also when
//   carried in a tab (the 0.6.2 fix: popup-as-tab, options, welcome page).
const APPROVAL_TYPES = new Set([
  'helmion:approvals-view',
  'helmion:approvals-signin',
  'helmion:approvals-decide',
  'helmion:pc-approvals-view',
  'helmion:pc-approvals-decide',
  'helmion:pc-approvals-open-window',
]);
function isFromOwnPopup(sender) {
  return Boolean(sender) && !sender.tab && isOwnExtensionPage(sender)
    && String(sender.url || '').startsWith(chrome.runtime.getURL('popup/'));
}
export function senderAllowedFor(type, sender) {
  if (APPROVAL_TYPES.has(type)) return isFromOwnPopup(sender) || (PC_WINDOW_TYPES.has(type) && isFromOwnApprovalsWindow(sender));
  return isOwnExtensionPage(sender);
}

// ─── SCRIBE DOOR-KNOCK ─────────────────────────────────────────────────────
// Off by default. A 1-minute alarm (MV3 floor is 30 s) polls each watched
// mailbox when it is due (60–120 s per the server's poll_after_seconds, ±15 s
// jitter). Guard only knocks: it never writes to Scribe; the AI's own
// check_inbox / read_message produce the receipts. See background/scribe-client.js.
const SCRIBE_BADGE = '#2e6b3a';
async function syncScribeAlarm() {
  try {
    const s = await getScribeSettings(ledger);
    if (!chrome.alarms) return;
    if (scribeConfigured(s)) chrome.alarms.create(SCRIBE_ALARM, { periodInMinutes: ALARM_PERIOD_MIN, delayInMinutes: 0.5 });
    else { chrome.alarms.clear(SCRIBE_ALARM); await refreshGlobalBadge(); }
  } catch (error) { console.warn('[Helmian Guard] scribe alarm sync failed:', error.message); }
}
async function notifyFresh(fresh) {
  if (!fresh || !fresh.length || !chrome.notifications) return;
  const granted = await new Promise((resolve) => {
    try { chrome.permissions.contains({ permissions: ['notifications'] }, (ok) => resolve(Boolean(ok))); } catch { resolve(false); }
  });
  if (!granted) return;
  for (const { mailbox, items } of fresh.slice(0, 4)) {
    const t = noticeText(mailbox, items);
    try {
      chrome.notifications.create(`helmion-scribe:${mailbox}:${items[items.length - 1].id}`, {
        type: 'basic', iconUrl: 'popup/icon-128.png', title: t.title, message: t.message, priority: 1,
      });
    } catch { /* notification is best effort */ }
  }
}
function idleState() {
  return new Promise((resolve) => {
    try { if (!chrome.idle) { resolve('active'); return; } chrome.idle.queryState(300, (st) => resolve(st || 'active')); }
    catch { resolve('active'); }
  });
}
export async function runScribePoll(opts = {}) {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const idle = (await idleState()) !== 'active';
  const result = await pollScribe(ledger, { online, idle, ...opts });
  // 0.6.0: the badge and notices are off by default (Troy: no doorbell to click).
  // The poll only records state; the badge arbiter below paints, and it
  // honours the same showBadge switch when it reaches the mail tier.
  if (typeof result.unread === 'number') await refreshGlobalBadge();
  if (result.fresh) await notifyFresh(result.fresh);
  await runAutoNudge(result).catch((error) => console.warn('[Helmian Guard] auto-nudge pass failed:', error && error.message));
  return result;
}
// ─── SCRIBE APPROVALS POP-UP (0.7.0) ───────────────────────────────────────
// The door (connect.helmian.cloud/approvals) holds the list and takes the
// decisions; this is only its poll + badge + popup plumbing. See
// background/approvals-client.js for the contract and the rule that the
// passphrase is never stored. The badge is the whole signal: amber, global,
// count only. Nothing opens, sounds or steals focus — the pop-up appears
// when Troy clicks the icon, which is the point of the feature.
const APPROVALS_BADGE = '#c77700';
async function syncApprovalsAlarm() {
  try {
    if (!chrome.alarms) return;
    const s = await getApprovalsState(ledger);
    if (s.session === 'in') chrome.alarms.create(APPROVALS_ALARM, { periodInMinutes: ALARM_PERIOD_MIN, delayInMinutes: 0.5 });
    else chrome.alarms.clear(APPROVALS_ALARM);
  } catch (error) { console.warn('[Helmian Guard] approvals alarm sync failed:', error.message); }
}
// ─── THE GLOBAL BADGE: ONE ARBITER ─────────────────────────────────────────
// Three features want the icon's global (tab-less) badge text: PC approvals,
// the Scribe door approvals, and Scribe unread mail. They used to paint it
// independently and overwrite each other: a mail poll landing after an
// approvals poll wiped the waiting count Troy was meant to see, and the door
// painter had to keep a badgeOwned flag just to know whether clearing was
// safe. Now the polls only record their state (each client already does, in
// storage) and this one function paints, in a fixed priority:
//
//   1. PC approvals waiting: a decision Troy owes outranks everything.
//   2. Scribe door approvals waiting. The door state's badgeOwned flag is
//      kept truthful by this function: it is true exactly while the badge
//      is showing the door count.
//   3. Scribe unread mail, and only when the badge is switched on in the
//      Scribe settings (off by default; see runScribePoll).
//
// Zero everywhere paints empty. The PER-TAB badge is a different surface:
// setBadge() above always passes a tabId, so it never writes the global
// text, and this arbiter never writes a tab's. Chrome shows a focused tab
// its own badge in place of the global one; that is existing behaviour
// and unchanged.
const PC_BADGE = '#c77700'; // the door approvals amber: a decision waiting reads the same on both roads
async function refreshGlobalBadge() {
  try {
    const pc = await getPcApprovalsState(ledger);
    const pcText = pc.session === 'in' ? pcBadgeText(pc.count) : '';
    if (pcText) {
      chrome.action.setBadgeText({ text: pcText });
      chrome.action.setBadgeBackgroundColor({ color: PC_BADGE });
      chrome.action.setTitle({ title: `Helmian Guard: ${pc.count} PC approval(s) waiting for your decision` });
      await setApprovalsBadgeOwned(ledger, false);
      return;
    }
    const door = await getApprovalsState(ledger);
    const doorText = approvalsBadgeText(door.session === 'in' ? door.count : 0);
    if (doorText) {
      chrome.action.setBadgeText({ text: doorText });
      chrome.action.setBadgeBackgroundColor({ color: APPROVALS_BADGE });
      chrome.action.setTitle({ title: `Helmian Guard: ${door.count} approval(s) waiting for your decision` });
      await setApprovalsBadgeOwned(ledger, true);
      return;
    }
    if (door.badgeOwned) await setApprovalsBadgeOwned(ledger, false);
    const settings = await getScribeSettings(ledger);
    const inbox = settings.showBadge ? await inboxView(ledger) : null;
    const mailText = inbox ? badgeFor(inbox.unread) : '';
    chrome.action.setBadgeText({ text: mailText });
    if (mailText) {
      chrome.action.setBadgeBackgroundColor({ color: SCRIBE_BADGE });
      chrome.action.setTitle({ title: `Helmian Guard: ${inbox.unread} unread Scribe letter(s)` });
    }
  } catch { /* badge is best effort */ }
}
export async function runApprovalsPoll(opts = {}) {
  const result = await pollApprovals(ledger, opts);
  await refreshGlobalBadge();
  if (result.session === 'out') await syncApprovalsAlarm();
  return result;
}
// ─── PC APPROVALS (approvals pop-up build, Bites 2 and 4) ──────────────────
// The Helmian app's own approvals (background/pc-approvals-client.js): the
// actions an agent asked the Executive Guard to run on Troy's PC, decided
// through Helmian's proxy — this extension holds no Guard credential for
// this road. The wiring: this poll and the badge arbiter (Bite 2), the
// pop-up section (Bite 3), the notification knock (Bite 4), and the
// approvals window further below (Bite 5).
//
// One difference from the door poll above: this alarm is never cleared for
// being signed out. The door's sign-in happens inside the extension, so its
// poll can afford to stop; this sign-in happens on the website, so a poll
// that stopped at the first 401 could never notice Troy signing back in.
// The client folds a 401 to its signed-out state and keeps its 60-second
// cadence; its badge contribution simply reads zero while signed out.
async function syncPcApprovalsAlarm() {
  try {
    if (!chrome.alarms) return;
    chrome.alarms.create(PC_APPROVALS_ALARM, { periodInMinutes: ALARM_PERIOD_MIN, delayInMinutes: 0.5 });
  } catch (error) { console.warn('[Helmian Guard] pc approvals alarm sync failed:', error.message); }
}
export async function runPcApprovalsPoll(opts = {}) {
  const before = await getPcApprovalsState(ledger);
  const result = await pollPcApprovals(ledger, opts);
  await refreshGlobalBadge();
  // The knock (Bite 4, below) reads the rise from the state this poll
  // just stored, set against the state as it stood before the poll ran.
  await notifyPcKnock(before, await getPcApprovalsState(ledger));
  return result;
}
// ─── PC APPROVALS KNOCK (approvals pop-up build, Bite 4) ───────────────────
// The badge is the standing signal; this is the knock. When a poll finds
// the waiting count has risen FROM ZERO — a first action is waiting where
// none was — exactly one plain notification appears: no buttons, nothing
// to decide inside it, the ask itself as its message. Further arrivals
// while anything is already waiting do not knock again, and a count that
// falls back to zero re-arms the knock for the next arrival. The rise is
// decided from the client's refreshed stored state after the poll, never
// from a stale guess.
//
// The knock fires only when the notifications permission is granted. That
// permission is optional in the manifest and is asked for only from a
// click in the pop-up (popup.js, the PC section's "Turn on alerts"
// button) — never at install, never at startup, never from here. Without
// it the badge alone carries the news, and nothing breaks.
//
// The knock is best effort throughout: the badge has already been painted
// by the time this runs, and a browser without notifications changes
// nothing else.
export const PC_KNOCK_ID = 'helmion-pc-approvals';

export function pcKnockText(state) {
  const first = (state && state.items && state.items[0]) || null;
  const ask = first && first.summary ? String(first.summary) : 'An action';
  const count = Number(state && state.count) || 0;
  return {
    title: 'Helmian Guard — an action is waiting for your decision',
    message: count > 1 ? `${ask} (${count} waiting in all.)` : ask,
  };
}

async function notificationsGranted() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') { resolve(false); return; }
      const r = chrome.permissions.contains({ permissions: ['notifications'] }, (ok) => { void chrome.runtime.lastError; resolve(Boolean(ok)); });
      if (r && typeof r.then === 'function') r.then((ok) => resolve(Boolean(ok)), () => resolve(false));
    } catch { resolve(false); }
  });
}

export async function notifyPcKnock(before, after) {
  try {
    if (!chrome.notifications) return false;
    if (!before || !after) return false;
    if (Number(before.count) !== 0) return false; // only a rise FROM zero knocks
    if (!(Number(after.count) > 0)) return false; // ...to something waiting
    if (after.session !== 'in' || after.owner === false) return false; // count means waiting only then
    if (!await notificationsGranted()) return false;
    const t = pcKnockText(after);
    try {
      chrome.notifications.create(PC_KNOCK_ID, {
        type: 'basic', iconUrl: 'popup/icon-128.png', title: t.title, message: t.message, priority: 1,
      });
    } catch { return false; /* notification is best effort */ }
    return true;
  } catch { return false; }
}
// ─── PC APPROVALS WINDOW (approvals pop-up build, Bite 5) ──────────────────
// The careful decision surface: one small popup-type window showing the
// full PC approvals list (popup/approvals-window.html). It is
// single-instance — opening it while it stands focuses the same window
// instead of stacking a second — and it is opened from exactly two
// places: the pop-up's "Open approvals window" button (the
// helmion:pc-approvals-open-window message below) and the knock's click.
//
// The window's id is tracked in this module's memory and cleared by the
// onRemoved listener when the window closes. It is deliberately NOT
// kept in storage: window ids are per browser session and get reused,
// so a stored id could later point at somebody else's window, and the
// storage permission belongs to the ledger alone. A service worker that
// was evicted while the window stood open has forgotten the id, so the
// open path also scans the open windows for one already showing the
// page before it creates anything.
export const PC_APPROVALS_WINDOW_PAGE = 'popup/approvals-window.html';
export const PC_APPROVALS_WINDOW_SIZE = Object.freeze({ width: 420, height: 560 });
let pcApprovalsWindowId = null;

function windowsCall(method, ...args) {
  return new Promise((resolve) => {
    try {
      const r = chrome.windows[method](...args, (value) => { void chrome.runtime.lastError; resolve(value || null); });
      if (r && typeof r.then === 'function') r.then((value) => resolve(value || null), () => resolve(null));
    } catch { resolve(null); }
  });
}

async function focusPcApprovalsWindow(id) {
  const win = await windowsCall('get', id);
  if (!win) return false;
  await windowsCall('update', id, { focused: true });
  return true;
}

export async function openPcApprovalsWindow() {
  try {
    if (!chrome.windows || typeof chrome.windows.create !== 'function') return false;
    if (pcApprovalsWindowId != null) {
      if (await focusPcApprovalsWindow(pcApprovalsWindowId)) return true;
      pcApprovalsWindowId = null;
    }
    const url = chrome.runtime.getURL(PC_APPROVALS_WINDOW_PAGE);
    const all = await windowsCall('getAll', { populate: true });
    const found = (all || []).find((w) => (w.tabs || []).some((t) => String(t.url || '') === url));
    if (found && typeof found.id === 'number') {
      pcApprovalsWindowId = found.id;
      await focusPcApprovalsWindow(found.id);
      return true;
    }
    const created = await windowsCall('create', {
      url, type: 'popup', width: PC_APPROVALS_WINDOW_SIZE.width, height: PC_APPROVALS_WINDOW_SIZE.height,
    });
    if (created && typeof created.id === 'number') pcApprovalsWindowId = created.id;
    return Boolean(created);
  } catch { return false; }
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    // Closing the window decides nothing; it only forgets the window, so
    // the next open re-reads the list into a fresh one.
    if (windowId === pcApprovalsWindowId) pcApprovalsWindowId = null;
  });
}
// ─── The knock's click target ──────────────────────────────────────────────
// Clicking the knock opens the approvals window (Bite 5). In Bite 4 this
// one line opened the Helmian approvals page in a tab, the decision
// surface of that day; the re-point Bite 4 promised is this line and
// nothing else — the listener below and the knock itself did not move.
function openPcApprovalsSurface() {
  try { openPcApprovalsWindow(); } catch { /* best effort */ }
}
// ─── SCRIBE AUTO-NUDGE (0.6.0, off by default) ─────────────────────────────
// Queue fresh letters (ids only), then let the policy decide per open chat tab.
// The text is fixed (nudge-policy.js nudgeText); letter content never leaves here.
function tabUrl(tabId, api = chrome) {
  return new Promise((resolve) => {
    try { api.tabs.get(tabId, (tab) => { void api.runtime.lastError; resolve(tab && tab.url ? tab.url : ''); }); }
    catch { resolve(''); }
  });
}
// 0.6.7 re-checks the tab's CURRENT url just before typing, so a tab that moved
// to a non-chat page (or a lookalike app) is refused, never typed into.
// Chrome only tells an extension a tab's url when it has the "tabs" permission
// or HOST permission for that site; content-script matches do not count. Guard
// 0.6.7-0.6.8 had neither for the AI sites, so the url always came back empty,
// every nudge was refused as "not a chat page" and the tab was forgotten: the
// auto-nudge never typed anything. An EMPTY url therefore means "unknown", not
// "wrong page": the content script's own check inside the tab (nudge.js probe:
// exact host + chat path + real composer, from the page's own location) decides.
// A KNOWN url that is not a chat page is still refused here.
export function nudgeUrlRefusal(url) {
  return url && !siteForUrl(url) ? 'not a chat page' : null;
}
export function sendNudgeToTab(tabId, message, api = chrome) {
  return new Promise(async (resolve) => {
    if (message && message.type === 'helmion:nudge-try' && api.tabs && typeof api.tabs.get === 'function') {
      const refusal = nudgeUrlRefusal(await tabUrl(tabId, api));
      if (refusal) { resolve({ ok: false, reason: 'refused', detail: refusal }); return; }
    }
    try {
      api.tabs.sendMessage(tabId, message, (answer) => { void api.runtime.lastError; resolve(answer || null); });
    } catch { resolve(null); }
  });
}
const sendToTab = (tabId, message) => sendNudgeToTab(tabId, message);
export async function runAutoNudge(result = {}, { now = Date.now() } = {}) {
  for (const { mailbox, items } of (result && result.mail) || []) await queuePending(ledger, mailbox, items, now);
  // 0.6.8: always pass the last known unread counts, so letters that stay unread get re-nudged.
  const unread = (result && result.boxes) || unreadByBox(await readScribeState(ledger));
  return runNudges(ledger, { sendToTab, now, unread });
}
export function plainLaunchError(raw) {
  const m = String(raw || '');
  if (!m || /did not approve|closed|cancel/i.test(m)) return 'The Scribe sign-in window was closed before sign-in finished. Click Connect Scribe to try again.';
  if (/could not be loaded/i.test(m)) return `The Scribe sign-in page could not be loaded (browser said: ${m}). Check your internet connection and that the Scribe server is up, then try again.`;
  return `The browser could not open the Scribe sign-in window (browser said: ${m}).`;
}
function identityApi() {
  const b = globalThis.browser && globalThis.browser.identity;
  if (b && typeof b.launchWebAuthFlow === 'function') return { launch: (url) => b.launchWebAuthFlow({ url, interactive: true }), redirect: b.getRedirectURL() };
  const c = chrome.identity;
  if (c && typeof c.launchWebAuthFlow === 'function') {
    return {
      launch: (url) => new Promise((resolve, reject) => chrome.identity.launchWebAuthFlow({ url, interactive: true }, (final) => {
        const err = chrome.runtime.lastError; if (err || !final) reject(new Error((err && err.message) || 'Sign-in was cancelled')); else resolve(final);
      })),
      redirect: c.getRedirectURL(),
    };
  }
  return null;
}

// The nudge: open (or focus) the AI that owns the mailbox so it runs check_inbox.
function openMailboxSite(mailbox) {
  const url = MAILBOX_SITES[mailbox];
  if (!url) { try { if (chrome.action.openPopup) chrome.action.openPopup(); } catch { /* unsupported */ } return false; }
  try { chrome.tabs.create({ url }); return true; } catch { return false; }
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === SCRIBE_ALARM) runScribePoll().catch(() => {});
    if (alarm && alarm.name === APPROVALS_ALARM) runApprovalsPoll().catch(() => {});
    if (alarm && alarm.name === PC_APPROVALS_ALARM) runPcApprovalsPoll().catch(() => {});
  });
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id === PC_KNOCK_ID) {
      openPcApprovalsSurface();
      try { chrome.notifications.clear(id); } catch { /* ignore */ }
      return;
    }
    const m = /^helmion-scribe:([^:]+):/.exec(String(id));
    if (!m) return;
    openMailboxSite(m[1]);
    try { chrome.notifications.clear(id); } catch { /* ignore */ }
  });
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { syncScribeAlarm(); syncApprovalsAlarm(); syncPcApprovalsAlarm(); });
export const ONBOARDING_PAGE = 'onboarding/onboarding.html';
export function handleInstalled(details, api = chrome) {
  syncScribeAlarm(); syncApprovalsAlarm(); syncPcApprovalsAlarm();
  const reason = details && details.reason;
  // Open AI tabs still run the PREVIOUS copy of Guard after an install or
  // update, and that copy can no longer reach this worker. Put a working copy
  // into them now instead of waiting for a reload.
  if (reason === 'install' || reason === 'update') {
    reinjectOpenTabs(api).catch((e) => console.warn('[Helmian Guard] re-inject into open tabs failed:', e && e.message));
  }
  // 0.6.2: first install opens the welcome page. Updates and browser updates do not,
  // unless a preset just filled in an empty profile (then only Connect Scribe is left).
  if (reason === 'update') {
    migrateNudgeSites(ledger).catch((e) => console.warn('[Helmian Guard] nudge-site migration failed:', e && e.message));
    applyPreset(ledger, api)
      .then((applied) => { if (applied) openWelcome(api); })
      .catch((e) => console.warn('[Helmian Guard] preset failed:', e && e.message));
  }
  if (reason === 'install') {
    applyPreset(ledger, api)
      .catch((e) => console.warn('[Helmian Guard] preset failed:', e && e.message))
      .finally(() => openWelcome(api));
    return true;
  }
  return false;
}
function openWelcome(api) {
  try { api.tabs.create({ url: api.runtime.getURL(ONBOARDING_PAGE) }); } catch (error) { console.warn('[Helmian Guard] could not open the welcome page:', error && error.message); }
}

// ─── RE-INJECT INTO OPEN TABS (0.6.9 candidate) ───────────────────────────
// Chrome does not put an updated extension's content scripts into tabs that
// were already open. Those tabs keep the old copy, which can no longer reach
// the worker ("Extension context invalidated"); on 0.6.8 that drew the big
// red "Safety checks may be incomplete" box over the chat until the tab was
// reloaded. Inject the manifest's own content scripts (and CSS, which also
// hides a stale copy's old red box) into every open tab they match.
export async function reinjectOpenTabs(api = chrome) {
  if (!api.scripting || !api.tabs || typeof api.tabs.query !== 'function') return 0;
  const entries = (api.runtime.getManifest && api.runtime.getManifest().content_scripts) || [];
  let injected = 0;
  for (const entry of entries) {
    let tabs = [];
    try { tabs = await api.tabs.query({ url: entry.matches }); } catch { tabs = []; }
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || tab.discarded) continue;
      try {
        if (entry.css && entry.css.length) await api.scripting.insertCSS({ target: { tabId: tab.id }, files: entry.css });
        await api.scripting.executeScript({ target: { tabId: tab.id }, files: entry.js });
        injected += 1;
      } catch (error) {
        console.warn('[Helmian Guard] could not refresh Guard in an open tab:', error && error.message);
      }
    }
  }
  return injected;
}

// ─── PRESET (0.6.9 candidate) ─────────────────────────────────────────────
// An optional preset.json shipped inside the extension folder (written by
// tools/package-guard.mjs --preset FILE; never committed with anyone's data)
// fills in the welcome page for a person: name, the AIs they use (which sets
// Scribe mailboxes and auto-nudge sites) and the Scribe door-knock. It only
// ever fills an EMPTY profile: settings the person already chose are never
// overwritten. Scribe sign-in still needs the person's own click (the browser
// permission prompt and Scribe's consent page cannot be pre-answered).
export const PRESET_FILE = 'preset.json';
export const PRESET_APPLIED_KEY = 'helmion.preset.applied';
export async function readPreset(api = chrome, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(api.runtime.getURL(PRESET_FILE));
    if (!res || !res.ok) return null;
    const preset = await res.json();
    return preset && typeof preset === 'object' ? preset : null;
  } catch { return null; }
}
export async function applyPreset(storage, api = chrome, fetchImpl = globalThis.fetch) {
  if (await readOnboarding(storage)) return null; // never overwrite the person's own choices
  const preset = await readPreset(api, fetchImpl);
  if (!preset) return null;
  const profile = await saveOnboarding(storage, { name: preset.name, ais: preset.ais });
  const scribe = preset.scribe && typeof preset.scribe === 'object' ? preset.scribe : {};
  if (scribe.enabled === true) await setScribeSettings(storage, { enabled: true });
  if (preset.nudge && preset.nudge.enabled === false) await setNudgeSettings(storage, { enabled: false });
  await storage.set(PRESET_APPLIED_KEY, { at: new Date().toISOString(), ais: profile.ais });
  try { await syncScribeAlarm(); } catch { /* the next start syncs it */ }
  return profile;
}
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener((details) => { handleInstalled(details); });

// ─── WELCOME PAGE (0.6.2) ─────────────────────────────────────────────────
export const PROFILE_KEY = 'helmion.profile';
export async function saveOnboarding(storage, { name, ais } = {}) {
  const who = String(name || '').trim().slice(0, 200);
  if (!who) throw new Error('Type your name or email first.');
  const keys = (Array.isArray(ais) ? ais : []).filter((k) => AI_CHOICES.some((c) => c.key === k));
  if (!keys.length) throw new Error('Tick at least one AI you use.');
  const mailboxes = mailboxesForAis(keys);
  await storage.set(PROFILE_KEY, { name: who, ais: keys, savedAt: new Date().toISOString() });
  const s = await getScribeSettings(storage);
  await setScribeSettings(storage, { mailboxes, ...(s.baseUrl ? {} : { baseUrl: SCRIBE_DEFAULT_URL }) });
  await storage.set(NUDGE_KNOWN_SITES_KEY, Object.keys(nudgeSitesForAis([])));
  await setNudgeSettings(storage, { enabled: true, sites: nudgeSitesForAis(keys), idleMinutes: DEFAULT_NUDGE_IDLE_MIN, dailyCapPerSite: DEFAULT_NUDGE_DAILY_CAP });
  return { name: who, ais: keys, mailboxes };
}
// 0.6.8: sites that gained nudge support after the welcome page was filled in
// (Perplexity 0.6.5, Mistral 0.6.6) stayed switched OFF, so they never nudged.
// On update, switch on any NEWLY supported site for an AI Troy ticked. Sites
// that already existed are left exactly as he set them.
export const NUDGE_KNOWN_SITES_KEY = 'helmion.nudge.knownSites';
const ORIGINAL_NUDGE_SITES = ['chatgpt.com', 'claude.ai', 'grok.com', 'gemini.google.com'];
export async function migrateNudgeSites(storage) {
  const known = await storage.get(NUDGE_KNOWN_SITES_KEY);
  const knownList = Array.isArray(known) ? known : ORIGINAL_NUDGE_SITES;
  const profile = await readOnboarding(storage);
  const want = profile && Array.isArray(profile.ais) ? nudgeSitesForAis(profile.ais) : {};
  const turnOn = {};
  for (const [site, on] of Object.entries(want)) if (on && !knownList.includes(site)) turnOn[site] = true;
  if (Object.keys(turnOn).length) await setNudgeSettings(storage, { sites: turnOn });
  await storage.set(NUDGE_KNOWN_SITES_KEY, Object.keys(nudgeSitesForAis([])));
  return turnOn;
}
export async function readOnboarding(storage) {
  const p = await storage.get(PROFILE_KEY);
  return p && typeof p === 'object' ? p : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    const type = message && message.type;

    if (PRIVILEGED_TYPES.has(type) && !senderAllowedFor(type, sender)) {
      console.warn('[Helmian Guard] refused a privileged ledger message from an unexpected sender:', type);
      sendResponse({ ok: false, error: 'this message is only accepted from Guard\'s own pages (popup, options, welcome); approvals only from the extension popup' });
      return false;
    }

    if (type === 'helmion:scan') {
      const results = scanBlocks(message.blocks || []);
      sendResponse({ ok: true, results });
      return false;
    }

    if (type === 'helmion:claims') {
      const results = scanProse(message.passages || []);
      sendResponse({ ok: true, results });
      return false;
    }

    // ─── THE DURABLE LEDGER ─────────────────────────────────────────────────
    //
    // These are async, so each returns TRUE to keep the message channel open —
    // the one Chrome MV3 rule that silently breaks a handler if you forget it.
    // Every path settles sendResponse exactly once, including on failure: a
    // ledger write that fails must say so, not leave the caller waiting.
    if (type === 'helmion:log') {
      const entry = makeEntry(message.entry || {});
      appendEntry(ledger, entry)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:ledger') {
      readLedger(ledger)
        .then((entries) => sendResponse({ ok: true, entries }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:ledger-stats') {
      ledgerStats(ledger)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:ledger-export') {
      exportBundle(ledger)
        .then((bundle) => sendResponse({ ok: true, bundle }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:ledger-clear') {
      clearLedger(ledger)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    // ─── OPT-IN CLOUD UPLOAD ────────────────────────────────────────────────
    //
    // Disabled by default. The popup settings UI is the only caller. See
    // background/upload.js for the full explanation and the warning that this
    // needs Troy's manual browser testing.
    if (type === 'helmion:guard-upload-settings') {
      const payload = message.settings || {};
      const isWrite = Object.prototype.hasOwnProperty.call(payload, 'enabled')
        || Object.prototype.hasOwnProperty.call(payload, 'deviceToken');
      const done = isWrite
        ? setUploadSettings(ledger, { enabled: payload.enabled, deviceToken: payload.deviceToken })
        : getUploadSettings(ledger);
      done
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:guard-upload') {
      getUploadSettings(ledger)
        .then((settings) => {
          if (!settings.enabled) { sendResponse({ ok: true, skipped: 'not-enabled' }); return; }
          return uploadNewFindings(ledger).then((result) => sendResponse({ ok: true, ...result }));
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    // ─── EXECUTIVE GUARD VERIFICATION LOOP ─────────────────────────────────
    // See background/executive.js. Without a paired server these answer from
    // the local policy and say so (source:'local', verified:false).
    //
    // AT-1 T2: a decision that COMES BACK from the server and fails
    // verification (ruleId 'unverified-decision') is a forgery attempt or a
    // hostile server. The rejection reaches the page labelled unverified in
    // the moment; this append gives it a durable local record too — exactly
    // one ledger entry per unverified decision, carrying the ruleId and the
    // verify error. Local-policy answers carry a local ruleId, not this
    // one, so they never land here: no decision came back, nothing to file.
    // A failed ledger write is logged and swallowed — it must never change
    // the decision answer the page receives.
    const fileUnverifiedDecision = async (result, site) => {
      const entry = makeEntry({
        kind: KIND_UNVERIFIED_DECISION,
        site: site || '',
        matched: result.ruleId,
        text: result.verifyError || result.reason || '',
        outcome: 'denied-unverified',
      });
      try { await appendEntry(ledger, entry); }
      catch (error) { console.warn('[Helmian Guard] could not file an unverified decision in the ledger:', error?.message || error); }
    };
    if (type === 'helmion:decide') {
      let action;
      try { action = cleanAction(message.action); }
      catch (error) { sendResponse({ ok: false, error: error.message }); return false; }
      requestDecision(ledger, action, { pendingApprovals })
        .then(async (decision) => {
          if (decision && decision.verified === false && decision.ruleId === 'unverified-decision') {
            await fileUnverifiedDecision(decision, action.site);
          }
          sendResponse({ ok: true, decision });
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:approval-status') {
      pollApproval(ledger, String(message.approvalId || ''), { pendingApprovals })
        .then(async (status) => {
          if (status && status.verified === false && status.ruleId === 'unverified-decision') {
            await fileUnverifiedDecision(status, '');
          }
          sendResponse({ ok: true, status });
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:executive-settings') {
      const payload = message.settings || {};
      const isWrite = ['enabled', 'serverUrl', 'deviceToken'].some((k) => Object.prototype.hasOwnProperty.call(payload, k));
      (isWrite ? setExecutiveSettings(ledger, payload) : getExecutiveSettings(ledger))
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:executive-pair') {
      pairExecutive(ledger)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    // ─── FLAGS ──────────────────────────────────────────────────────────────
    // Every flag is logged locally. It is reported to the Flags API only when
    // the user opted in (background/flags-client.js).
    if (type === 'helmion:flag') {
      const flag = message.flag || {};
      const entry = makeEntry({
        kind: 'ai-flag',
        site: flag.site,
        matched: `${flag.kind}: ${flag.rule}`,
        text: flag.excerpt,
        outcome: 'flagged',
      });
      appendEntry(ledger, entry)
        .then(() => reportFlag(ledger, {
          ...flag,
          id: flag.id || entry.id,
          // The page the content script runs in; flags-client keeps only the
          // origin and path, and only on the four chat sites.
          url: (sender && (sender.url || (sender.tab && sender.tab.url))) || undefined,
        }, { version: extensionVersion(), browser: browserFamily() }))
        .then((report) => sendResponse({ ok: true, report }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    // Content script: may it cross-check a message with the Flags scanner?
    // Answers a yes/no only; the key and URL never go to a page.
    if (type === 'helmion:flags-config') {
      getFlagsSettings(ledger)
        .then((s) => sendResponse({ ok: true, scanBeforeSend: s.enabled && s.scanBeforeSend && s.hasKey && Boolean(s.baseUrl) && !s.keyRejected }))
        .catch(() => sendResponse({ ok: true, scanBeforeSend: false }));
      return true;
    }

    if (type === 'helmion:flags-scan') {
      if (!isFromOwnContentScript(sender)) { sendResponse({ ok: false, error: 'not allowed' }); return false; }
      scanText(ledger, typeof message.text === 'string' ? message.text : '')
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:flags-alerts') {
      const opts = message.options || {};
      (opts.markSeen ? markAlertsSeen(ledger).then(() => pollAlerts(ledger, { force: false })) : pollAlerts(ledger, { force: opts.force === true }))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:flags-settings') {
      const payload = message.settings || {};
      const isWrite = ['enabled', 'baseUrl', 'apiKey', 'scanBeforeSend', 'dailyBudget'].some((k) => Object.prototype.hasOwnProperty.call(payload, k));
      (isWrite ? setFlagsSettings(ledger, payload) : getFlagsSettings(ledger))
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:scribe-settings') {
      const payload = message.settings || {};
      const isWrite = ['enabled', 'baseUrl', 'token', 'mailboxes', 'includeLegacy', 'dailyBudget', 'notify', 'showBadge', 'unreadPath', 'clearToken'].some((k) => Object.prototype.hasOwnProperty.call(payload, k));
      (isWrite ? setScribeSettings(ledger, payload).then(async (r) => { await syncScribeAlarm(); return r; }) : getScribeSettings(ledger))
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:scribe-inbox') {
      const force = message.options && message.options.force === true;
      (force ? runScribePoll({ force: true }) : Promise.resolve({}))
        .then(async (poll) => sendResponse({ ok: true, skipped: poll.skipped, ...(await inboxView(ledger)) }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:nudge-hello') {
      // Any of the four chat origins registers its tab. Not privileged: it only
      // says "a chat tab exists here"; the policy and switches still decide.
      const site = sender && sender.tab && sender.tab.url ? siteForUrl(sender.tab.url) : null; // 0.6.7: exact host + chat path
      if (site && sender.tab.id != null) noteTab(ledger, sender.tab.id, site, Date.now()).catch(() => {});
      sendResponse({ ok: Boolean(site) });
      return false;
    }

    if (type === 'helmion:nudge-settings') {
      const payload = message.settings || {};
      const write = Object.keys(payload).length > 0;
      (write ? setNudgeSettings(ledger, payload) : getNudgeSettings(ledger))
        .then(async (settings) => sendResponse({ ok: true, settings, log: (await readNudgeLog(ledger)).slice(-40).reverse() }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:scribe-signin') {
      const action = message.action;
      const run = async () => {
        if (action === 'status') return getScribeAuth(ledger);
        if (action === 'signout') return scribeSignOut(ledger);
        if (action === 'redirect') return { redirectUrl: redirectUrlFor(chrome.runtime.id, chrome.identity || (globalThis.browser && globalThis.browser.identity)) };
        const s = await getScribeSettings(ledger);
        if (!s.baseUrl) throw new Error('No Scribe server address is set. Open Advanced and enter it.');
        const id = identityApi();
        if (!id) throw new Error('The browser did not give Guard the "identity" permission, so it cannot open the Scribe sign-in window. Click Connect Scribe again and choose Allow.');
        const view = await scribeSignIn(ledger, s.baseUrl, { launch: id.launch, redirectUri: id.redirect });
        // 0.6.2: knock is on by default once signed in.
        await setScribeSettings(ledger, { clearRejected: true, enabled: true });
        await syncScribeAlarm();
        return view;
      };
      run().then((auth) => sendResponse({ ok: true, auth })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:approvals-view') {
      const force = message.options && message.options.force === true;
      runApprovalsPoll({ force })
        .then(async () => sendResponse({ ok: true, view: approvalsView(await getApprovalsState(ledger)) }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:approvals-signin') {
      // The passphrase exists only inside this call and the client's one
      // POST. It is never written to storage (approvals-client.js).
      signInToApprovals(ledger, String(message.passphrase || ''))
        .then(async (result) => {
          await syncApprovalsAlarm();
          await refreshGlobalBadge();
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:approvals-decide') {
      decideApproval(ledger, String(message.id || ''), message.verdict === 'approve' ? 'approve' : 'deny')
        .then(async (result) => {
          await refreshGlobalBadge();
          if (result.view && result.view.session === 'out') await syncApprovalsAlarm();
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:pc-approvals-view') {
      const force = message.options && message.options.force === true;
      runPcApprovalsPoll({ force })
        .then(async () => sendResponse({ ok: true, view: pcApprovalsView(await getPcApprovalsState(ledger)) }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:pc-approvals-decide') {
      // The decision goes to Helmian's own decide route through the client,
      // which confirms it by refresh before calling it done; the badge is
      // repainted from the refreshed state either way.
      decidePcApproval(ledger, String(message.id || ''), message.verdict === 'approve' ? 'approve' : 'deny')
        .then(async (result) => {
          await refreshGlobalBadge();
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:pc-approvals-open-window') {
      // The pop-up's window button. Opening decides nothing and touches
      // no list; it only brings the decision surface forward.
      openPcApprovalsWindow()
        .then((opened) => sendResponse(opened
          ? { ok: true, opened: true }
          : { ok: false, error: 'The approvals window could not be opened.' }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:onboarding') {
      (message.action === 'save' ? saveOnboarding(ledger, message.profile || {}) : readOnboarding(ledger))
        .then((profile) => sendResponse({ ok: true, profile }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:scribe-nudge') {
      sendResponse({ ok: true, opened: openMailboxSite(String(message.mailbox || '')) });
      return false;
    }

    if (type === 'helmion:badge') {
      setBadge(sender && sender.tab ? sender.tab.id : undefined, message);
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'helmion:status') {
      latestStatus = {
        protection: ['active', 'limited', 'paused', 'needs-attention'].includes(message.protection)
          ? message.protection : 'unknown',
        claims: ['active', 'limited', 'unavailable'].includes(message.claims)
          ? message.claims : 'unknown',
      };
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'helmion:guard-status') {
      sendResponse({ ok: true, status: latestStatus });
      return false;
    }

    sendResponse({ ok: false, error: `unknown message type: ${String(type)}` });
    return false;
  } catch (error) {
    // The content script turns this into a banner on the page. It never gets
    // swallowed here, because a check that failed silently is the failure mode
    // this whole extension exists to avoid.
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    return false;
  }
});
