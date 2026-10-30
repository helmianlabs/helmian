// The extension's background service worker.
//
// It exists because the checking has to happen somewhere that can load ES
// modules, and a Chrome content script cannot. The worker imports the copied
// Helmion modules and answers three messages:
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
  pollScribe,
  setScribeSettings,
} from './scribe-client.js';
import { getAuth as getScribeAuth, signIn as scribeSignIn, signOut as scribeSignOut } from './scribe-auth.js';
import {
  getNudgeSettings, queuePending, readNudgeLog, runNudges, setNudgeSettings, noteTab, siteForHost,
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
      chrome.action.setTitle({ tabId, title: 'Helmion Guard needs attention — open for details' });
      return;
    }
    const dangerous = Number(info.dangerous) || 0;
    if (dangerous > 0) {
      chrome.action.setBadgeText({ tabId, text: String(dangerous) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: RED });
      chrome.action.setTitle({
        tabId,
        title: `Helmion Guard flagged ${dangerous} destructive code block(s) on this page`,
      });
      return;
    }
    if (info.degraded) {
      chrome.action.setBadgeText({ tabId, text: '•' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: BLUE });
      chrome.action.setTitle({ tabId, title: 'Helmion Guard is active — open for status' });
      return;
    }
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Helmion Guard is watching this page' });
  } catch (error) {
    // A tab that closed mid-flight is not a failure worth surfacing.
    console.warn('[Helmion Guard] badge update failed:', error.message);
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
]);

// 0.6.2 FIX: this used to refuse any sender with a `tab`. The popup opened as
// a full tab (chrome-extension://<id>/popup/popup.html) has a tab, so every
// settings save and the Scribe sign-in were refused with "only accepted from
// the extension popup" (reproduced in Chromium 141 with the 0.6.0 build).
// What matters is the sender's URL: our own popup page. A content script's
// sender.url is the web page's URL, so it is still refused.
export function isFromOwnPopup(sender, runtime = chrome.runtime) {
  if (!sender) return false;
  if (sender.id !== runtime.id) return false;
  try {
    return String(sender.url || '').startsWith(runtime.getURL('popup/'));
  } catch {
    // getURL unavailable. Fail CLOSED — an unverifiable sender does not get the
    // ledger. A safety tool's evidence log is the last thing to hand out on a
    // maybe.
    return false;
  }
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
    else { chrome.alarms.clear(SCRIBE_ALARM); setScribeBadge(0); }
  } catch (error) { console.warn('[Helmion Guard] scribe alarm sync failed:', error.message); }
}
function setScribeBadge(unread) {
  try {
    chrome.action.setBadgeText({ text: badgeFor(unread) });
    if (unread > 0) {
      chrome.action.setBadgeBackgroundColor({ color: SCRIBE_BADGE });
      chrome.action.setTitle({ title: `Helmion Guard: ${unread} unread Scribe letter(s)` });
    }
  } catch { /* badge is best effort */ }
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
  if (typeof result.unread === 'number') setScribeBadge(result.showBadge ? result.unread : 0);
  if (result.fresh) await notifyFresh(result.fresh);
  await runAutoNudge(result).catch((error) => console.warn('[Helmion Guard] auto-nudge pass failed:', error && error.message));
  return result;
}
// ─── SCRIBE AUTO-NUDGE (0.6.0, off by default) ─────────────────────────────
// Queue fresh letters (ids only), then let the policy decide per open chat tab.
// The text is fixed (nudge-policy.js nudgeText); letter content never leaves here.
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (answer) => { void chrome.runtime.lastError; resolve(answer || null); });
    } catch { resolve(null); }
  });
}
export async function runAutoNudge(result = {}, { now = Date.now() } = {}) {
  for (const { mailbox, items } of (result && result.mail) || []) await queuePending(ledger, mailbox, items, now);
  return runNudges(ledger, { sendToTab, now });
}
export function plainLaunchError(raw) {
  const m = String(raw || '');
  if (!m || /did not approve|closed|cancel/i.test(m)) return 'The Scribe sign-in window was closed before sign-in finished. Click Sign in to Scribe to try again.';
  if (/could not be loaded/i.test(m)) return `The Scribe sign-in page could not be loaded (browser said: ${m}). Check your internet connection and that the Scribe server is up, then try again.`;
  return `The browser could not open the Scribe sign-in window (browser said: ${m}).`;
}
function identityApi() {
  const b = globalThis.browser && globalThis.browser.identity;
  if (b && typeof b.launchWebAuthFlow === 'function') return { launch: (url) => b.launchWebAuthFlow({ url, interactive: true }).catch((e) => { throw new Error(plainLaunchError(e && e.message)); }), redirect: b.getRedirectURL() };
  const c = chrome.identity;
  if (c && typeof c.launchWebAuthFlow === 'function') {
    return {
      launch: (url) => new Promise((resolve, reject) => chrome.identity.launchWebAuthFlow({ url, interactive: true }, (final) => {
        const err = chrome.runtime.lastError; if (err || !final) reject(new Error(plainLaunchError(err && err.message))); else resolve(final);
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
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm && alarm.name === SCRIBE_ALARM) runScribePoll().catch(() => {}); });
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    const m = /^helmion-scribe:([^:]+):/.exec(String(id));
    if (!m) return;
    openMailboxSite(m[1]);
    try { chrome.notifications.clear(id); } catch { /* ignore */ }
  });
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { syncScribeAlarm(); });
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => { syncScribeAlarm(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    const type = message && message.type;

    if (PRIVILEGED_TYPES.has(type) && !isFromOwnPopup(sender)) {
      console.warn('[Helmion Guard] refused a privileged ledger message from an unexpected sender:', type);
      sendResponse({ ok: false, error: 'this message is only accepted from the extension popup' });
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
    if (type === 'helmion:decide') {
      let action;
      try { action = cleanAction(message.action); }
      catch (error) { sendResponse({ ok: false, error: error.message }); return false; }
      requestDecision(ledger, action, { pendingApprovals })
        .then((decision) => sendResponse({ ok: true, decision }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:approval-status') {
      pollApproval(ledger, String(message.approvalId || ''), { pendingApprovals })
        .then((status) => sendResponse({ ok: true, status }))
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
      const site = sender && sender.tab && sender.tab.url ? siteForHost(new URL(sender.tab.url).hostname) : null;
      if (site && sender.tab.id != null) noteTab(ledger, sender.tab.id, site, Date.now()).catch(() => {});
      sendResponse({ ok: Boolean(site) });
      return false;
    }

    if (type === 'helmion:nudge-settings') {
      const payload = message.settings || {};
      const write = Object.keys(payload).length > 0;
      (write ? setNudgeSettings(ledger, payload) : getNudgeSettings(ledger))
        .then(async (settings) => sendResponse({ ok: true, settings, log: (await readNudgeLog(ledger)).slice(-20).reverse() }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (type === 'helmion:scribe-signin') {
      const action = message.action;
      const run = async () => {
        if (action === 'status') return getScribeAuth(ledger);
        if (action === 'signout') return scribeSignOut(ledger);
        const s = await getScribeSettings(ledger);
        if (!s.baseUrl) throw new Error('Save the Scribe URL first');
        const id = identityApi();
        if (!id) throw new Error('The browser did not give Guard the "identity" permission, so it cannot open the Scribe sign-in window. Click Sign in to Scribe again and choose Allow.');
        const view = await scribeSignIn(ledger, s.baseUrl, { launch: id.launch, redirectUri: id.redirect });
        await setScribeSettings(ledger, { clearRejected: true });
        await syncScribeAlarm();
        return view;
      };
      run().then((auth) => sendResponse({ ok: true, auth })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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
        protection: ['active', 'limited', 'needs-attention'].includes(message.protection)
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
