// 0.6.2 zero-friction Scribe setup: shipped defaults, mailbox derivation, the
// welcome page on install, own-page sender check (the popup-as-tab bug), and
// loud sign-in failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';
import * as D from '../background/defaults.js';
import { memoryStorage } from '../background/ledger.js';
import { getScribeSettings } from '../background/scribe-client.js';
import { getNudgeSettings } from '../background/nudge-policy.js';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = await installWorker();
const worker = await import('../background/worker.js');

function send(message, sender) {
  return new Promise((resolve) => {
    let done = false;
    const respond = (r) => { if (!done) { done = true; resolve(r); } };
    const kept = fake.listeners.map((l) => l(message, sender, respond)).some((r) => r === true);
    if (!kept) setTimeout(() => respond(undefined), 0);
  });
}
const POPUP_AS_TAB = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html'), tab: { id: 9, url: chrome.runtime.getURL('popup/popup.html') } };
const WELCOME = { id: chrome.runtime.id, url: chrome.runtime.getURL('onboarding/onboarding.html'), tab: { id: 10 } };
const CONTENT = { id: chrome.runtime.id, url: 'https://claude.ai/chat/1', tab: { id: 3, url: 'https://claude.ai/chat/1' } };
const OTHER = { id: 'someone-else', url: 'chrome-extension://someone-else/popup/popup.html' };

test('defaults: one build-time Scribe URL constant, shipped as the hosted server', async () => {
  assert.equal(D.SCRIBE_DEFAULT_URL, 'https://5-78-222-178.sslip.io');
  const src = await readFile(path.join(EXT, 'background/defaults.js'), 'utf8');
  assert.equal((src.match(/^export const SCRIBE_DEFAULT_URL = .*@build:scribe-url$/gm) || []).length, 1, 'exactly one marked line');
  // The URL literal appears nowhere else in shipped code.
  for (const f of ['background/worker.js', 'background/scribe-client.js', 'popup/popup.js', 'popup/connect.js', 'onboarding/onboarding.js']) {
    assert.doesNotMatch(await readFile(path.join(EXT, f), 'utf8'), /5-78-222-178/, f);
  }
  const s = await getScribeSettings(memoryStorage());
  assert.equal(s.baseUrl, D.SCRIBE_DEFAULT_URL);
  assert.equal(s.enabled, true, 'knock is on by default (it still needs sign-in and a mailbox)');
  const n = await getNudgeSettings(memoryStorage());
  assert.equal(n.idleMinutes, 3); assert.equal(n.dailyCapPerSite, 20);
  assert.equal(n.enabled, false, 'auto-nudge waits for the AIs picked on the welcome page');
});

test('mailbox derivation from ticked AIs: chatgpt, claude.ai, grok, gemini; never typed', () => {
  assert.deepEqual(D.mailboxesForAis(['chatgpt', 'claude', 'grok', 'gemini']), ['chatgpt', 'claude.ai', 'grok', 'gemini']);
  assert.deepEqual(D.mailboxesForAis(['gemini', 'claude']), ['claude.ai', 'gemini']);
  assert.deepEqual(D.mailboxesForAis(['bogus']), []);
  assert.deepEqual(D.nudgeSitesForAis(['grok']), { 'chatgpt.com': false, 'claude.ai': false, 'grok.com': true, 'gemini.google.com': false, 'perplexity.ai': false, 'chat.mistral.ai': false });
});

test('welcome page saves name + AIs: mailboxes and per-site nudge filled in, idle 3, cap 20', async () => {
  fake.resetStorage();
  const bad = await send({ type: 'helmion:onboarding', action: 'save', profile: { name: '', ais: ['grok'] } }, WELCOME);
  assert.equal(bad.ok, false); assert.match(bad.error, /name or email/);
  const none = await send({ type: 'helmion:onboarding', action: 'save', profile: { name: 'Troy', ais: [] } }, WELCOME);
  assert.equal(none.ok, false); assert.match(none.error, /Tick at least one AI/);
  const r = await send({ type: 'helmion:onboarding', action: 'save', profile: { name: 'Troy', ais: ['claude', 'grok'] } }, WELCOME);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.profile.mailboxes, ['claude.ai', 'grok']);
  const s = await send({ type: 'helmion:scribe-settings', settings: {} }, POPUP_AS_TAB);
  assert.deepEqual(s.settings.mailboxes, ['claude.ai', 'grok']);
  assert.equal(s.settings.baseUrl, D.SCRIBE_DEFAULT_URL);
  const n = await send({ type: 'helmion:nudge-settings', settings: {} }, POPUP_AS_TAB);
  assert.equal(n.settings.enabled, true);
  assert.deepEqual(n.settings.sites, { 'chatgpt.com': false, 'claude.ai': true, 'grok.com': true, 'gemini.google.com': false, 'perplexity.ai': false, 'chat.mistral.ai': false });
  assert.equal(n.settings.idleMinutes, 3); assert.equal(n.settings.dailyCapPerSite, 20);
  const back = await send({ type: 'helmion:onboarding', action: 'get' }, WELCOME);
  assert.equal(back.profile.name, 'Troy');
});

test('ROOT CAUSE FIX: the popup opened as a full tab is accepted; content scripts and other extensions are not', async () => {
  for (const sender of [POPUP_AS_TAB, WELCOME, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') }]) {
    const r = await send({ type: 'helmion:scribe-settings', settings: {} }, sender);
    assert.equal(r.ok, true, sender.url);
  }
  for (const sender of [CONTENT, OTHER, { id: chrome.runtime.id, url: chrome.runtime.getURL('content/guard.js') }, undefined]) {
    const r = await send({ type: 'helmion:scribe-signin', action: 'signin' }, sender);
    assert.equal(r.ok, false); assert.match(r.error, /only accepted from Guard's own pages/);
  }
});

test('the welcome page opens on first install only', () => {
  const tabs = [];
  const api = { tabs: { create: (o) => tabs.push(o) }, runtime: chrome.runtime };
  assert.equal(worker.handleInstalled({ reason: 'update', previousVersion: '0.6.0' }, api), false);
  assert.equal(worker.handleInstalled({ reason: 'chrome_update' }, api), false);
  assert.equal(tabs.length, 0);
  assert.equal(worker.handleInstalled({ reason: 'install' }, api), true);
  assert.deepEqual(tabs, [{ url: 'chrome-extension://helmion-guard-test-id/onboarding/onboarding.html' }]);
});

test('sign-in without the identity API fails LOUDLY with what to do', async () => {
  fake.resetStorage();
  const saved = chrome.identity; delete chrome.identity;
  try {
    const r = await send({ type: 'helmion:scribe-signin', action: 'signin' }, POPUP_AS_TAB);
    assert.equal(r.ok, false);
    assert.match(r.error, /identity.*permission.*Connect Scribe again.*Allow/);
  } finally { if (saved) chrome.identity = saved; }
});

test('identity errors become plain sentences', () => {
  assert.match(worker.plainLaunchError('The user did not approve access.'), /closed before sign-in finished.*try again/);
  assert.match(worker.plainLaunchError('Authorization page could not be loaded.'), /could not be loaded.*internet connection/);
  assert.match(worker.plainLaunchError(''), /closed before sign-in finished/);
  assert.match(worker.plainLaunchError('weird'), /could not open the Scribe sign-in window \(browser said: weird\)/);
});

test('redirect URL is reported for Advanced (https://<id>.chromiumapp.org/)', async () => {
  const r = await send({ type: 'helmion:scribe-signin', action: 'redirect' }, POPUP_AS_TAB);
  assert.equal(r.ok, true);
  assert.equal(r.auth.redirectUrl, 'https://helmion-guard-test-id.chromiumapp.org/');
});

// ─── connect.js in a sandbox ──────────────────────────────────────────────
async function loadConnect(chromeStub) {
  const src = await readFile(path.join(EXT, 'popup/connect.js'), 'utf8');
  const ctx = { chrome: chromeStub, setTimeout, clearTimeout, URL, Promise };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  return ctx.HelmionConnect;
}
function stub({ grant = true, answer } = {}) {
  const calls = [];
  const c = {
    runtime: { lastError: undefined, sendMessage(m, cb) { calls.push(m.type); if (answer === 'none') return; setTimeout(() => cb(answer ? answer(m) : { ok: true, auth: { signedIn: true } }), 0); } },
    permissions: { request(want, cb) { calls.push(`perm:${JSON.stringify(want)}`); setTimeout(() => cb(grant), 0); } },
  };
  return { c, calls };
}

test('connect: permissions.request starts synchronously inside the click (before any await)', async () => {
  const { c, calls } = stub();
  const H = await loadConnect(c);
  const p = H.connect('https://5-78-222-178.sslip.io', () => {});
  assert.equal(calls[0], 'perm:{"permissions":["identity"],"origins":["https://5-78-222-178.sslip.io/*"]}', 'requested before connect() returned');
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(calls.slice(1), ['helmion:scribe-settings', 'helmion:scribe-signin']);
});

test('connect: denied permission, worker error, and a dead worker are all reported loudly', async () => {
  const seen = [];
  const report = (k, t) => seen.push([k, t]);
  let H = await loadConnect(stub({ grant: false }).c);
  assert.equal((await H.connect('https://x.example', report)).ok, false);
  assert.deepEqual(seen.at(-1)[0], 'error'); assert.match(seen.at(-1)[1], /did not allow Guard.*Allow/);

  H = await loadConnect(stub({ answer: (m) => (m.type === 'helmion:scribe-signin' ? { ok: false, error: 'Scribe refused sign-in: access_denied' } : { ok: true }) }).c);
  await H.connect('https://x.example', report);
  assert.equal(seen.at(-1)[0], 'error'); assert.match(seen.at(-1)[1], /Scribe is NOT connected\. Scribe refused sign-in/);

  H = await loadConnect(stub().c);
  assert.equal((await H.connect('not a url', report)).ok, false);
  assert.match(seen.at(-1)[1], /not a valid web address/);

  const noPerm = await loadConnect({ runtime: { sendMessage() {} } });
  await noPerm.connect('https://x.example', report);
  assert.match(seen.at(-1)[1], /cannot ask the browser for permissions/);
});

test('connect: a worker that never answers times out with a plain message', async () => {
  const H = await loadConnect(stub({ answer: 'none' }).c);
  const r = await H.send('helmion:scribe-settings', {}, 20);
  assert.equal(r.ok, false); assert.match(r.error, /did not answer.*Reload the extension/);
});

test('popup: advanced fields live behind an Advanced disclosure; welcome page lists the four AIs', async () => {
  const html = await readFile(path.join(EXT, 'popup/popup.html'), 'utf8');
  const adv = html.slice(html.indexOf('<details id="scribeAdvanced">'), html.indexOf('</details>', html.indexOf('<details id="scribeAdvanced">')));
  for (const id of ['scribeUrl', 'scribeMailboxes', 'scribeUnreadPath', 'scribeToken', 'nudgeIdle', 'nudgeCap', 'nudgeSite-chatgpt.com', 'nudgeSite-claude.ai', 'nudgeSite-grok.com', 'nudgeSite-gemini.google.com', 'nudgeSite-perplexity.ai', 'nudgeSite-chat.mistral.ai', 'scribeRedirect']) {
    assert.ok(adv.includes(`id="${id}"`), `${id} is inside Advanced`);
  }
  const svc = html.slice(html.indexOf('<details id="advancedServices">'));
  for (const id of ['execUrl', 'execToken', 'flagsUrl', 'flagsKey', 'uploadToken']) assert.ok(svc.includes(`id="${id}"`), `${id} is inside Advanced`);
  assert.match(html, /<script src="connect\.js"><\/script>\s*<script src="popup\.js">/);
  const welcome = await readFile(path.join(EXT, 'onboarding/onboarding.html'), 'utf8');
  const ob = await readFile(path.join(EXT, 'onboarding/onboarding.js'), 'utf8');
  assert.match(welcome, /<script type="module" src="onboarding\.js">/);
  assert.match(ob, /import \{ AI_CHOICES \} from '\.\.\/background\/defaults\.js'/, 'tick boxes come from the one AI table');
  assert.match(welcome, /Connect Scribe/);
  assert.match(welcome, /may conflict with some sites' terms/);
  assert.doesNotMatch(welcome, /id="[^"]*mailbox/i, 'no mailbox field to type into');
});

test('package: welcome page ships, version 0.6.6, options page, build-time --scribe-url rewrite', async () => {
  for (const f of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(await readFile(path.join(EXT, f), 'utf8'));
    assert.equal(m.version, '0.6.6');
    assert.deepEqual(m.options_ui, { page: 'popup/popup.html', open_in_tab: true });
  }
  const { applyScribeUrl } = await import('../../tools/package-guard.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'guard-url-'));
  await mkdir(path.join(dir, 'background'));
  await writeFile(path.join(dir, 'background/defaults.js'), await readFile(path.join(EXT, 'background/defaults.js'), 'utf8'));
  assert.equal(await applyScribeUrl(dir, 'https://scribe.helmian.cloud/'), 'https://scribe.helmian.cloud');
  const out = await readFile(path.join(dir, 'background/defaults.js'), 'utf8');
  assert.match(out, /export const SCRIBE_DEFAULT_URL = 'https:\/\/scribe\.helmian\.cloud'; \/\/ @build:scribe-url/);
  await assert.rejects(applyScribeUrl(dir, 'http://plain.example'));
  assert.equal(await applyScribeUrl(dir, ''), null);
});

test('0.6.4 AI table: seven AIs, one table drives mailboxes, nudge sites and open-to-read links', async () => {
  assert.deepEqual(D.AI_CHOICES.map((c) => c.key), ['chatgpt', 'claude', 'grok', 'gemini', 'mistral', 'perplexity', 'muse']);
  for (const c of D.AI_CHOICES) {
    assert.match(c.mailbox, /^[a-z0-9][a-z0-9._-]*$/, 'lowercase mailbox ids');
    assert.equal(typeof c.nudge, 'boolean');
    if (c.nudge) assert.ok(c.hosts.length && c.chatUrl);
  }
  assert.deepEqual(D.mailboxesForAis(['mistral', 'perplexity', 'muse']), ['mistral', 'perplexity', 'muse']);
  assert.deepEqual(D.nudgeSitesForAis(['muse', 'grok']), { 'chatgpt.com': false, 'claude.ai': false, 'grok.com': true, 'gemini.google.com': false, 'perplexity.ai': false, 'chat.mistral.ai': false }, 'mailbox-only AIs add no nudge site');
  const { NUDGE_SITES } = await import('../background/nudge-policy.js');
  assert.deepEqual(NUDGE_SITES, { 'chatgpt.com': 'chatgpt', 'claude.ai': 'claude.ai', 'grok.com': 'grok', 'gemini.google.com': 'gemini', 'perplexity.ai': 'perplexity', 'chat.mistral.ai': 'mistral' });
  const { MAILBOX_SITES, mailboxName } = await import('../background/scribe-client.js');
  assert.equal(MAILBOX_SITES.mistral, 'https://chat.mistral.ai/');
  assert.equal(MAILBOX_SITES.perplexity, 'https://www.perplexity.ai/');
  assert.equal(MAILBOX_SITES.muse, undefined, 'Muse chat URL not verified');
  assert.equal(mailboxName('le-chat'), 'mistral'); assert.equal(mailboxName('muse'), 'muse'); assert.equal(mailboxName('Perplexity'), 'perplexity');
  assert.match(D.AI_CHOICES.find((c) => c.key === 'perplexity').note, /higher Perplexity plan/);
  // Every nudge site has a content-script match and a nudge adapter.
  const man = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
  const nudgeJs = await readFile(path.join(EXT, 'content/nudge.js'), 'utf8');
  for (const host of Object.keys(NUDGE_SITES)) {
    assert.ok(man.content_scripts[0].matches.includes(`https://${host}/*`), host);
    assert.ok(nudgeJs.includes(`'${host}'`), host);
  }
});

test('0.6.5 Perplexity row: nudge on, www and bare host matched, popup toggle, no other host left without a tick', async () => {
  const p = D.AI_CHOICES.find((c) => c.key === 'perplexity');
  assert.equal(p.nudge, true); assert.deepEqual(p.hosts, ['perplexity.ai']);
  assert.deepEqual(D.nudgeSitesForAis(['perplexity'])['perplexity.ai'], true);
  const { siteForHost } = await import('../background/nudge-policy.js');
  if (typeof siteForHost === 'function') { assert.equal(siteForHost('www.perplexity.ai'), 'perplexity.ai'); assert.equal(siteForHost('perplexity.ai'), 'perplexity.ai'); }
  for (const f of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(await readFile(path.join(EXT, f), 'utf8'));
    for (const u of ['https://www.perplexity.ai/*', 'https://perplexity.ai/*']) assert.ok(m.content_scripts[0].matches.includes(u), f + ' ' + u);
    // Every AI site the content scripts run on is a tick box on the welcome page.
    const tickHosts = D.AI_CHOICES.flatMap((c) => c.hosts);
    for (const u of m.content_scripts.flatMap((c) => c.matches)) {
      const h = new URL(u.replace('/*', '/')).hostname;
      assert.ok(tickHosts.some((t) => h === t || h.endsWith('.' + t)), f + ': ' + h + ' has no tick');
    }
  }
  const html = await readFile(path.join(EXT, 'popup/popup.html'), 'utf8');
  assert.match(html, /id="nudgeSite-perplexity\.ai"/);
});

test('0.6.6 Mistral row: nudge on, chat.mistral.ai matched, popup toggle; Muse stays mailbox-only', async () => {
  const m = D.AI_CHOICES.find((c) => c.key === 'mistral');
  assert.equal(m.nudge, true); assert.deepEqual(m.hosts, ['chat.mistral.ai']);
  assert.equal(D.nudgeSitesForAis(['mistral'])['chat.mistral.ai'], true);
  const muse = D.AI_CHOICES.find((c) => c.key === 'muse');
  assert.equal(muse.nudge, false); assert.equal(muse.chatUrl, null);
  for (const f of ['manifest.json', 'manifest.firefox.json']) {
    const man = JSON.parse(await readFile(path.join(EXT, f), 'utf8'));
    assert.ok(man.content_scripts[0].matches.includes('https://chat.mistral.ai/*'), f);
  }
  assert.match(await readFile(path.join(EXT, 'popup/popup.html'), 'utf8'), /id="nudgeSite-chat\.mistral\.ai"/);
});
