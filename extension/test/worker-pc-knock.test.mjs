// The PC approvals knock (approvals pop-up build, Bite 4).
//
// Bite 2's suite (worker-pc-approvals.test.mjs) proves the poll, the
// badge and the messages with notifications and permissions deliberately
// absent from its fake chrome. This suite loads the same REAL worker
// against a fake chrome that HAS notifications, permissions and tabs,
// and proves the knock only: a rise in the waiting count from zero
// raises exactly one plain notification, a further arrival does not,
// a fall back to zero re-arms it, a missing permission means silence
// and no breakage, and clicking the knock opens the Helmian approvals
// page in a tab (the interim click target; Bite 5 re-points it at the
// approvals window).
//
// What it does NOT prove: a notification on a real screen. The
// extension loaded in Chromium, with the chrome.notifications.create
// call captured in the real browser, is this bite's load proof,
// recorded in its report; a knock seen by Troy needs his own machine
// and his install.

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Fake chrome.* ─────────────────────────────────────────────────────────
// Promise-style storage.local over a Map, badge calls captured in order,
// notifications created/cleared captured, notification click listeners
// registered so a test can fire a click, and a permissions.contains
// whose answer the scenario sets.
const EXT_ID = 'fakeextid';
const store = new Map();
const badgeCalls = [];
const alarmsCreated = new Map();
const alarmListeners = [];
const messageListeners = [];
const startupListeners = [];
const installedListeners = [];
const notificationsCreated = [];
const notificationsCleared = [];
const notificationClickListeners = [];
const tabsCreated = [];
let notificationsPermission = true;

const chrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
    getManifest: () => ({ version: '0.7.0' }),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onStartup: { addListener: (fn) => startupListeners.push(fn) },
    onInstalled: { addListener: (fn) => installedListeners.push(fn) },
  },
  storage: {
    local: {
      async get(key) {
        if (key == null) return Object.fromEntries(store);
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      async remove(key) { store.delete(key); },
    },
  },
  alarms: {
    create: (name, info) => alarmsCreated.set(name, info),
    clear: (name) => alarmsCreated.delete(name),
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
  },
  action: {
    setBadgeText: (args) => badgeCalls.push({ call: 'setBadgeText', ...args }),
    setBadgeBackgroundColor: (args) => badgeCalls.push({ call: 'setBadgeBackgroundColor', ...args }),
    setTitle: (args) => badgeCalls.push({ call: 'setTitle', ...args }),
  },
  notifications: {
    create: (id, options) => notificationsCreated.push({ id, ...options }),
    clear: (id) => notificationsCleared.push(id),
    onClicked: { addListener: (fn) => notificationClickListeners.push(fn) },
  },
  permissions: {
    contains: (_ask, callback) => { if (callback) callback(notificationsPermission); },
  },
  tabs: {
    create: (args) => tabsCreated.push(args),
  },
};
globalThis.chrome = chrome;

// ─── Scripted fetch ────────────────────────────────────────────────────────
// The Helmian proxy list only. Anything else throws, so a wiring change
// that starts calling somewhere new fails loudly here.
const fetchLog = [];
let pcList = [];
let pcListStatus = 200;

function textResponse(status, body) {
  return { status, text: async () => body };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchLog.push({ url: u, method: init.method || 'GET', body: init.body || null });
  if (u.startsWith('https://helmian.cloud/api/admin/guard/pc-approvals')) {
    if (pcListStatus !== 200) return textResponse(pcListStatus, '');
    return textResponse(200, JSON.stringify({ approvals: pcList }));
  }
  throw new Error(`unscripted fetch: ${u}`);
};

const worker = await import('../background/worker.js');
const { chromeStorage } = await import('../background/ledger.js');
const { getPcApprovalsState } = await import('../background/pc-approvals-client.js');

const storage = chromeStorage();
const KNOCK_ID = worker.PC_KNOCK_ID;

function resetWorld() {
  store.clear();
  badgeCalls.length = 0;
  fetchLog.length = 0;
  notificationsCreated.length = 0;
  notificationsCleared.length = 0;
  tabsCreated.length = 0;
  pcList = [];
  pcListStatus = 200;
  notificationsPermission = true;
}

function rawItem(id, summary) {
  return {
    approvalId: id, status: 'pending', summary, reason: 'test', tool: 'hands',
    site: 'pc', createdAt: '2026-11-12T00:00:00.000Z', expiresAt: '2026-11-13T00:00:00.000Z',
  };
}

function lastGlobalBadgeText() {
  const texts = badgeCalls.filter((c) => c.call === 'setBadgeText' && typeof c.tabId !== 'number');
  return texts.length ? texts[texts.length - 1].text : undefined;
}

function fireNotificationClick(id) {
  for (const fn of notificationClickListeners) fn(id);
}

// ─── The knock ─────────────────────────────────────────────────────────────

test('a rise from zero to one waiting knocks exactly once, in the plan words, with no buttons', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'Delete the old build folder')];
  await worker.runPcApprovalsPoll({ force: true });

  assert.equal(notificationsCreated.length, 1, 'one rise raises one notification');
  const knock = notificationsCreated[0];
  assert.equal(knock.id, KNOCK_ID);
  assert.equal(knock.type, 'basic');
  assert.equal(knock.title, 'Helmian Guard — an action is waiting for your decision');
  assert.equal(knock.message, 'Delete the old build folder', 'the ask itself is the message');
  assert.equal(knock.buttons, undefined, 'the knock carries no buttons: deciding never happens inside it');
});

test('a rise from zero to several waiting knocks once and says how many are waiting', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First'), rawItem('a2', 'Second'), rawItem('a3', 'Third')];
  await worker.runPcApprovalsPoll({ force: true });

  assert.equal(notificationsCreated.length, 1);
  assert.match(notificationsCreated[0].message, /First/);
  assert.match(notificationsCreated[0].message, /3 waiting in all/);
});

test('a further arrival while one is already waiting does not knock again', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(notificationsCreated.length, 1);

  pcList = [rawItem('a1', 'First'), rawItem('a2', 'Second')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal((await getPcApprovalsState(storage)).count, 2);
  assert.equal(notificationsCreated.length, 1, 'the count rose 1 to 2: no second knock');

  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(notificationsCreated.length, 1, 'an unchanged list knocks never');
});

test('a fall back to zero re-arms the knock for the next arrival', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(notificationsCreated.length, 1);

  pcList = [];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal((await getPcApprovalsState(storage)).count, 0);
  assert.equal(notificationsCreated.length, 1, 'the fall itself does not knock');

  pcList = [rawItem('b1', 'A new arrival')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(notificationsCreated.length, 2, 'the next rise from zero knocks again');
  assert.equal(notificationsCreated[1].message, 'A new arrival');
});

test('permission not granted: a rise is silent, and the poll and badge carry on', async () => {
  resetWorld();
  notificationsPermission = false;
  pcList = [rawItem('a1', 'First')];
  const result = await worker.runPcApprovalsPoll({ force: true });

  assert.equal(result.ok, true, 'the poll itself is unaffected');
  assert.equal((await getPcApprovalsState(storage)).count, 1);
  assert.equal(lastGlobalBadgeText(), '1', 'the badge alone carries the news');
  assert.equal(notificationsCreated.length, 0, 'no permission, no notification, no error');
});

test('a signed-out poll never knocks', async () => {
  resetWorld();
  pcListStatus = 401;
  const result = await worker.runPcApprovalsPoll({ force: true });
  assert.equal(result.session, 'out');
  assert.equal(notificationsCreated.length, 0);
});

// ─── The click (interim target) ────────────────────────────────────────────

test('clicking the knock opens the Helmian approvals page in a tab and clears the knock', async () => {
  resetWorld();
  fireNotificationClick(KNOCK_ID);
  assert.deepEqual(tabsCreated, [{ url: 'https://helmian.cloud/app#approvals' }]);
  assert.deepEqual(notificationsCleared, [KNOCK_ID]);
});

test('clicking some other notification does not open the approvals page', async () => {
  resetWorld();
  fireNotificationClick('an-unrelated-notification');
  assert.equal(tabsCreated.length, 0);
  assert.equal(notificationsCleared.length, 0);
});
