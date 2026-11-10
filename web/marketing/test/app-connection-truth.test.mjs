// Connection truth (2026-11-01): the surfaces agree, and "Connected"
// comes from one place only.
//
// The defect this locks down: pressing Sync Profile wrote
// connected = true for every stock provider into the runner presence
// store, and Settings + Integrations rendered that stamp as
// "Connected" — while the Agents page, reading the provider
// connections store (sql/031), truthfully said "Not connected". Sync
// now stamps presence rows without a connection claim (markSynced in
// src/cloud/runner-presence.mjs), and every surface below renders
// "Connected" only from the connections store, under the same rule
// the Agents page reads it with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { integrationsModel, agentsModel, settleWithStateRetry } from '../app/app-model.mjs';
import { integrationSections } from '../app/integrations-view.mjs';
import { CREDENTIAL_CONNECT_PATH, connectFieldsModel, connectPayload, createConnectFields, submitConnectFields } from '../app/connect-fields.mjs';

const SYNCED_AT = '2026-11-01T19:03:00.000Z';
// The presence rows a profile sync leaves behind: one stamp per stock
// provider, no connection claim on any of them.
const syncPresence = ['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama']
  .map((provider) => ({ provider, connected: false, updatedAt: SYNCED_AT }));

test('after a sync, every provider reads Synced · Not connected — model rows and cards alike', () => {
  const rows = integrationsModel({}, { connections: [] }, { presence: syncPresence });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const key of ['anthropic', 'openai', 'xai', 'google']) {
    assert.equal(by[key].connected, false, key);
    assert.equal(by[key].status, 'synced', key);
    assert.equal(by[key].statusText, 'Synced · Not connected', key);
    assert.equal(by[key].source, 'runner-presence', key);
    assert.equal(by[key].syncedAt, SYNCED_AT, key);
  }
  const cards = Object.fromEntries(integrationSections({ presence: syncPresence, providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  for (const key of ['claude', 'openai', 'gemini', 'grok', 'mistral', 'runway']) {
    assert.equal(cards[key].statusText, 'Synced · Not connected', key);
    assert.notEqual(cards[key].action?.label, 'Manage', `${key}: a stamp never earns the Manage action`);
  }
});

test('a presence report from a device still never reads Connected', () => {
  const rows = integrationsModel({}, { connections: [] }, { presence: [{ provider: 'claude', connected: true, updatedAt: SYNCED_AT }] });
  const claude = rows.find((r) => r.key === 'anthropic');
  assert.deepEqual([claude.connected, claude.statusText], [false, 'Synced · Not connected']);
});

test('a saved connection row reads Connected on every surface at once', () => {
  // The shape the real writers produce today: lifecycle 'pending'.
  const providers = { connections: [{ providerId: 'gemini', lifecycle: 'pending', authMode: 'oauth_subscription', updatedAt: SYNCED_AT }] };
  const row = integrationsModel({}, providers, { presence: [] }).find((r) => r.key === 'google');
  assert.deepEqual([row.connected, row.statusText, row.source], [true, 'Connected', 'provider-connection']);
  const cards = Object.fromEntries(integrationSections({ presence: [], providers, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(cards.gemini.statusText, 'Connected');
  assert.equal(cards.gemini.action.label, 'Manage');
  // The Agents page — the surface that was already telling the truth —
  // reads the same store the same way, so the surfaces cannot drift.
  const agents = agentsModel(providers, {});
  assert.equal(agents.agents.find((a) => a.name === 'Gemini').connected, true);
});

test('nothing saved and nothing stamped reads Not connected; unanswered reads Not checked', () => {
  const bare = integrationsModel({}, { connections: [] }, { presence: [] }).find((r) => r.key === 'google');
  assert.deepEqual([bare.connected, bare.statusText], [false, 'Not connected']);
  const blind = integrationsModel({}, {}, {}).find((r) => r.key === 'google');
  assert.deepEqual([blind.connected, blind.statusText], [false, 'Not checked']);
});

const ANSWERED_AT = '2026-11-01T20:30:00.000Z';

test('a provider that has answered reads Answered — model rows and cards alike — and the stamp alone never reads Connected', () => {
  // The last-answered stamp is written by the reply path itself when an
  // agent posts a reply back (sql/066), so this is the one presence
  // state beyond "Synced" the surfaces may claim.
  const presence = [{ provider: 'claude', connected: true, updatedAt: SYNCED_AT, lastAnsweredAt: ANSWERED_AT }];
  const claude = integrationsModel({}, { connections: [] }, { presence }).find((r) => r.key === 'anthropic');
  assert.deepEqual([claude.connected, claude.status, claude.statusText], [false, 'answered', 'Answered']);
  assert.equal(claude.lastAnsweredAt, ANSWERED_AT);
  const cards = Object.fromEntries(integrationSections({ presence, providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(cards.claude.statusText, 'Answered');
  assert.equal(cards.claude.status, 'on');
  // A saved connection still outranks the answered stamp.
  const providers = { connections: [{ providerId: 'claude', lifecycle: 'pending', updatedAt: SYNCED_AT }] };
  const saved = integrationsModel({}, providers, { presence }).find((r) => r.key === 'anthropic');
  assert.deepEqual([saved.connected, saved.statusText], [true, 'Connected']);
});

// ---- Bite 4: the one connect road lands on the AI cards ----
// Every not-connected AI card (the sign-in seats: claude, openai,
// gemini, grok, mistral — and runway since the P2 fix, 2026-11-09)
// carries the shared ConnectFields instead of the old roads:
// no /api/provider-oauth/<p>/start link actions, no claude-help /
// keys-help acts. Runway's card was the one dead end the
// fresh-signup walk found: the credential-connect route has always
// accepted runway, so it now carries the same fields; Bite 12's
// removal of its keys-help action stands.

test('bite 4: the sign-in AI cards carry connect fields when not connected, and lose the old roads', () => {
  const cards = Object.fromEntries(integrationSections({ presence: [], providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  for (const key of ['claude', 'openai', 'gemini', 'grok', 'mistral', 'runway']) {
    assert.deepEqual(cards[key].connect, { provider: key }, key);
    assert.equal(cards[key].action, null, `${key}: no link action and no help act remains`);
  }
});

test('bite 4: a connected AI card shows no fields and keeps Manage', () => {
  const providers = { connections: [{ providerId: 'gemini', lifecycle: 'pending', authMode: 'password_session', updatedAt: SYNCED_AT }] };
  const cards = Object.fromEntries(integrationSections({ presence: [], providers, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(cards.gemini.connect, null);
  assert.equal(cards.gemini.action.label, 'Manage');
  assert.equal(connectFieldsModel({ provider: 'gemini', connected: true }), null, 'the component model renders nothing when connected');
});

test('change road: Mistral has a truth row — a saved connection reads Connected (owner report, 2026-11-06)', () => {
  const providers = { connections: [{ providerId: 'mistral', lifecycle: 'pending', authMode: 'password_session', updatedAt: SYNCED_AT }] };
  const row = integrationsModel({}, providers, { presence: [] }).find((r) => r.key === 'mistral');
  assert.ok(row, 'the truth model carries a mistral row');
  assert.equal(row.connected, true);
  assert.equal(row.statusText, 'Connected');
  const none = integrationsModel({}, { connections: [] }, { presence: [] }).find((r) => r.key === 'mistral');
  assert.equal(none.connected, false, 'no saved row → not connected, same rule as every seat');
});

test('change road: Runway has a truth row — a saved connection reads Connected (P2 fix, 2026-11-09)', () => {
  const providers = { connections: [{ providerId: 'runway', lifecycle: 'pending', authMode: 'password_session', updatedAt: SYNCED_AT }] };
  const row = integrationsModel({}, providers, { presence: [] }).find((r) => r.key === 'runway');
  assert.ok(row, 'the truth model carries a runway row');
  assert.equal(row.connected, true);
  assert.equal(row.statusText, 'Connected');
  const none = integrationsModel({}, { connections: [] }, { presence: [] }).find((r) => r.key === 'runway');
  assert.equal(none.connected, false, 'no saved row → not connected, same rule as every seat');
  const cards = Object.fromEntries(integrationSections({ presence: [], providers, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(cards.runway.statusText, 'Connected', 'the card reads Connected from the same row');
  assert.equal(cards.runway.connect, null, 'a connected card shows no first-connect fields');
  assert.deepEqual(cards.runway.changeConnect, { provider: 'runway', label: 'New username and password' }, 'and offers the change road like every sign-in seat');
  assert.equal(cards.runway.action.label, 'Manage');
});

test('change road: change mode renders the fields for a connected provider (owner order, 2026-11-06)', () => {
  const model = connectFieldsModel({ provider: 'mistral', connected: true, change: true });
  assert.ok(model, 'change mode renders despite the saved connection');
  assert.equal(model.change, true);
  assert.equal(model.button.label, 'Save');
  const form = createConnectFields({ provider: 'mistral', connected: true, change: true, post: async () => ({}), doc: fakeDoc });
  assert.ok(form, 'the factory builds the change form');
  assert.equal(form.dataset.provider, 'mistral');
  const button = findAll(form, (n) => n.tagName === 'BUTTON')[0];
  assert.equal(button.textContent, 'Save');
});

// ---- minimal DOM for the component factory (only what it touches) ----
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...kids) { this.children.push(...kids); }
  setAttribute() {}
}
const fakeDoc = { createElement: (tag) => new FakeElement(tag) };
function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
const findAll = (root, pred) => [...walk(root)].filter(pred);

test('bite 4: component renders an email field, a password field, and a Connect button', () => {
  const form = createConnectFields({ provider: 'claude', post: async () => ({}), doc: fakeDoc });
  assert.ok(form, 'not connected renders the form');
  assert.equal(form.dataset.provider, 'claude');
  const inputs = findAll(form, (n) => n.tagName === 'INPUT');
  assert.deepEqual(inputs.map((i) => [i.name, i.type]), [['username', 'email'], ['password', 'password']]);
  const button = findAll(form, (n) => n.tagName === 'BUTTON')[0];
  assert.equal(button.textContent, 'Connect');
  assert.equal(button.type, 'submit');
  assert.equal(createConnectFields({ provider: 'claude', connected: true, post: async () => ({}), doc: fakeDoc }), null, 'connected renders no fields');
  const model = connectFieldsModel({ provider: 'grok' });
  assert.deepEqual(model.fields.map((f) => f.name), ['username', 'password']);
  assert.equal(model.path, CREDENTIAL_CONNECT_PATH);
});

test('bite 4: submit body is exactly {provider, username, password} to the credential connect route', async () => {
  const calls = [];
  const post = async (path, data) => { calls.push([path, data]); return { valid: true, stored: true }; };
  const result = await submitConnectFields({ provider: 'openai', username: '  owner@example.com ', password: 'p a s s', post });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/admin/envoy/credential/connect');
  assert.deepEqual(calls[0][1], { provider: 'openai', username: 'owner@example.com', password: 'p a s s' });
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['password', 'provider', 'username'], 'exactly the three keys — no tenant, no extras');
  assert.deepEqual(connectPayload('grok', ' a@b.c ', 'x'), { provider: 'grok', username: 'a@b.c', password: 'x' });
});

test('bite 4: a hung submit times out and its timer is cleared in the finally path', async () => {
  let timerFn = null;
  const cleared = [];
  const resultPromise = submitConnectFields({
    provider: 'gemini', username: 'a@b.c', password: 'x',
    post: () => new Promise(() => {}),
    timeoutMs: 25,
    setTimeoutFn: (fn) => { timerFn = fn; return 42; },
    clearTimeoutFn: (id) => cleared.push(id),
  });
  assert.equal(typeof timerFn, 'function', 'a timeout was armed');
  timerFn();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(cleared, [42], 'the finally path cleared the timer');
});

test('bite 4: refusals (403/502/503) surface a plain failure and restore the button — never a connected claim', async () => {
  for (const status of [403, 502, 503]) {
    const post = async () => { throw Object.assign(new Error('refused'), { status }); };
    const form = createConnectFields({ provider: 'mistral', post, doc: fakeDoc });
    const { usernameInput, passwordInput, button, note } = form.connectFields;
    usernameInput.value = 'owner@example.com';
    passwordInput.value = 'hunter2';
    await form.onsubmit({ preventDefault() {} });
    assert.equal(button.disabled, false, `${status}: button restored`);
    assert.equal(button.textContent, 'Connect', `${status}: button label restored`);
    assert.equal(usernameInput.disabled, false, `${status}: inputs restored`);
    assert.equal(note.hidden, false, `${status}: failure is shown`);
    assert.match(note.textContent, /nothing was saved/i, `${status}: plain failure state`);
    assert.doesNotMatch(note.textContent, /Connected/, `${status}: no unearned connected claim`);
  }
});

test('bite 4: a stored connect restores the button, clears the password, and hands status back to the store', async () => {
  let storedCalls = 0;
  const post = async () => ({ valid: true, stored: true });
  const form = createConnectFields({ provider: 'claude', post, doc: fakeDoc, onStored: async () => { storedCalls++; } });
  const { usernameInput, passwordInput, button, note } = form.connectFields;
  usernameInput.value = 'owner@example.com';
  passwordInput.value = 'hunter2';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(storedCalls, 1, 'the host is told to re-read the store');
  assert.equal(passwordInput.value, '', 'the password field is cleared after a store');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Connect');
  assert.match(note.textContent, /reads its status from the saved connection/, 'success copy defers to the store — it does not declare the card connected');
});

test('a registry-less provider (Mistral) reads Answered off its stamp; presence without an answer does not', () => {
  const answered = integrationSections({ presence: [{ provider: 'mistral', connected: false, updatedAt: SYNCED_AT, lastAnsweredAt: ANSWERED_AT }], providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).find((c) => c.key === 'mistral');
  assert.equal(answered.statusText, 'Answered');
  assert.equal(answered.status, 'on');
  const silent = integrationSections({ presence: syncPresence, providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).find((c) => c.key === 'mistral');
  assert.equal(silent.statusText, 'Synced · Not connected', 'a stamp with no answer behind it stays a stamp');
  assert.equal(silent.status, 'off');
});

// ------------------------------------------------------- landing
// read retry (2026-11-10): the owner walk's Agents tab flipped
// every card to "Not checked" + Connect after ONE landing whose
// state-bearing reads (provider connections, runner presence)
// failed transiently — the model truthfully derives "unchecked"
// from missing reads, so the landing must not derive from a
// failed read it never retried. settleWithStateRetry is the
// landing's reader: state readers get one retry on rejection,
// the rest settle once, honestly.

const noSleep = () => Promise.resolve();

test('landing reads: a state read that fails once then answers settles fulfilled with the second answer', async () => {
  let providersCalls = 0; let presenceCalls = 0; let connectorsCalls = 0;
  const settled = await settleWithStateRetry({
    connectors: async () => { connectorsCalls += 1; return { list: [] }; },
    providers: async () => { providersCalls += 1; if (providersCalls === 1) throw new Error('transient'); return { connections: [{ provider: 'claude' }] }; },
    presence: async () => { presenceCalls += 1; return { presence: [] }; },
  }, { stateKeys: ['providers', 'presence'], sleep: noSleep });
  assert.equal(settled.providers.status, 'fulfilled');
  assert.deepEqual(settled.providers.value, { connections: [{ provider: 'claude' }] });
  assert.equal(providersCalls, 2, 'the failed state read was retried exactly once');
  assert.equal(presenceCalls, 1, 'a state read that answered is not re-asked');
  assert.equal(connectorsCalls, 1, 'a non-state read is not retried');
});

test('landing reads: a state read that keeps failing settles rejected after exactly one retry', async () => {
  let providersCalls = 0; let sleeps = 0;
  const settled = await settleWithStateRetry({
    providers: async () => { providersCalls += 1; throw new Error('still down'); },
    overview: async () => { throw new Error('overview down'); },
  }, { stateKeys: ['providers'], sleep: async () => { sleeps += 1; } });
  assert.equal(settled.providers.status, 'rejected');
  assert.equal(providersCalls, 2, 'one first attempt plus one retry, then the landing takes the honest degraded paint');
  assert.equal(settled.overview.status, 'rejected');
  assert.equal(sleeps, 1, 'the retry waited once');
});

test('landing reads: when every read answers first time, nothing is re-asked and nothing waits', async () => {
  let calls = 0; let sleeps = 0;
  const reader = async () => { calls += 1; return {}; };
  const settled = await settleWithStateRetry(
    { providers: reader, presence: reader, connectors: reader },
    { stateKeys: ['providers', 'presence'], sleep: async () => { sleeps += 1; } },
  );
  assert.equal(calls, 3);
  assert.equal(sleeps, 0);
  assert.ok(Object.values(settled).every((s) => s.status === 'fulfilled'));
});

test('wiring: loadIntegrations reads through the retrying settler and a superseded pass never paints', async () => {
  const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  const loadAt = appJs.indexOf('async function loadIntegrations()');
  assert.ok(loadAt > 0);
  const loadBody = appJs.slice(loadAt, appJs.indexOf('function integrationCard', loadAt));
  assert.match(loadBody, /settleWithStateRetry\(\{/, 'the landing reads run through settleWithStateRetry');
  assert.match(loadBody, /stateKeys: \['providers', 'presence'\]/, 'the retried readers are the two the card states derive from');
  assert.ok(!loadBody.includes('Promise.allSettled([api('), 'the one-shot allSettled batch is gone');
  assert.match(loadBody, /const myLoad = \+\+integrationsLoadSeq;/, 'the pass numbers itself at entry');
  const guardAt = loadBody.indexOf('if (myLoad !== integrationsLoadSeq) return p.value;');
  const paintAt = loadBody.indexOf('integrationSections(');
  assert.ok(guardAt > 0 && paintAt > guardAt, 'the superseded-pass guard stands before the sections paint (and the Manage mount below it)');
});
