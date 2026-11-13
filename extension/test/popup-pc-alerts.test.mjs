// The pop-up's "Turn on alerts" row for the PC approvals knock
// (approvals pop-up build, Bite 4).
//
// The notifications permission is optional in the manifest and is asked
// for only from a click in the pop-up, never at install, never by the
// worker. This suite loads the REAL popup/popup.js into a vm sandbox
// (the house pattern, as in popup-pc-approvals.test.mjs) against a fake
// document built from the REAL popup.html's ids and a fake chrome whose
// permissions answers are scripted per scenario. It proves the row
// only: it shows while the permission is missing, it stays hidden once
// the permission is held, its click sends exactly one
// permissions.request for notifications, and the row leaves when that
// request is granted and stays when it is refused.
//
// What it does NOT prove: the browser's real permission prompt, or a
// notification arriving. The knock itself is covered on the worker side
// by worker-pc-knock.test.mjs; the real-browser level reached is
// recorded in this bite's report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadContentScripts, EXTENSION_ROOT } from '../test-support/load-content-script.mjs';

// ─── Fake DOM ──────────────────────────────────────────────────────────────
// The same small fake as popup-pc-approvals.test.mjs: an id registry
// built from the real page, createElement, children, textContent, and
// click listeners.
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
}

async function fakeDocument() {
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');
  const byId = new Map();
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
// Every message popup.js sends at load gets a benign answer; the PC
// view is an empty list. The permissions API is the scenario under
// test: contains answers what is already held, request answers what
// the prompt would give, and both are recorded.
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
  'helmion:pc-approvals-view': {
    ok: true,
    view: { state: 'list', session: 'in', items: [], count: 0, lastError: '', stale: false, updatedAt: 0 },
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

async function loadPopup({ held = false, grantOnRequest = true } = {}) {
  const document = await fakeDocument();
  const permissionRequests = [];
  const containsAsks = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        const response = BENIGN[message.type] || { ok: false, error: `unscripted: ${message.type}` };
        setTimeout(() => callback(response), 0);
      },
    },
    tabs: { create: () => {} },
    permissions: {
      contains: (ask, callback) => { containsAsks.push(ask); if (callback) callback(held); },
      request: (ask, callback) => {
        permissionRequests.push(ask);
        if (callback) callback(grantOnRequest);
        return Promise.resolve(grantOnRequest);
      },
    },
  };
  await loadContentScripts(['popup/popup.js'], { document, chrome, URL, Blob });
  await flush();
  return { document, permissionRequests, containsAsks };
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function alertsRow(document) {
  return document.byId.get('pcAlertsRow');
}

// ─── The row ───────────────────────────────────────────────────────────────

test('the row shows while the notifications permission is missing', async () => {
  const { document, containsAsks, permissionRequests } = await loadPopup({ held: false });
  assert.equal(alertsRow(document).hidden, false, 'the ask is offered when the permission is not held');
  // The ask objects are built inside the vm sandbox, so they are compared
  // through JSON: deepStrictEqual would reject them on realm alone.
  assert.deepEqual(JSON.parse(JSON.stringify(containsAsks)), [{ permissions: ['notifications'] }],
    'the row decides from the notifications permission, and asks for nothing at load');
  assert.equal(permissionRequests.length, 0, 'nothing is requested at load: the ask rides on the click');
});

test('the row stays hidden once the permission is held', async () => {
  const { document } = await loadPopup({ held: true });
  assert.equal(alertsRow(document).hidden, true);
});

test('clicking Turn on alerts requests the notifications permission once, and the row leaves when granted', async () => {
  const { document, permissionRequests } = await loadPopup({ held: false, grantOnRequest: true });
  document.byId.get('pcAlertsBtn').click();
  await flush();
  assert.equal(permissionRequests.length, 1, 'one click, one permission request');
  assert.deepEqual(JSON.parse(JSON.stringify(permissionRequests[0])), { permissions: ['notifications'] });
  assert.equal(alertsRow(document).hidden, true, 'granted: the row goes away');
});

test('a refused request leaves the row showing, so it can be tried again', async () => {
  const { document, permissionRequests } = await loadPopup({ held: false, grantOnRequest: false });
  document.byId.get('pcAlertsBtn').click();
  await flush();
  assert.equal(permissionRequests.length, 1);
  assert.equal(alertsRow(document).hidden, false);
});

// ─── The page itself ───────────────────────────────────────────────────────

test('the alerts row sits inside the PC approvals section, hidden in the page as shipped', async () => {
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');
  assert.match(html, /id="pcAlertsRow"/);
  assert.match(html, /id="pcAlertsBtn"/);
  assert.match(html, /<button id="pcAlertsBtn"[^>]*>Turn on alerts<\/button>/);
  assert.ok(
    html.indexOf('id="pcApprovals"') < html.indexOf('id="pcAlertsRow"')
      && html.indexOf('id="pcAlertsRow"') < html.indexOf('id="approvals"'),
    'the row belongs to the PC approvals section, above the Scribe section',
  );
  assert.match(html, /<div class="actions" id="pcAlertsRow" hidden>/,
    'the row starts hidden in the page; the script shows it only when the permission is missing');
});
