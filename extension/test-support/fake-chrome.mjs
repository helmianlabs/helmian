// A stand-in for the pieces of the chrome.* API this extension uses.
//
// It is deliberately thin, and it routes messages to the REAL service worker
// listener in background/worker.js. So a test that sends a message from the
// content script exercises worker.js, scan.js and the copied kernel, not a
// pretend version of them.

const badgeCalls = [];
const listeners = [];
// chrome.storage.local, in memory. Added 2026-10-22 so end-to-end tests can see
// ledger rows and drive the Executive Guard / Flags settings through the real
// worker. Reset with fake.resetStorage().
const storageBag = new Map();
const alarmCalls = [];
const notificationCalls = [];
const alarmListeners = [];
let grantedPermissions = new Set();

export const fake = {
  // 'normal'  answer messages the way Chrome does
  // 'silent'  never answer, so the content script's timeout fires
  // 'missing' answer with no listener, the way a dead service worker looks
  mode: 'normal',
  pageUrl: 'https://chatgpt.com/c/test-conversation?model=x',
  badgeCalls,
  listeners,
  storageBag,
  alarmCalls,
  notificationCalls,
  alarmListeners,
  grant(p) { grantedPermissions.add(p); },
  revokeAll() { grantedPermissions = new Set(); },
  reset() {
    badgeCalls.length = 0;
    fake.mode = 'normal';
  },
  resetStorage() {
    storageBag.clear();
  },
};

export const chrome = {
  runtime: {
    id: 'helmion-guard-test-id',
    lastError: undefined,
    getURL(path) { return `chrome-extension://helmion-guard-test-id/${String(path).replace(/^\//, '')}`; },

    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },

    sendMessage(message, callback) {
      if (fake.mode === 'silent') return;

      setTimeout(() => {
        if (fake.mode === 'missing') {
          chrome.runtime.lastError = { message: 'Could not establish connection.' };
          if (callback) callback(undefined);
          chrome.runtime.lastError = undefined;
          return;
        }

        // What Chrome sets for a content script message: the extension id,
        // the frame URL and the tab.
        const pageUrl = fake.pageUrl;
        const sender = { id: chrome.runtime.id, url: pageUrl, tab: { id: 7, url: pageUrl } };
        let answered = false;
        const sendResponse = (response) => {
          answered = true;
          if (!callback) return;
          chrome.runtime.lastError = undefined;
          callback(response);
        };

        // A listener that returns true keeps the channel open and answers
        // later, exactly as Chrome allows (the async ledger, decide and flag
        // handlers rely on it).
        const keptOpen = listeners.map((listener) => listener(message, sender, sendResponse)).some((r) => r === true);

        if (!answered && !keptOpen && callback) {
          chrome.runtime.lastError = { message: 'no listener answered' };
          callback(undefined);
          chrome.runtime.lastError = undefined;
        }
      }, 0);
    },
  },

  storage: {
    local: {
      async get(key) {
        const keys = key == null ? [...storageBag.keys()] : (Array.isArray(key) ? key : [key]);
        const out = {};
        for (const k of keys) if (storageBag.has(k)) out[k] = structuredClone(storageBag.get(k));
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) storageBag.set(k, structuredClone(v));
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) storageBag.delete(k);
      },
    },
  },

  alarms: {
    create(name, info) { alarmCalls.push({ call: 'create', name, ...info }); },
    clear(name) { alarmCalls.push({ call: 'clear', name }); },
    onAlarm: { addListener(l) { alarmListeners.push(l); } },
  },
  notifications: {
    create(id, opts) { notificationCalls.push({ call: 'create', id, ...opts }); },
    clear(id) { notificationCalls.push({ call: 'clear', id }); },
    onClicked: { addListener() {} },
  },
  permissions: {
    contains(q, cb) { cb((q.permissions || []).every((p) => grantedPermissions.has(p))); },
    request(q, cb) { cb(false); },
  },

  action: {
    setBadgeText(args) { badgeCalls.push({ call: 'setBadgeText', ...args }); },
    setBadgeBackgroundColor(args) { badgeCalls.push({ call: 'setBadgeBackgroundColor', ...args }); },
    setTitle(args) { badgeCalls.push({ call: 'setTitle', ...args }); },
  },
};

// Registers the real worker listener. Import once per process — the ES module
// cache means a second call would not re-run worker.js.
export async function installWorker() {
  globalThis.chrome = chrome;
  await import('../background/worker.js');
  return { chrome, fake };
}
