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
import { scanProse } from './claims.js';
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    const type = message && message.type;

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
