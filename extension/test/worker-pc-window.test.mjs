// The approvals window's worker side (approvals pop-up build, Bite 5).
//
// The pop-up section (Bite 3) and the knock (Bite 4) have their own
// suites. This one loads the REAL service worker against a fake chrome
// that has a small windows world, and proves the window contract only:
// opening is single-instance (a standing window is focused, never
// duplicated), a closed window is forgotten and the next open creates
// afresh, a window the worker forgot (its service worker was evicted
// while the window stood) is found again by scan, the knock's click
// lands here, and the message gate admits the window page for exactly
// its two messages (view and decide) while still refusing it, the
// pop-up page in a tab, and every web page for everything else.
//
// What it does NOT prove: a real browser. chrome.windows.create opening
// the real page as a popup window in Chromium, and the page rendering
// the real proxy's signed-out answer, is this bite's load proof,
// recorded in its report; a decision made in the window on Troy's own
// machine remains open there by name.

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Fake chrome.* ─────────────────────────────────────────────────────────
// Promise-style storage.local over a Map, badge calls captured, a
// windows world (create/get/getAll/update over a Map, onRemoved a test
// can fire), notifications and permissions for the knock's click.
const EXT_ID = 'fakeextid';
const store = new Map();
const badgeCalls = [];
const alarmsCreated = new Map();
const alarmListeners = [];
const messageListeners = [];
const startupListeners = [];
const installedListeners = [];
const notificationsCleared = [];
const notificationClickListeners = [];
const tabsCreated = [];
const windowsCreated = [];
const windowsUpdates = [];
const windowsOpen = new Map();
const windowRemovedListeners = [];
let nextWindowId = 100;

const WINDOW_URL = `chrome-extension://${EXT_ID}/popup/approvals-window.html`;

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
    create: () => {},
    clear: (id) => notificationsCleared.push(id),
    onClicked: { addListener: (fn) => notificationClickListeners.push(fn) },
  },
  permissions: {
    contains: (_ask, callback) => { if (callback) callback(true); },
  },
  tabs: {
    create: (args) => tabsCreated.push(args),
  },
  windows: {
    create: (data, callback) => {
      const win = { id: nextWindowId++, tabs: [{ url: data.url }] };
      windowsCreated.push(data);
      windowsOpen.set(win.id, win);
      if (callback) callback(win);
    },
    get: (id, callback) => { if (callback) callback(windowsOpen.get(id)); },
    getAll: (_opts, callback) => { if (callback) callback([...windowsOpen.values()]); },
    update: (id, info, callback) => {
      windowsUpdates.push({ id, info });
      if (callback) callback(windowsOpen.get(id) || {});
    },
    onRemoved: { addListener: (fn) => windowRemovedListeners.push(fn) },
  },
};
globalThis.chrome = chrome;

// ─── Scripted fetch: the Helmian proxy only ────────────────────────────────
const fetchLog = [];
let pcList = [];
let pcListStatus = 200;

function textResponse(status, body) {
  return { status, text: async () => body };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchLog.push({ url: u, method: init.method || 'GET', body: init.body || null });
  if (u.startsWith('https://helmian.cloud/api/admin/guard/pc-approvals/decide')) {
    const { approvalId } = JSON.parse(init.body);
    pcList = pcList.filter((item) => item.approvalId !== approvalId);
    return textResponse(200, JSON.stringify({ approval: { approvalId } }));
  }
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

const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` };
const WINDOW_SENDER = { id: EXT_ID, tab: { id: 9 }, url: WINDOW_URL };
const POPUP_TAB_SENDER = { id: EXT_ID, tab: { id: 4 }, url: `chrome-extension://${EXT_ID}/popup/popup.html` };
const WEB_TAB_SENDER = { id: EXT_ID, tab: { id: 3 }, url: 'https://claude.ai/chat' };

function resetWorld() {
  store.clear();
  badgeCalls.length = 0;
  fetchLog.length = 0;
  notificationsCleared.length = 0;
  tabsCreated.length = 0;
  windowsCreated.length = 0;
  windowsUpdates.length = 0;
  windowsOpen.clear();
  pcList = [];
  pcListStatus = 200;
}

function sendFrom(sender, message) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (response) => { if (!settled) { settled = true; resolve(response); } };
    for (const fn of messageListeners) fn(message, sender, sendResponse);
    setTimeout(() => { if (!settled) resolve(undefined); }, 3000);
  });
}

function closeWindow(id) {
  windowsOpen.delete(id);
  for (const fn of windowRemovedListeners) fn(id);
}

function fireNotificationClick(id) {
  for (const fn of notificationClickListeners) fn(id);
}

function rawItem(id, summary) {
  return {
    approvalId: id, status: 'pending', summary, reason: 'test', tool: 'hands',
    site: 'pc', createdAt: '2026-11-12T00:00:00.000Z', expiresAt: '2026-11-13T00:00:00.000Z',
  };
}

// ─── Open and focus ────────────────────────────────────────────────────────
// These four run in order against the worker's tracked window id, the
// way a sitting would: find, create, focus, forget.

test('a window already standing is found by scan and focused, never duplicated', async () => {
  resetWorld();
  // A window the worker has never tracked: its service worker was
  // evicted while the window stood open. The page showing in it is
  // what identifies it.
  windowsOpen.set(555, { id: 555, tabs: [{ url: WINDOW_URL }] });
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, true);
  assert.equal(windowsCreated.length, 0, 'no second window was created');
  assert.deepEqual(windowsUpdates, [{ id: 555, info: { focused: true } }]);
  closeWindow(555);
});

test('the open message creates the window once: popup type, the planned size, the window page', async () => {
  resetWorld();
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, true);
  assert.equal(res.opened, true);
  assert.equal(windowsCreated.length, 1);
  assert.deepEqual(windowsCreated[0], {
    url: WINDOW_URL, type: 'popup', width: 420, height: 560,
  });
});

test('a second open focuses the standing window instead of stacking another', async () => {
  // The window from the previous test still stands and is tracked.
  const createsBefore = windowsCreated.length;
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, true);
  assert.equal(windowsCreated.length, createsBefore, 'no new window was created');
  assert.equal(windowsUpdates.length, 1);
  assert.equal(windowsUpdates[0].info.focused, true);
});

test('closing the window forgets it; the next open creates afresh', async () => {
  const standing = [...windowsOpen.keys()];
  assert.equal(standing.length, 1);
  closeWindow(standing[0]);
  const createsBefore = windowsCreated.length;
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, true);
  assert.equal(windowsCreated.length, createsBefore + 1, 'a fresh window was created after the close');
  closeWindow([...windowsOpen.keys()][0]);
});

// ─── The knock's click lands here ──────────────────────────────────────────

test('clicking the knock opens the approvals window and clears the knock', async () => {
  resetWorld();
  fireNotificationClick(KNOCK_ID);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(windowsCreated.length, 1);
  assert.equal(windowsCreated[0].url, WINDOW_URL);
  assert.equal(tabsCreated.length, 0, 'no tab is opened any more');
  assert.deepEqual(notificationsCleared, [KNOCK_ID]);
  closeWindow([...windowsOpen.keys()][0]);
});

// ─── The gate, for the window page ─────────────────────────────────────────

test('the window page can read the PC approvals view', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'Paint the fence')];
  const res = await sendFrom(WINDOW_SENDER, { type: 'helmion:pc-approvals-view', options: { force: true } });
  assert.equal(res.ok, true);
  assert.equal(res.view.state, 'list');
  assert.equal(res.view.items[0].summary, 'Paint the fence');
});

test('the window page can decide, and exactly one decision is posted', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  fetchLog.length = 0;
  const res = await sendFrom(WINDOW_SENDER, { type: 'helmion:pc-approvals-decide', id: 'a1', verdict: 'deny' });
  assert.equal(res.ok, true);
  const posts = fetchLog.filter((f) => f.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { approvalId: 'a1', approve: false });
  assert.equal((await getPcApprovalsState(storage)).count, 0);
});

test('the window page gets nothing else: other privileged types are refused to it', async () => {
  resetWorld();
  const res = await sendFrom(WINDOW_SENDER, { type: 'helmion:ledger-clear' });
  assert.equal(res.ok, false);
  assert.match(res.error, /extension popup/);
});

test('the window page cannot open windows: the open message is the pop-up own', async () => {
  resetWorld();
  const res = await sendFrom(WINDOW_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, false);
  assert.equal(windowsCreated.length, 0);
});

test('the pop-up page carried in a tab is still refused the PC view', async () => {
  resetWorld();
  const res = await sendFrom(POPUP_TAB_SENDER, { type: 'helmion:pc-approvals-view', options: { force: true } });
  assert.equal(res.ok, false);
  assert.match(res.error, /extension popup/);
});

test('a web page tab is refused the open message and no window appears', async () => {
  resetWorld();
  const res = await sendFrom(WEB_TAB_SENDER, { type: 'helmion:pc-approvals-open-window' });
  assert.equal(res.ok, false);
  assert.equal(windowsCreated.length, 0);
});
