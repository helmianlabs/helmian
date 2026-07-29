// A stand-in for the pieces of the chrome.* API this extension uses.
//
// It is deliberately thin, and it routes messages to the REAL service worker
// listener in background/worker.js. So a test that sends a message from the
// content script exercises worker.js, scan.js and the copied kernel, not a
// pretend version of them.

const badgeCalls = [];
const listeners = [];

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
        const sendResponse = (response) => {
          answered = true;
          if (!callback) return;
          chrome.runtime.lastError = undefined;
          callback(response);
        };

        listeners.forEach((listener) => listener(message, sender, sendResponse));

        if (!answered && callback) {
          chrome.runtime.lastError = { message: 'no listener answered' };
          callback(undefined);
          chrome.runtime.lastError = undefined;
        }
      }, 0);
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
