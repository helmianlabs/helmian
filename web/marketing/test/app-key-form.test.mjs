import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  EMPTY_KEY_MESSAGE,
  KEY_CONNECT_PATH,
  KEY_DISCONNECT_PATH,
  KEY_FORM_FIELDS,
  KEY_HEADER_PATH,
  applyKeyConnect,
  applyKeyDisconnect,
  connectStartBody,
  disconnectBody,
  disconnectKeyEntry,
  headerConnectBody,
  isNeedsCredentialAnswer,
  keyEntryKey,
  keyFormModel,
  submitKeyForm,
} from '../app/connector-key-form.mjs';
import * as keyFormSeed from '../app/connector-key-form.mjs';
import { level2Model } from '../app/connector-panel.mjs';

// Panel-native home bite 2 (2026-11-10): the key/token form in the
// channel connector panel — a header entry's Connect opens the form
// in the panel, the submit writes through the connector library's
// header road, and the state after the write is the road's own
// returned connection. The model's contracts are the real server
// ones (src/cloud/connector-library-write-route.mjs):
//   POST /api/admin/connector-library/connect        { seatId, entryId }
//        → header: { status:'needs-credential', accessTokenRef,
//           completeAction:'connect/header' }
//   POST /api/admin/connector-library/connect/header { seatId, entryId, apiKey, accountLabel? }
//        → 201 { status:'connected', connection }
//        refusals: empty key 400 with EMPTY_KEY_MESSAGE's words;
//        a custom entry whose safety check has not passed 409 with
//        the gate's words + code CUSTOM_GATE_NOT_PASSED (the gate
//        runs before any key is stored — connector-custom-gate);
//        credential storage off 503; store refused 502.
//   POST /api/admin/connector-library/disconnect     { seatId, entryId }
//        → { status:'disconnected', connection, custodyRevoked }

const GATE_REFUSAL = 'this custom connector has not passed its safety check yet, so nothing was connected.';
const STORE_REFUSAL = 'the credential service would not keep the key, so nothing was connected';

const connection = (over = {}) => ({
  personId: 'person-1', seatId: 'grok', entryId: 'custom-keys',
  accountIdentity: 'API key', grantedScopes: [], posture: 'ask',
  toolEnableMap: {}, state: 'connected', ...over,
});
const freshModel = (over = {}) => keyFormModel({ seatId: 'grok', entryId: 'custom-keys', name: 'Weather Keys', kind: 'custom', ...over });

test('fields: the form carries exactly the fields the header road declares — one secret, one optional name', () => {
  assert.deepEqual(KEY_FORM_FIELDS.map((f) => [f.name, f.kind, f.type, f.required]), [
    ['apiKey', 'secret', 'password', true],
    ['accountLabel', 'text', 'text', false],
  ], 'the key itself (a password field) and the optional name for the key — the road accepts nothing else');
  const model = freshModel();
  assert.equal(model.fields, KEY_FORM_FIELDS);
  assert.match(model.intro, /takes an API key or header token/, 'the intro is the removed Manage form\u2019s own words');
  assert.match(model.intro, /keeps only a reference to it/, 'the intro says where the key goes and what the list keeps');
  assert.equal(model.button.label, 'Store the key and connect');
  assert.equal(model.connected, false);
  assert.equal(model.stateLine, 'Not connected');
  assert.equal(model.replace, false);
  assert.equal(keyFormModel({ seatId: 'grok', entryId: 'custom-keys' }), null, 'no name, no form — nothing invented');
  assert.equal(keyFormModel({ entryId: 'custom-keys', name: 'Weather Keys' }), null);
});

test('connected model: the stored state is shown as a state, and Replace is offered', () => {
  const model = freshModel({ connected: true, accountIdentity: 'Work key' });
  assert.equal(model.stateLine, 'Connected as Work key');
  assert.equal(model.replace, true);
  assert.equal(model.button.label, 'Store the new key and connect', 'Replace is a fresh store through the same road, worded as one');
  const bare = freshModel({ connected: true });
  assert.equal(bare.stateLine, 'Connected');
});

test('the empty-key refusal is the road\u2019s own words, pinned against the server file', async () => {
  const route = await readFile(new URL('../../../src/cloud/connector-library-write-route.mjs', import.meta.url), 'utf8');
  assert.ok(route.includes(EMPTY_KEY_MESSAGE), 'the client mirror words the refusal exactly as connect/header words it');
  assert.ok(route.includes("if (!apiKey) throw failure(400,"), 'the road refuses an empty key before any storage');
});

test('wire shapes: the three bodies are exactly the server contracts', () => {
  assert.deepEqual(connectStartBody({ seatId: 'grok', entryId: 'custom-keys' }), { seatId: 'grok', entryId: 'custom-keys' });
  assert.deepEqual(
    headerConnectBody({ seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value', accountLabel: '  Work key  ' }),
    { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value', accountLabel: 'Work key' },
    'the label is trimmed the way the road trims it; the key itself is never trimmed or altered',
  );
  assert.deepEqual(
    headerConnectBody({ seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value', accountLabel: '   ' }),
    { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value' },
    'a blank label rides not at all — the road names the connection itself',
  );
  assert.equal(headerConnectBody({ seatId: 'grok', entryId: 'custom-keys', apiKey: '' }), null, 'an empty key is refused here, never sent');
  assert.equal(headerConnectBody({ seatId: 'grok', apiKey: 'sk-x' }), null);
  assert.deepEqual(disconnectBody({ seatId: 'grok', entryId: 'custom-keys' }), { seatId: 'grok', entryId: 'custom-keys' });
  assert.equal(keyEntryKey('grok', 'custom-keys'), 'grok/custom-keys');
});

test('write folding: the face after a write is the write\u2019s own returned connection, not the form', () => {
  const model = freshModel();
  const after = applyKeyConnect(model, { status: 'connected', connection: connection({ accountIdentity: 'Work key' }) });
  assert.equal(after.connected, true);
  assert.equal(after.stateLine, 'Connected as Work key');
  assert.equal(applyKeyConnect(model, { status: 'connected' }), model, 'no connection record, no claim');
  assert.equal(applyKeyConnect(model, { status: 'connected', connection: connection({ state: 'disconnected' }) }), model,
    'a record that does not read connected never reads connected here');
  const off = applyKeyDisconnect(after, { status: 'disconnected', connection: connection({ state: 'disconnected' }), custodyRevoked: true });
  assert.equal(off.connected, false);
  assert.equal(off.stateLine, 'Not connected');
  assert.equal(applyKeyDisconnect(after, { status: 'disconnected' }), after, 'a disconnect with no record changes nothing');
});

test('round trip: Connect answers needs-credential, the submit stores through the header road, Replace and Disconnect follow', async () => {
  const calls = [];
  // Stubbed roads shaped exactly like the real ones: the connect
  // start answers the minted reference and connects nothing; the
  // header road stores and answers the full connection record
  // (its account label from the body's label, else its own
  // 'API key'); disconnect answers the cleared record.
  const post = async (path, body) => {
    calls.push([path, body]);
    if (path === KEY_CONNECT_PATH) {
      return { status: 'needs-credential', seatId: body.seatId, entryId: body.entryId, providerId: 'connector.grok.custom-keys', accessTokenRef: 'vault://connector/grok/custom-keys/access', completeAction: 'connect/header' };
    }
    if (path === KEY_HEADER_PATH) {
      return { status: 'connected', connection: connection({ accountIdentity: body.accountLabel ?? 'API key' }) };
    }
    if (path === KEY_DISCONNECT_PATH) {
      return { status: 'disconnected', connection: connection({ state: 'disconnected' }), revokedRefs: ['vault://connector/grok/custom-keys/access'], custodyRevoked: true };
    }
    throw new Error(`unexpected road ${path}`);
  };

  const start = await post(KEY_CONNECT_PATH, connectStartBody({ seatId: 'grok', entryId: 'custom-keys' }));
  assert.equal(isNeedsCredentialAnswer(start), true, 'the needs-credential answer is the key-kind signal that opens the form');
  assert.equal(isNeedsCredentialAnswer({ status: 'connected' }), false);
  assert.equal(isNeedsCredentialAnswer(null), false);

  let model = freshModel();
  const stored = await submitKeyForm({ post, model, values: { apiKey: 'sk-secret-value', accountLabel: 'Work key' } });
  assert.equal(stored.ok, true);
  assert.deepEqual(calls[1], [KEY_HEADER_PATH, { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value', accountLabel: 'Work key' }],
    'the submit posts exactly { seatId, entryId, apiKey, accountLabel } to the header road');
  model = stored.model;
  assert.equal(model.connected, true);
  assert.equal(model.stateLine, 'Connected as Work key', 'the state shown is the server\u2019s stored state, not the form\u2019s claim');

  const replaced = await submitKeyForm({ post, model, values: { apiKey: 'sk-new-value', accountLabel: '' } });
  assert.equal(replaced.ok, true);
  assert.deepEqual(calls[2], [KEY_HEADER_PATH, { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-new-value' }],
    'Replace is the same road with the fresh key and no invented label');
  assert.equal(replaced.model.stateLine, 'Connected as API key', 'the replaced state is again the road\u2019s returned record');

  const off = await disconnectKeyEntry({ post, model: replaced.model });
  assert.equal(off.ok, true);
  assert.deepEqual(calls[3], [KEY_DISCONNECT_PATH, { seatId: 'grok', entryId: 'custom-keys' }], 'disconnect posts exactly { seatId, entryId }');
  assert.equal(off.model.connected, false);
  assert.equal(calls.length, 4, 'no extra road was called');
});

test('empty key: refused in the form with the road\u2019s words — nothing is sent', async () => {
  let calls = 0;
  const post = async () => { calls += 1; throw new Error('must not be called'); };
  const model = freshModel();
  const out = await submitKeyForm({ post, model, values: { apiKey: '', accountLabel: 'Work key' } });
  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.error, EMPTY_KEY_MESSAGE);
  assert.equal(out.model, model);
  assert.equal(calls, 0);
});

test('refusals: the server\u2019s plain words surface in the form and nothing reads connected', async () => {
  const model = freshModel();
  const gatePost = async () => {
    throw Object.assign(new Error('409'), { status: 409, body: { valid: false, error: GATE_REFUSAL, code: 'CUSTOM_GATE_NOT_PASSED' } });
  };
  const gated = await submitKeyForm({ post: gatePost, model, values: { apiKey: 'sk-secret-value' } });
  assert.equal(gated.ok, false);
  assert.equal(gated.error, GATE_REFUSAL, 'a custom entry\u2019s gate refusal reaches the person word for word');
  assert.equal(gated.model, model, 'the model stands unchanged — nothing reads connected');

  const storePost = async () => {
    throw Object.assign(new Error('502'), { status: 502, body: { valid: false, error: STORE_REFUSAL, code: 'CREDENTIAL_STORE_REFUSED' } });
  };
  const refused = await submitKeyForm({ post: storePost, model, values: { apiKey: 'sk-secret-value' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, STORE_REFUSAL);
  assert.equal(refused.model.connected, false);

  const oddPost = async () => ({ status: 'needs-credential' });
  const odd = await submitKeyForm({ post: oddPost, model, values: { apiKey: 'sk-secret-value' } });
  assert.equal(odd.ok, false, 'a header answer with no stored connection is not a connect, however it is worded');
  assert.equal(odd.model, model);
});

test('custom and catalog entries ride the one header road — the gate is the server\u2019s, not a second shape', async () => {
  const calls = [];
  const post = async (path, body) => {
    calls.push([path, body]);
    return { status: 'connected', connection: connection({ seatId: body.seatId, entryId: body.entryId, accountIdentity: 'API key' }) };
  };
  const custom = await submitKeyForm({ post, model: freshModel(), values: { apiKey: 'sk-1' } });
  const catalog = await submitKeyForm({
    post,
    model: keyFormModel({ seatId: 'claude', entryId: 'registry-sap', name: 'SAP', kind: 'catalog' }),
    values: { apiKey: 'sk-2' },
  });
  assert.equal(custom.ok, true);
  assert.equal(catalog.ok, true);
  assert.deepEqual(calls.map(([p]) => p), [KEY_HEADER_PATH, KEY_HEADER_PATH], 'both kinds store through connect/header');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), Object.keys(calls[1][1]).sort(), 'the body shape is one shape for both');
});

test('the secret is never rendered back: no model, result, or state line carries the key', async () => {
  const SECRET = 'sk-secret-value';
  const post = async () => ({ status: 'connected', connection: connection({ accountIdentity: 'Work key' }) });
  const out = await submitKeyForm({ post, model: freshModel(), values: { apiKey: SECRET, accountLabel: 'Work key' } });
  assert.equal(out.ok, true);
  assert.ok(!JSON.stringify(out.model).includes(SECRET), 'the model after a store holds state only, never the key');
  for (const field of KEY_FORM_FIELDS) assert.ok(!('value' in field), `${field.name} declares no value — the field is write-only`);
  const walked = [];
  const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walked.push(k); walk(x); } };
  walk(out.model);
  assert.ok(!walked.includes('value') && !walked.includes('credential') && !walked.includes('storedKey'),
    'no field on the model could hold a secret to render back');
});

test('panel wiring: Connect\u2019s key answer opens the form in the panel — the Agents-tab funnel stands for its other users', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const needle of [
    "from './connector-key-form.mjs",
    'function openKeyForm',
    'function keyFormNode',
    'submitKeyForm({',
    'disconnectKeyEntry({',
    'isNeedsCredentialAnswer(out)',
    'Replace key',
    'ws.keyForm',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  const start = js.slice(js.indexOf('async function startPanelConnect'), js.indexOf('// The key form (panel-native home bite 2)'));
  assert.ok(start.includes('openKeyForm(which, row'), 'the needs-credential answer opens the form');
  assert.ok(!start.includes('openManageForSeat'), 'the key answer no longer funnels to the Agents tab');
  assert.ok(!start.includes('needs its key to connect'), 'the old toast is gone');
  assert.ok(!js.includes('needs its key to connect'), 'the old toast is gone everywhere');
  // The funnel itself stands for its remaining users: the mirror
  // rows and the Manage footer still ride openManageForSeat.
  assert.ok(js.includes("onclick: () => openManageForSeat(which) }, libraryIconTile(row), text"), 'mirror rows still open the Agents tab');
  assert.ok(js.includes("class: 'ew-picker-row ew-plus-manage', onclick: () => openManageForSeat(which)"), 'the Manage footer still opens the Agents tab');
  // The form's DOM: the secret input takes its type from the field
  // definition (password), and the node never writes a value back
  // into an input.
  const node = js.slice(js.indexOf('function keyFormNode'), js.indexOf('// The Level 2 model: one seat'));
  assert.ok(node.includes('type: field.type'), 'the input type comes from the field definition');
  assert.ok(!/\.value\s*=/.test(node), 'the form node never fills an input value — the key field is write-only');
  assert.ok(node.includes('model.intro') && node.includes('model.stateLine'), 'the form shows the intro and the stored state line');
});

// ---------- the read seed (panel key-seed bite, 2026-11-10) ----------
// The server-truth pair's half landed first: the library read now
// carries each entry's authMode from its definition. This bite is
// the panel half — the known set seeds from the read, so a header
// entry connected in an EARLIER session shows Replace in a fresh
// session with no connect attempt, and an unconnected one opens
// the key form on Connect without the round-trip answer. The rows
// below stub the library read in its POST-PUSH shape (the shape
// server-truth-pair's tests pin in connector-library-bite2): each
// row carries authMode beside kind/brokerMode/state. Against a
// read without the field, the panel falls back to today's
// behaviour exactly — the seed learns nothing and never guesses.

const readRow = (over = {}) => ({
  seatId: 'grok', entryId: 'custom-keys', name: 'Weather Keys',
  oneLiner: 'A service that takes an API key', vendorLabel: 'Custom',
  trustLabel: 'custom', iconRef: 'icon:custom', kind: 'custom',
  brokerMode: 'helmian', authMode: 'header', state: 'connected',
  accountIdentity: 'Work key', stateDetail: { posture: 'ask' },
  starterActions: [], ...over,
});
const NEEDS_CREDENTIAL = { status: 'needs-credential', seatId: 'grok', entryId: 'custom-keys', providerId: 'connector.grok.custom-keys', accessTokenRef: 'vault://connector/grok/custom-keys/access', completeAction: 'connect/header' };

test('seed: a fresh session learns key-kind from the read alone — a connected header entry is Replace-ready with no connect attempt', () => {
  const { seedKnownKeyEntries, knownKeyEntry, opensKeyFormFromSeed } = keyFormSeed;
  assert.equal(typeof seedKnownKeyEntries, 'function', 'the model carries the seed');
  // A fresh session: the known set starts empty, exactly as
  // resetLibrarySession leaves it. The ONLY input is the read.
  const known = seedKnownKeyEntries({}, [readRow()]);
  assert.deepEqual(knownKeyEntry(known, 'grok', 'custom-keys'),
    { seatId: 'grok', entryId: 'custom-keys', source: 'read' },
    'the read row alone taught the panel this entry takes a key');
  // The panel's own row model for that same read: a connected,
  // Helmian-brokered row is toggleable, and the renderer's Replace
  // condition is the known set carrying the entry's key — both
  // halves stand from the read, before any connect attempt.
  const level2 = level2Model({ seatId: 'grok', rows: [readRow()] }, {}, 'channel:c1');
  assert.equal(level2.connected.length, 1);
  assert.equal(level2.connected[0].toggleable, true);
  assert.ok(knownKeyEntry(known, 'grok', 'custom-keys'), 'the Replace row renders for a fresh session');
  // And its Connect-side twin: read-sourced means the form can
  // open from the seed without the connect-start round trip.
  assert.equal(opensKeyFormFromSeed(known, 'grok', 'custom-keys'), true);
});

test('seed: an unconnected header entry is seeded too — Connect opens the form from the read', () => {
  const { seedKnownKeyEntries, knownKeyEntry, opensKeyFormFromSeed } = keyFormSeed;
  const known = seedKnownKeyEntries({}, [readRow({ state: 'not-connected', accountIdentity: null })]);
  assert.deepEqual(knownKeyEntry(known, 'grok', 'custom-keys'),
    { seatId: 'grok', entryId: 'custom-keys', source: 'read' });
  assert.equal(opensKeyFormFromSeed(known, 'grok', 'custom-keys'), true,
    'Connect for a seeded entry opens the key form without asking the connect start first');
  const level2 = level2Model({ seatId: 'grok', rows: [readRow({ state: 'not-connected', accountIdentity: null })] }, {}, 'channel:c1');
  assert.equal(level2.catalog[0].connectable, true, 'the row still carries its Connect — the seed changes where Connect goes, not whether it stands');
});

test('seed: oauth, mirror and none rows never enter the known set', () => {
  const { seedKnownKeyEntries } = keyFormSeed;
  const known = {};
  const out = seedKnownKeyEntries(known, [
    readRow({ entryId: 'helmian-vercel', kind: 'catalog', authMode: 'oauth' }),
    readRow({ entryId: 'gmail', kind: 'catalog', authMode: 'oauth', brokerMode: 'vendor' }),
    readRow({ entryId: 'mirror-header', kind: 'catalog', authMode: 'header', brokerMode: 'vendor' }),
    readRow({ entryId: 'cloudflare-docs', kind: 'catalog', authMode: 'none' }),
    readRow({ entryId: 'local-notes', kind: 'mcp-local', authMode: 'header' }),
    readRow({ entryId: 'no-mode', kind: 'catalog', authMode: null }),
  ]);
  assert.equal(out, known, 'nothing seeded — the very same set object comes back');
  assert.deepEqual(out, {}, 'oauth rows, mirror rows (even one mislabelled header), none rows and mcp-local rows are never key-kind here');
});

test('fallback: a read without the authMode field seeds nothing — the panel learns from the connect answer exactly as today', () => {
  const { seedKnownKeyEntries, noteConnectAnswer, knownKeyEntry, opensKeyFormFromSeed } = keyFormSeed;
  const legacyRow = readRow();
  delete legacyRow.authMode;
  const known = {};
  const seeded = seedKnownKeyEntries(known, [legacyRow]);
  assert.equal(seeded, known, 'a fieldless row changes nothing — not even a new object');
  assert.equal(knownKeyEntry(seeded, 'grok', 'custom-keys'), null, 'no Replace in a fresh session, exactly as before the field existed');
  assert.equal(opensKeyFormFromSeed(seeded, 'grok', 'custom-keys'), false, 'Connect still makes the round trip');
  // Today's road, untouched: the connect start's needs-credential
  // answer teaches the entry, word for word the old signal.
  const taught = noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'custom-keys' }, NEEDS_CREDENTIAL);
  assert.deepEqual(knownKeyEntry(taught, 'grok', 'custom-keys'),
    { seatId: 'grok', entryId: 'custom-keys', source: 'answer' },
    'the answer path still teaches key-kind on its own');
  assert.equal(opensKeyFormFromSeed(taught, 'grok', 'custom-keys'), false,
    'an answer-sourced entry keeps today\u2019s road — its Connect asks the connect start again');
});

test('precedence: the connect start\u2019s live answer outranks the read seed, both ways', () => {
  const { seedKnownKeyEntries, noteConnectAnswer, knownKeyEntry } = keyFormSeed;
  const seeded = seedKnownKeyEntries({}, [readRow()]);
  // The road confirms the seed: the entry stands key-kind, now
  // answer-sourced — the fresher source replaces the seed's.
  const confirmed = noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'custom-keys' }, NEEDS_CREDENTIAL);
  assert.deepEqual(knownKeyEntry(confirmed, 'grok', 'custom-keys'),
    { seatId: 'grok', entryId: 'custom-keys', source: 'answer' },
    'a needs-credential answer upgrades a read seed to the live source');
  // The road disagrees: any other answered status clears the
  // seeded entry — the panel does not treat as key-kind what the
  // road just connected another way, or handed its own sign-in door.
  for (const out of [
    { status: 'connected', connection: connection() },
    { status: 'authorize', authorizeUrl: 'https://example.com/oauth' },
    { status: 'consent-boundary', note: 'This sign-in cannot be completed inside Helmian yet.' },
  ]) {
    const ruled = noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'custom-keys' }, out);
    assert.equal(knownKeyEntry(ruled, 'grok', 'custom-keys'), null, `a '${out.status}' answer clears the read seed — the live answer wins`);
  }
  // The same law over an earlier answer: a later live answer
  // clears an answer-sourced entry too.
  const cleared = noteConnectAnswer(confirmed, { seatId: 'grok', entryId: 'custom-keys' }, { status: 'connected', connection: connection() });
  assert.equal(knownKeyEntry(cleared, 'grok', 'custom-keys'), null);
  // No answer is no ruling: a thrown road error (null here) or an
  // answer with no status leaves the seed standing.
  assert.equal(noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'custom-keys' }, null), seeded);
  assert.equal(noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'custom-keys' }, {}), seeded);
  assert.equal(noteConnectAnswer(seeded, { seatId: 'grok', entryId: 'other-entry' }, { status: 'connected' }), seeded,
    'an answer about another entry rules nothing here');
});

test('seed: seeding only adds — it never overwrites an answer and never removes', () => {
  const { seedKnownKeyEntries, noteConnectAnswer } = keyFormSeed;
  const taught = noteConnectAnswer({}, { seatId: 'grok', entryId: 'custom-keys' }, NEEDS_CREDENTIAL);
  const reseeded = seedKnownKeyEntries(taught, [readRow()]);
  assert.equal(reseeded, taught, 'a re-read over an answer-known entry changes nothing');
  assert.equal(reseeded['grok/custom-keys'].source, 'answer', 'the answer\u2019s source is never downgraded to a read');
  const once = seedKnownKeyEntries({}, [readRow()]);
  assert.equal(seedKnownKeyEntries(once, [readRow()]), once, 'seeding the same read twice is a no-op the second time');
  assert.equal(seedKnownKeyEntries(once, []), once, 'an empty read un-teaches nothing');
});

test('seed wiring: the workspace seeds on library load, Connect opens from the seed, and every connect answer folds back', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const needle of ['seedKnownKeyEntries', 'noteConnectAnswer', 'opensKeyFormFromSeed']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  const load = js.slice(js.indexOf('export async function loadSeatLibrary'), js.indexOf('// The mount preload'));
  assert.ok(load.includes('ws.keyForm.known = seedKnownKeyEntries(ws.keyForm.known, library.rows)'),
    'the seat library load is where the read seeds the known set — preload and panel open alike');
  const start = js.slice(js.indexOf('async function startPanelConnect'), js.indexOf('// The key form (panel-native home bite 2)'));
  const seedGate = start.indexOf('opensKeyFormFromSeed(ws.keyForm.known, row.seatId, row.entryId)');
  const roundTrip = start.indexOf("ws.ctx.post('/api/admin/connector-library/connect'");
  assert.ok(seedGate !== -1 && roundTrip !== -1 && seedGate < roundTrip,
    'the seed gate stands before the connect-start call — a seeded Connect never makes the round trip');
  assert.ok(start.includes('ws.keyForm.known = noteConnectAnswer(ws.keyForm.known, row, out)'),
    'every answered connect start folds into the known set under the precedence rule');
  assert.ok(start.indexOf('noteConnectAnswer') < start.indexOf('isNeedsCredentialAnswer(out)'),
    'the fold happens before the answer branches — the needs-credential branch opens the form already answer-sourced');
  const open = js.slice(js.indexOf('function openKeyForm'), js.indexOf('async function saveKeyForm'));
  assert.ok(open.includes("source: kf.known[key]?.source ?? 'answer'"),
    'opening the form keeps the source the entry was known by — a seed stays a seed until a live answer re-rules it');
});
