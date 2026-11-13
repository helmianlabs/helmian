// A stand-in for the pieces of the chrome.* API this extension uses.
//
// It is deliberately thin, and it routes messages to the REAL service worker
// listener in background/worker.js. So a test that sends a message from the
// content script exercises worker.js, scan.js and the copied kernel, not a
// pretend version of them.

const badgeCalls = [];
const listeners = [];
const storageData = new Map();

export const fake = {
  // 'normal'  answer messages the way Chrome does
  // 'silent'  never answer, so the content script's timeout fires
  // 'missing' answer with no listener, the way a dead service worker looks
  mode: 'normal',
  badgeCalls,
  listeners,
  reset() {
    badgeCalls.length = 0;
    fake.mode = 'normal';
    storageData.clear();
  },
};

export const chrome = {
  runtime: {
    lastError: undefined,

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

        const sender = { tab: { id: 7 } };
        let answered = false;
        let keepOpen = false;
        const sendResponse = (response) => {
          if (answered) return;
          answered = true;
          if (!callback) return;
          chrome.runtime.lastError = undefined;
          callback(response);
        };

        listeners.forEach((listener) => {
          // Chrome's contract: a listener that returns true will answer
          // asynchronously, and the channel stays open for it. Deciding an
          // approval (helmion:decide) is exactly that shape, so the
          // no-listener error below must not fire the moment the listener
          // returns, before its promise settles.
          if (listener(message, sender, sendResponse) === true) keepOpen = true;
        });

        if (!answered && !keepOpen && callback) {
          chrome.runtime.lastError = { message: 'no listener answered' };
          callback(undefined);
          chrome.runtime.lastError = undefined;
        }
      }, 0);
    },
  },

  // The worker's ledger and settings live in chrome.storage.local, and the
  // decide path reads them on every call. Without this the real worker
  // answers helmion:decide with an error, and no send-time decision can be
  // exercised end to end. In-memory, promise-shaped like the real API, and
  // cleared by fake.reset() so tests stay isolated.
  storage: {
    local: {
      async get(key) {
        if (key == null) return Object.fromEntries(storageData);
        if (typeof key === 'string') {
          return storageData.has(key) ? { [key]: storageData.get(key) } : {};
        }
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (storageData.has(k)) out[k] = storageData.get(k);
          return out;
        }
        const out = {};
        for (const [k, fallback] of Object.entries(key)) {
          out[k] = storageData.has(k) ? storageData.get(k) : fallback;
        }
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) storageData.set(k, v);
      },
      async remove(key) {
        for (const k of [].concat(key)) storageData.delete(k);
      },
    },
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
