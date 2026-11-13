// The approvals window page (approvals pop-up build, Bite 5).
//
// These tests load the REAL popup/approvals-window.js into a vm sandbox
// (the house pattern from test-support/load-content-script.mjs) against
// a small fake document built from the REAL approvals-window.html's own
// ids, a scripted chrome.runtime, a fake clock, and captured interval
// timers, so the countdown can be walked second by second. They prove
// the page only: the full row (ask, who, reason, asked-at, live
// countdown), the two-step approve (no decision leaves on the first
// tap, exactly one on Confirm, none on Cancel), the one-tap deny, the
// outcome lines, expiry arriving on screen (the countdown reaches zero
// and the buttons go away), and the plain states (signed out, not the
// owner, stale under its banner, empty, worker silent).
//
// What they do NOT prove: a real browser, a real worker, or the live
// proxy. The worker side of these messages is covered by
// worker-pc-window.test.mjs; the window in a real Chromium against the
// real proxy is this bite's load proof, recorded in its report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadContentScripts, EXTENSION_ROOT } from '../test-support/load-content-script.mjs';

// ─── Fake DOM ──────────────────────────────────────────────────────────────
// The same small fake the pop-up suites use: an id registry,
// createElement, children, textContent replacing children, click
// listeners, and the declared hidden attribute seeded as a browser
// seeds it.
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
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'approvals-window.html'), 'utf8');
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

// ─── Fake clock and timers ─────────────────────────────────────────────────
// The page reads its time from Date.now and Date.parse; a Date subclass
// with a fixed, test-moved now() is injected as the sandbox global. The
// page's two intervals are captured, never scheduled, and fired by hand.
const T0 = Date.parse('2026-11-12T18:00:00.000Z');
let fakeNow = T0;
class FakeDate extends Date {
  static now() { return fakeNow; }
}

const intervals = [];
function fakeSetInterval(fn, ms) {
  intervals.push({ fn, ms });
  return intervals.length;
}
function fireInterval(ms) {
  for (const t of intervals.filter((i) => i.ms === ms)) t.fn();
}

// ─── Scripted world ────────────────────────────────────────────────────────
async function loadWindow({ pcView, onDecide, onView } = {}) {
  fakeNow = T0;
  intervals.length = 0;
  const document = await fakeDocument();
  const messages = [];
  const tabsCreated = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(message);
        let response;
        if (message.type === 'helmion:pc-approvals-view') {
          response = onView ? onView(message) : { ok: true, view: pcView };
        } else if (message.type === 'helmion:pc-approvals-decide') {
          response = onDecide ? onDecide(message) : { ok: true, view: pcView };
        } else response = { ok: false, error: `unscripted: ${message.type}` };
        setTimeout(() => callback(response), 0);
      },
    },
    tabs: { create: (args) => tabsCreated.push(args) },
  };
  await loadContentScripts(['popup/approvals-window.js'], {
    document, chrome, Date: FakeDate,
    setInterval: fakeSetInterval, clearInterval: () => {},
  });
  await flush();
  return { document, messages, tabsCreated };
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function item(id, summary, extra = {}) {
  return {
    id, summary, tool: 'hands', site: 'this PC',
    reason: 'The nightly job left it locked',
    createdAt: '2026-11-12T17:30:00.000Z', expiresAt: null, ...extra,
  };
}

function listView(items) {
  return {
    state: 'list', session: 'in', items, count: items.length,
    lastError: '', stale: false, updatedAt: T0,
  };
}

function rows(document) {
  return document.byId.get('windowList').childNodes;
}
function status(document) {
  return document.byId.get('windowStatus').textContent;
}
function decides(messages) {
  return messages.filter((m) => m.type === 'helmion:pc-approvals-decide');
}

// ─── The full row and the countdown ────────────────────────────────────────

test('a row carries the whole ask: summary, who, reason, asked-at, and the live countdown', async () => {
  const expires = new Date(T0 + (2 * 60 + 14) * 60000).toISOString();
  const view = listView([item('a1', 'Delete the old build folder', { expiresAt: expires })]);
  const { document, messages } = await loadWindow({ pcView: view });

  const viewAsks = messages.filter((m) => m.type === 'helmion:pc-approvals-view');
  assert.equal(viewAsks.length, 1, 'opening the window asks the worker for the view once');
  assert.equal(viewAsks[0].options.force, true, 'and asks for a fresh one');

  assert.equal(document.byId.get('windowCount').textContent, '1 waiting for your decision');
  assert.match(document.byId.get('windowUpdated').textContent, /^Last updated .+\.$/);

  const rendered = rows(document);
  assert.equal(rendered.length, 1);
  const text = rendered[0].textContent;
  assert.match(text, /Delete the old build folder/);
  assert.match(text, /hands · this PC/);
  assert.match(text, /The nightly job left it locked/);
  assert.match(text, /Asked .+/);
  assert.match(text, /expires in 2h 14m/);
  assert.deepEqual(rendered[0].buttons().map((b) => b.textContent), ['Approve', 'Deny']);
});

test('the countdown walks down with the clock, second by second', async () => {
  const expires = new Date(T0 + 90000).toISOString();
  const view = listView([item('a1', 'Delete the old build folder', { expiresAt: expires })]);
  const { document } = await loadWindow({ pcView: view });

  assert.match(rows(document)[0].textContent, /expires in 2m/);
  fakeNow += 31000;
  fireInterval(1000);
  assert.match(rows(document)[0].textContent, /expires in 1m/);
  assert.equal(rows(document)[0].buttons().length, 2, 'still decidable with time left');
});

test('an item that expires on screen is marked expired and its buttons go away', async () => {
  const expires = new Date(T0 + 30000).toISOString();
  const view = listView([item('a1', 'Delete the old build folder', { expiresAt: expires })]);
  const { document, messages } = await loadWindow({ pcView: view });
  assert.equal(rows(document)[0].buttons().length, 2);

  fakeNow += 31000;
  fireInterval(1000);

  const row = rows(document)[0];
  assert.match(row.textContent, /Expired/);
  assert.match(row.textContent, /This request has expired\./);
  assert.equal(row.buttons().length, 0, 'an expired item cannot be decided from this window');
  assert.equal(decides(messages).length, 0, 'and no decision was attempted');
});

test('an item already expired when the list arrives shows no buttons', async () => {
  const expires = new Date(T0 - 60000).toISOString();
  const view = listView([item('a1', 'Delete the old build folder', { expiresAt: expires })]);
  const { document } = await loadWindow({ pcView: view });

  const row = rows(document)[0];
  assert.equal(row.buttons().length, 0);
  assert.match(row.textContent, /This request has expired\./);
});

test('the periodic refresh asks again, unforced, and opening the window decided nothing', async () => {
  const view = listView([item('a1', 'Delete the old build folder')]);
  const { messages } = await loadWindow({ pcView: view });

  fireInterval(30000);
  await flush();

  const viewAsks = messages.filter((m) => m.type === 'helmion:pc-approvals-view');
  assert.equal(viewAsks.length, 2);
  assert.equal(viewAsks[1].options.force, false);
  assert.equal(decides(messages).length, 0,
    'the window sends no decision on its own: loading and leaving it decide nothing');
});

// ─── Deciding ──────────────────────────────────────────────────────────────

test('approve is two steps: the first tap decides nothing and names what Confirm will do', async () => {
  const a = item('a1', 'Delete the old build folder');
  const { document, messages } = await loadWindow({ pcView: listView([a]) });

  rows(document)[0].buttons()[0].click();
  await flush();

  assert.equal(decides(messages).length, 0, 'the first tap sends no decision');
  const row = rows(document)[0];
  assert.match(row.textContent, /You are about to approve "Delete the old build folder"\. This is recorded with your name\./);
  assert.deepEqual(row.buttons().map((b) => b.textContent), ['Confirm approve', 'Cancel']);
});

test('cancel on the confirm step sends nothing and returns the row to Approve and Deny', async () => {
  const a = item('a1', 'Delete the old build folder');
  const { document, messages } = await loadWindow({ pcView: listView([a]) });

  rows(document)[0].buttons()[0].click();
  await flush();
  rows(document)[0].buttons()[1].click();
  await flush();

  assert.equal(decides(messages).length, 0);
  assert.deepEqual(rows(document)[0].buttons().map((b) => b.textContent), ['Approve', 'Deny']);
});

test('confirm approve sends exactly one decision, and the outcome line answers', async () => {
  const a = item('a1', 'Delete the old build folder');
  const b = item('b2', 'Send the log file');
  const { document, messages } = await loadWindow({
    pcView: listView([a, b]),
    onDecide: () => ({ ok: true, view: listView([b]) }),
  });

  rows(document)[0].buttons()[0].click();
  await flush();
  rows(document)[0].buttons()[0].click();
  await flush();

  const sent = decides(messages);
  assert.equal(sent.length, 1, 'one decision for the whole two-step tap');
  assert.equal(sent[0].id, 'a1');
  assert.equal(sent[0].verdict, 'approve');
  assert.equal(status(document), 'Approved. The AI can run it once.');
  assert.equal(rows(document).length, 1, 'the decided item left with the refreshed list');
});

test('deny is one tap, and its outcome line answers', async () => {
  const a = item('a1', 'Delete the old build folder');
  const { document, messages } = await loadWindow({
    pcView: listView([a]),
    onDecide: () => ({ ok: true, view: listView([]) }),
  });

  rows(document)[0].buttons()[1].click();
  await flush();

  const sent = decides(messages);
  assert.equal(sent.length, 1, 'deny needs no confirm step');
  assert.equal(sent[0].verdict, 'deny');
  assert.equal(status(document), 'Denied. Nothing ran.');
  assert.equal(rows(document).length, 0);
});

test('a failed decide shows one plain line and leaves the item waiting, buttons back', async () => {
  const a = item('a1', 'Delete the old build folder');
  const line = 'That request was already decided.';
  const { document, messages } = await loadWindow({
    pcView: listView([a]),
    onDecide: () => ({ ok: false, error: line, view: listView([a]) }),
  });

  rows(document)[0].buttons()[1].click();
  await flush();

  assert.equal(decides(messages).length, 1);
  assert.equal(status(document), line);
  assert.equal(rows(document).length, 1, 'the item is still on the list');
  assert.deepEqual(rows(document)[0].buttons().map((b) => b.textContent), ['Approve', 'Deny']);
});

test('there is no approve-all: two waiting items are two separate decisions', async () => {
  const a = item('a1', 'Delete the old build folder');
  const b = item('b2', 'Send the log file');
  const { document, messages } = await loadWindow({ pcView: listView([a, b]) });

  assert.equal(document.byId.get('windowCount').textContent, '2 waiting for your decision');
  const allButtons = [...document.byId.get('windowList').descendants()]
    .filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent);
  assert.deepEqual(allButtons, ['Approve', 'Deny', 'Approve', 'Deny'],
    'each item carries its own pair and nothing else exists to tap');
  assert.equal(decides(messages).length, 0);
});

// ─── The plain states ──────────────────────────────────────────────────────

test('an empty list reads as nothing waiting, in the header and the status line', async () => {
  const { document } = await loadWindow({ pcView: listView([]) });
  assert.equal(rows(document).length, 0);
  assert.equal(document.byId.get('windowCount').textContent, 'Nothing waiting for your decision');
  assert.equal(status(document), 'Nothing is waiting for a decision.');
});

test('the signed-out state shows the sign-in line and button, never an empty list', async () => {
  const view = {
    state: 'signed-out', session: 'out', items: [], count: 0,
    lastError: 'Please sign in to Helmian.', stale: false, updatedAt: 0,
  };
  const { document, tabsCreated } = await loadWindow({ pcView: view });

  assert.equal(status(document), 'Please sign in to Helmian.');
  assert.equal(rows(document).length, 0);
  const signIn = document.byId.get('windowSignInBtn');
  assert.equal(signIn.hidden, false, 'the sign-in button shows in the signed-out state');

  signIn.click();
  assert.equal(tabsCreated.length, 1);
  assert.equal(tabsCreated[0].url, 'https://helmian.cloud/app#approvals');
});

test('the not-owner state shows the owner line in the web page words', async () => {
  const view = {
    state: 'not-owner', session: 'in', items: [], count: 0,
    lastError: "PC actions are approved by the PC owner's account.", stale: false, updatedAt: 0,
  };
  const { document } = await loadWindow({ pcView: view });

  assert.equal(status(document), "PC actions are approved by the PC owner's account.");
  assert.equal(rows(document).length, 0);
  assert.equal(document.byId.get('windowSignInBtn').hidden, true);
});

test('a stale list stands under its banner, labelled with its own time, rows still shown', async () => {
  const view = {
    state: 'unavailable', session: 'in', items: [item('a1', 'Delete the old build folder')],
    count: 1, lastError: 'The Guard could not be reached.', stale: true,
    updatedAt: Date.parse('2026-11-12T16:12:00.000Z'),
  };
  const { document } = await loadWindow({ pcView: view });

  const banner = document.byId.get('windowBanner');
  assert.equal(banner.hidden, false, 'the stale banner shows');
  assert.match(banner.textContent, /^Showing the last list from .+\. The Guard could not be reached\.$/);
  assert.equal(rows(document).length, 1, 'the last known list still renders under the banner');
});

test('a worker that does not answer renders one plain failure line, not an empty list', async () => {
  const { document } = await loadWindow({
    onView: () => undefined,
  });

  assert.equal(status(document), 'the background worker did not answer');
  assert.equal(rows(document).length, 0);
  assert.equal(document.byId.get('windowSignInBtn').hidden, true);
});

// ─── The page itself ───────────────────────────────────────────────────────

test('the window page carries its surface: the ids, its script, its styles, no inline script', async () => {
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'approvals-window.html'), 'utf8');

  for (const id of ['windowCount', 'windowUpdated', 'windowBanner', 'windowStatus', 'windowList', 'windowSignInBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `approvals-window.html is missing #${id}`);
  }
  assert.match(html, /<script src="approvals-window\.js"><\/script>/);
  assert.match(html, /href="approvals-window\.css"/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
    'the window page carries no inline script, which MV3 would refuse to run');
  assert.match(html, /Closing this window decides nothing\./,
    'the page says on its face that closing it is not a decision');
});
