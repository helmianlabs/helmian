// The toolbar pop-up's PC approvals section (approvals pop-up build,
// Bite 3).
//
// These tests load the REAL popup/popup.js into a vm sandbox (the house
// pattern from test-support/load-content-script.mjs) against a small fake
// document built from the REAL popup.html's own ids, and a fake
// chrome.runtime whose answers are scripted per scenario. They prove the
// section's rendering and tap behaviour only: rows from a view state, one
// decide message per tap, the item leaving only when the refreshed view
// drops it, and the plain states (signed out, not the owner, stale,
// worker silent) rendering their lines instead of an empty list.
//
// What they do NOT prove: a real browser, a real worker, or the live
// proxy. The worker side of these messages is covered by
// worker-pc-approvals.test.mjs; the section in a real Chromium against
// the real proxy is this bite's load proof, recorded in its report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadContentScripts, EXTENSION_ROOT } from '../test-support/load-content-script.mjs';

// ─── Fake DOM ──────────────────────────────────────────────────────────────
// Just what popup.js touches: an id registry, createElement, children,
// textContent, and click listeners. Elements are plain objects; text set
// through textContent replaces children, as in a real document.
class FakeElement {
  constructor(tagName, id = '') {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.placeholder = '';
    this._text = '';
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
  }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new FakeElement('#text');
        text._text = node;
        this.appendChild(text);
      } else this.appendChild(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = '';
    this.append(...nodes);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  click() {
    const handlers = this.listeners.get('click') || [];
    for (const fn of handlers) fn({});
  }

  * descendants() {
    for (const child of this.childNodes) {
      yield child;
      yield* child.descendants();
    }
  }

  buttons() {
    return [...this.descendants()].filter((node) => node.tagName === 'BUTTON');
  }
}

async function fakeDocument() {
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');
  const byId = new Map();
  // One element per id in the real page; the two boolean attributes the
  // page declares (hidden, disabled) seed the element, as a browser does.
  for (const match of html.matchAll(/<([a-z]+)([^>]*)>/g)) {
    const idMatch = /\bid="([^"]+)"/.exec(match[2]);
    if (!idMatch) continue;
    const el = new FakeElement(match[1], idMatch[1]);
    if (/\bhidden\b/.test(match[2])) el.hidden = true;
    if (/\bdisabled\b/.test(match[2])) el.disabled = true;
    byId.set(idMatch[1], el);
  }
  return {
    byId,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
  };
}

// ─── Scripted world ────────────────────────────────────────────────────────
// Every message popup.js sends at load gets a benign answer; the PC view
// and decide answers are the scenario under test. All messages are
// recorded, so a test can count exactly what a tap sent.
const BENIGN = {
  'helmion:guard-status': { ok: true, status: { protection: 'active', claims: 'active' } },
  'helmion:ledger-stats': {
    ok: true,
    stats: { total: 0, destructive: 0, unsourced: 0, flags: 0, oldest: null, newest: null, sites: [], limit: 1000 },
  },
  'helmion:ledger': { ok: true, entries: [] },
  'helmion:guard-upload-settings': { ok: true, settings: { enabled: false, hasToken: false } },
  'helmion:executive-settings': { ok: true, settings: { enabled: false, paired: false } },
  'helmion:flags-settings': {
    ok: true,
    settings: {
      enabled: false, baseUrl: '', scanBeforeSend: false, dailyBudget: 100,
      callsToday: 0, hasKey: false, queued: 0,
    },
  },
  'helmion:approvals-view': {
    ok: true, view: { session: 'out', state: 'signed-out', items: [], count: 0, lastError: '' },
  },
  'helmion:scribe-settings': {
    ok: true,
    settings: {
      enabled: false, baseUrl: '', mailboxes: [], includeLegacy: false, notify: false,
      showBadge: false, unreadPath: '/mailbox/unread', signedIn: false, hasToken: false,
    },
  },
  'helmion:scribe-inbox': { ok: true, unread: 0, mailboxes: [] },
  'helmion:nudge-settings': {
    ok: true,
    settings: { enabled: false, killed: false, sites: {}, idleMinutes: 3, dailyCapPerSite: 20 },
    log: [],
  },
};

async function loadPopup({ pcView, onDecide } = {}) {
  const document = await fakeDocument();
  const messages = [];
  const tabsCreated = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(message);
        let response;
        if (message.type === 'helmion:pc-approvals-view') response = { ok: true, view: pcView };
        else if (message.type === 'helmion:pc-approvals-decide') {
          response = onDecide ? onDecide(message) : { ok: true, view: pcView };
        } else response = BENIGN[message.type] || { ok: false, error: `unscripted: ${message.type}` };
        setTimeout(() => callback(response), 0);
      },
    },
    tabs: { create: (args) => tabsCreated.push(args) },
    permissions: {
      request: (_ask, callback) => { if (callback) callback(false); return Promise.resolve(false); },
    },
  };
  await loadContentScripts(['popup/popup.js'], { document, chrome, URL, Blob });
  await flush();
  return { document, messages, tabsCreated };
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function item(id, summary, extra = {}) {
  return {
    id, summary, tool: 'hands', site: 'this PC', reason: '',
    createdAt: '2026-11-12T17:00:00.000Z', expiresAt: null, ...extra,
  };
}

function listView(items) {
  return {
    state: 'list', session: 'in', items, count: items.length,
    lastError: '', stale: false, updatedAt: Date.now(),
  };
}

function rows(document) {
  return document.byId.get('pcApprovalsList').childNodes;
}

function status(document) {
  return document.byId.get('pcApprovalsStatus').textContent;
}

// ─── Rendering ─────────────────────────────────────────────────────────────

test('the section renders a row per waiting approval, with who is asking and the time left', async () => {
  const expires = new Date(Date.now() + (2 * 60 + 14) * 60000).toISOString();
  const view = listView([
    item('a1', 'Delete the old build folder', { expiresAt: expires }),
    item('b2', 'Send the log file', { tool: 'scribe', site: 'door' }),
  ]);
  const { document, messages } = await loadPopup({ pcView: view });

  const viewAsks = messages.filter((m) => m.type === 'helmion:pc-approvals-view');
  assert.equal(viewAsks.length, 1, 'opening the pop-up asks the worker for the PC view once');
  assert.equal(viewAsks[0].options.force, false);

  const rendered = rows(document);
  assert.equal(rendered.length, 2);
  const first = rendered[0].textContent;
  assert.match(first, /Delete the old build folder/);
  assert.match(first, /hands/);
  assert.match(first, /this PC/);
  assert.match(first, /expires in 2h 14m/);
  assert.deepEqual(rendered[0].buttons().map((b) => b.textContent), ['Approve', 'Deny']);
  assert.equal(status(document), '2 waiting for your decision.');
});

test('an empty list reads as nothing waiting, not as a blank section', async () => {
  const { document } = await loadPopup({ pcView: listView([]) });
  assert.equal(rows(document).length, 0);
  assert.equal(status(document), 'Nothing is waiting for a decision.');
});

// ─── Deciding ──────────────────────────────────────────────────────────────

test('an approve tap sends exactly one decide message, and the row leaves when the refreshed view drops it', async () => {
  const a = item('a1', 'Delete the old build folder');
  const b = item('b2', 'Send the log file');
  const { document, messages } = await loadPopup({
    pcView: listView([a, b]),
    onDecide: () => ({ ok: true, view: listView([b]) }),
  });

  rows(document)[0].buttons()[0].click();
  await flush();

  const decides = messages.filter((m) => m.type === 'helmion:pc-approvals-decide');
  assert.equal(decides.length, 1, 'one tap sends exactly one decision');
  assert.equal(decides[0].id, 'a1');
  assert.equal(decides[0].verdict, 'approve');
  assert.equal(rows(document).length, 1);
  assert.match(rows(document)[0].textContent, /Send the log file/);
  assert.equal(status(document), '1 waiting for your decision.');
});

test('a failed decide shows one plain line and leaves the item waiting', async () => {
  const a = item('a1', 'Delete the old build folder');
  const b = item('b2', 'Send the log file');
  const line = 'That decision could not be confirmed. The request is still waiting.';
  const { document, messages } = await loadPopup({
    pcView: listView([a, b]),
    onDecide: () => ({ ok: false, error: line, view: listView([a, b]) }),
  });

  rows(document)[1].buttons()[1].click();
  await flush();

  const decides = messages.filter((m) => m.type === 'helmion:pc-approvals-decide');
  assert.equal(decides.length, 1);
  assert.equal(decides[0].id, 'b2');
  assert.equal(decides[0].verdict, 'deny');
  assert.equal(rows(document).length, 2, 'the item is still on the list');
  assert.equal(status(document), line);
});

// ─── The plain states ──────────────────────────────────────────────────────

test('the signed-out state shows the sign-in line and the sign-in button, never an empty list', async () => {
  const view = {
    state: 'signed-out', session: 'out', items: [], count: 0,
    lastError: 'Please sign in to Helmian.', stale: false, updatedAt: 0,
  };
  const { document, tabsCreated } = await loadPopup({ pcView: view });

  assert.equal(status(document), 'Please sign in to Helmian.');
  assert.equal(rows(document).length, 0);
  const signIn = document.byId.get('pcSignInBtn');
  assert.equal(signIn.hidden, false, 'the sign-in button shows in the signed-out state');
  assert.equal(document.byId.get('pcWindowBtn').disabled, true);

  signIn.click();
  assert.equal(tabsCreated.length, 1);
  assert.equal(tabsCreated[0].url, 'https://helmian.cloud/app#approvals');
});

test('the not-owner state shows the owner line in the web page words', async () => {
  const view = {
    state: 'not-owner', session: 'in', items: [], count: 0,
    lastError: "PC actions are approved by the PC owner's account.", stale: false, updatedAt: 0,
  };
  const { document } = await loadPopup({ pcView: view });

  assert.equal(status(document), "PC actions are approved by the PC owner's account.");
  assert.equal(rows(document).length, 0);
  assert.equal(document.byId.get('pcSignInBtn').hidden, true);
});

test('a stale list is labelled with its own time and still shows its rows', async () => {
  const view = {
    state: 'unavailable', session: 'in', items: [item('a1', 'Delete the old build folder')],
    count: 1, lastError: 'Helmian could not be reached.', stale: true,
    updatedAt: Date.parse('2026-11-12T16:12:00.000Z'),
  };
  const { document } = await loadPopup({ pcView: view });

  assert.equal(rows(document).length, 1, 'the last known list still renders');
  assert.match(status(document), /^Showing the last list from .+\. Helmian could not be reached\.$/);
});

test('a worker that does not answer renders one plain failure line, not an empty list', async () => {
  const document = await fakeDocument();
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        const response = message.type === 'helmion:pc-approvals-view'
          ? undefined
          : BENIGN[message.type] || { ok: false, error: `unscripted: ${message.type}` };
        setTimeout(() => callback(response), 0);
      },
    },
    tabs: { create: () => {} },
    permissions: { request: (_ask, cb) => { if (cb) cb(false); return Promise.resolve(false); } },
  };
  await loadContentScripts(['popup/popup.js'], { document, chrome, URL, Blob });
  await flush();

  assert.equal(status(document), 'the background worker did not answer');
  assert.equal(rows(document).length, 0);
  assert.equal(document.byId.get('pcSignInBtn').hidden, true);
});

// ─── The page itself ───────────────────────────────────────────────────────

test('the pop-up page carries both sections, PC first, each labelled as its own list', async () => {
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');

  for (const id of ['pcApprovals', 'pcApprovalsStatus', 'pcApprovalsList', 'pcSignInBtn', 'pcWindowBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `popup.html is missing #${id}`);
  }
  assert.match(html, /<h2>PC approvals<\/h2>/);
  assert.match(html, /<h2>Approvals through Scribe<\/h2>/,
    'the Scribe door section is labelled as the Scribe list, not just "Approvals"');
  assert.ok(
    html.indexOf('id="pcApprovals"') < html.indexOf('id="approvals"'),
    'the PC approvals section sits above the Scribe section',
  );
  assert.match(html, /<button id="pcWindowBtn"[^>]*disabled/,
    'the approvals window button is present but disabled until the window piece is built');
  assert.match(html, /approvals window is not built yet/i,
    'a plain note says the window is not built yet, so the disabled button does not pretend');
});
