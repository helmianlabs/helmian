// The worker wiring for PC approvals (approvals pop-up build, Bite 2).
//
// The PC approvals client has its own suite (pc-approvals-client.test.mjs).
// This one loads the REAL service worker (background/worker.js) against a
// fake chrome.* with storage, alarms and a popup-shaped message sender,
// and a scripted global fetch standing in for the two servers. It proves
// the wiring only: the alarm drives the poll, the badge arbiter paints in
// its fixed priority, and the two new messages answer from state and route
// a decision exactly once, from the extension's own pages only.
//
// What it does NOT prove: a real browser. The extension loaded in Chromium
// against the live proxy is the load proof recorded in this bite's report;
// a signed-in badge round (raise, light, decide, clear) needs Troy's
// session and is named there as still open.

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Fake chrome.* ─────────────────────────────────────────────────────────
// Promise-style storage.local over a Map, an alarm registry that records
// creates and lets a test fire an alarm, and badge calls captured in
// order. notifications / permissions / idle / tabs are deliberately
// absent: the worker guards each of them, and the paths exercised here
// never reach for them.
const EXT_ID = 'fakeextid';
const store = new Map();
const badgeCalls = [];
const alarmsCreated = new Map();
const alarmListeners = [];
const messageListeners = [];
const startupListeners = [];
const installedListeners = [];

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
};
globalThis.chrome = chrome;

// ─── Scripted fetch ────────────────────────────────────────────────────────
// Routes by URL: the Helmian proxy (list + decide) and the Scribe door
// (one HTML page). Anything else throws, so a wiring change that starts
// calling somewhere new fails loudly here instead of silently passing.
const fetchLog = [];
let pcList = [];
let pcListStatus = 200;
let doorPage = '<p class="empty">Nothing waiting.</p>';

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
  if (u.includes('connect.helmian.cloud')) return textResponse(200, doorPage);
  throw new Error(`unscripted fetch: ${u}`);
};

// The worker and the clients it drives, loaded only after the globals
// above exist (the worker registers its listeners at import).
const worker = await import('../background/worker.js');
const { chromeStorage } = await import('../background/ledger.js');
const {
  PC_APPROVALS_ALARM, PC_APPROVALS_STATE_KEY, getPcApprovalsState,
} = await import('../background/pc-approvals-client.js');
const {
  APPROVALS_ALARM, APPROVALS_STATE_KEY, getApprovalsState,
} = await import('../background/approvals-client.js');
const { SCRIBE_SETTINGS_KEY, SCRIBE_STATE_KEY } = await import('../background/scribe-client.js');

const storage = chromeStorage();

const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` };
const TAB_SENDER = { id: EXT_ID, tab: { id: 3 }, url: 'https://claude.ai/chat' };

function resetWorld() {
  store.clear();
  badgeCalls.length = 0;
  fetchLog.length = 0;
  pcList = [];
  pcListStatus = 200;
  doorPage = '<p class="empty">Nothing waiting.</p>';
}

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function globalBadgeTexts() {
  return badgeCalls.filter((c) => c.call === 'setBadgeText' && typeof c.tabId !== 'number');
}
function lastGlobalBadgeText() {
  const texts = globalBadgeTexts();
  return texts.length ? texts[texts.length - 1].text : undefined;
}
function lastGlobalBadgeColor() {
  const colors = badgeCalls.filter((c) => c.call === 'setBadgeBackgroundColor' && typeof c.tabId !== 'number');
  return colors.length ? colors[colors.length - 1].color : undefined;
}

function sendFrom(sender, message) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (response) => { if (!settled) { settled = true; resolve(response); } };
    for (const fn of messageListeners) fn(message, sender, sendResponse);
    setTimeout(() => { if (!settled) resolve(undefined); }, 3000);
  });
}

function fireAlarm(name) {
  for (const fn of alarmListeners) fn({ name });
}

function rawItem(id, summary) {
  return {
    approvalId: id, status: 'pending', summary, reason: 'test', tool: 'hands',
    site: 'pc', createdAt: '2026-11-12T00:00:00.000Z', expiresAt: '2026-11-13T00:00:00.000Z',
  };
}

async function seedDoor(count) {
  const items = Array.from({ length: count }, (_, i) => ({ id: `d${i}`, summary: 'Door', meta: '', csrf: 'x' }));
  await storage.set(APPROVALS_STATE_KEY, {
    doorUrl: 'https://connect.helmian.cloud', session: 'in', items, count,
    flash: '', lastError: '', updatedAt: 0, nextAt: Date.now() + 3600_000, errors: 0, badgeOwned: false,
  });
}

// ─── The alarm ─────────────────────────────────────────────────────────────

test('install registers the PC approvals alarm at the one-minute cadence', async () => {
  resetWorld();
  alarmsCreated.clear();
  for (const fn of installedListeners) await fn();
  const info = alarmsCreated.get(PC_APPROVALS_ALARM);
  assert.ok(info, 'the PC approvals alarm was created');
  assert.equal(info.periodInMinutes, 1);
  // The install listener does not await its sync functions; let their
  // badge repaints drain here so they cannot land inside the next test.
  await waitFor(() => globalBadgeTexts().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('the PC alarm drives the PC poll: state fills and the badge lights', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First'), rawItem('a2', 'Second')];
  fireAlarm(PC_APPROVALS_ALARM);
  await waitFor(async () => (await getPcApprovalsState(storage)).count === 2);
  await waitFor(() => lastGlobalBadgeText() === '2');
  assert.ok(fetchLog.some((f) => f.url.startsWith('https://helmian.cloud/api/admin/guard/pc-approvals') && f.method === 'GET'));
});

test('the door alarm still drives the door poll alongside the PC poll', async () => {
  resetWorld();
  await storage.set(APPROVALS_STATE_KEY, {
    doorUrl: 'https://connect.helmian.cloud', session: 'in', items: [], count: 0,
    flash: '', lastError: '', updatedAt: 0, nextAt: 0, errors: 0, badgeOwned: false,
  });
  doorPage = '<div class="req"><form method="POST" action="/approvals/d1/decide">'
    + '<input type="hidden" name="csrf" value="tok" />'
    + '<div class="sum">Door request</div><div class="meta">Device</div></form></div>';
  fireAlarm(APPROVALS_ALARM);
  await waitFor(async () => (await getApprovalsState(storage)).count === 1);
  await waitFor(() => lastGlobalBadgeText() === '1');
});

// ─── The badge arbiter ─────────────────────────────────────────────────────

test('arbiter: PC approvals waiting outrank the door count', async () => {
  resetWorld();
  await seedDoor(3);
  pcList = [rawItem('a1', 'First'), rawItem('a2', 'Second')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '2');
  const titles = badgeCalls.filter((c) => c.call === 'setTitle');
  assert.match(titles[titles.length - 1].title, /PC approval/);
  // The badge is showing the PC count, so the door flag must read false.
  assert.equal((await getApprovalsState(storage)).badgeOwned, false);
});

test('arbiter: with no PC approvals waiting, the door count shows under its flag', async () => {
  resetWorld();
  await seedDoor(3);
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '3');
  assert.equal((await getApprovalsState(storage)).badgeOwned, true);
});

test('arbiter: unread mail is the fallback, and only when its switch is on', async () => {
  resetWorld();
  await storage.set(SCRIBE_SETTINGS_KEY, { showBadge: true });
  await storage.set(SCRIBE_STATE_KEY, { unread: 4, boxes: {} });
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '4');
  assert.equal(lastGlobalBadgeColor(), '#2e6b3a');

  resetWorld();
  await storage.set(SCRIBE_SETTINGS_KEY, { showBadge: false });
  await storage.set(SCRIBE_STATE_KEY, { unread: 4, boxes: {} });
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '');
});

test('arbiter: zero everywhere clears the badge', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '1');
  pcList = [];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '');
});

test('arbiter: a signed-out PC poll contributes zero and the door count shows', async () => {
  resetWorld();
  await seedDoor(1);
  pcListStatus = 401;
  const result = await worker.runPcApprovalsPoll({ force: true });
  assert.equal(result.session, 'out');
  assert.equal((await getPcApprovalsState(storage)).session, 'out');
  assert.equal(lastGlobalBadgeText(), '1');
});

// ─── The messages ──────────────────────────────────────────────────────────

test('pc-approvals-view answers from state for the extension popup', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'Paint the fence')];
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-view', options: { force: true } });
  assert.equal(res.ok, true);
  assert.equal(res.view.state, 'list');
  assert.equal(res.view.count, 1);
  assert.equal(res.view.items[0].id, 'a1');
  assert.equal(res.view.items[0].summary, 'Paint the fence');
});

test('pc-approvals-view is refused from a web page tab', async () => {
  resetWorld();
  const res = await sendFrom(TAB_SENDER, { type: 'helmion:pc-approvals-view', options: { force: true } });
  assert.equal(res.ok, false);
  assert.match(res.error, /extension popup/);
});

test('pc-approvals-decide posts exactly one decision and the badge clears', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  assert.equal(lastGlobalBadgeText(), '1');
  fetchLog.length = 0;
  const res = await sendFrom(POPUP_SENDER, { type: 'helmion:pc-approvals-decide', id: 'a1', verdict: 'approve' });
  assert.equal(res.ok, true);
  const posts = fetchLog.filter((f) => f.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/api/admin/guard/pc-approvals/decide'));
  assert.deepEqual(JSON.parse(posts[0].body), { approvalId: 'a1', approve: true });
  assert.equal((await getPcApprovalsState(storage)).count, 0);
  assert.equal(lastGlobalBadgeText(), '');
});

test('pc-approvals-decide is refused from a web page tab and sends nothing', async () => {
  resetWorld();
  pcList = [rawItem('a1', 'First')];
  await worker.runPcApprovalsPoll({ force: true });
  fetchLog.length = 0;
  const res = await sendFrom(TAB_SENDER, { type: 'helmion:pc-approvals-decide', id: 'a1', verdict: 'approve' });
  assert.equal(res.ok, false);
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 0);
  assert.equal((await getPcApprovalsState(storage)).count, 1);
});

// Keep the storage key referenced so a rename in the client breaks here,
// not silently in production.
test('the state keys the worker paints from are the clients own keys', () => {
  assert.equal(PC_APPROVALS_STATE_KEY, 'helmion.pc-approvals.state');
  assert.equal(APPROVALS_STATE_KEY, 'helmion.approvals.state');
});
