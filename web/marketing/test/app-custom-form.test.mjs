import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  BAD_AUTH_MODE_MESSAGE,
  BAD_URL_MESSAGE,
  CUSTOM_AUTH_MODES,
  CUSTOM_CREATE_PATH,
  CUSTOM_FORM_FIELDS,
  HTTPS_URL_MESSAGE,
  MISSING_NAME_MESSAGE,
  MISSING_URL_MESSAGE,
  URL_CREDENTIALS_MESSAGE,
  applyCustomCreate,
  createCustomBody,
  customCreateValidationError,
  customFormModel,
  gateLine,
  gateModel,
  submitCustomForm,
} from '../app/connector-custom-form.mjs';

// Panel-native home bite 3 (2026-11-10): the add-a-custom-connector
// form in the channel connector panel — the Connectors list's last
// row opens the form in the panel, the submit posts the creation
// road's exact payload, and the entry that appears is the road's
// own returned record, created and not connected. The model's
// contracts are the real server ones:
//   POST /api/admin/connector-library/entries
//        { seatId, name, authMode, mcpEndpointUrl, oneLiner? }
//        → 201 { status:'created', entry, gate } (owner/admin)
//        refusals: no name 400 with MISSING_NAME_MESSAGE's words;
//        bad authMode 400 with BAD_AUTH_MODE_MESSAGE's words; an
//        address the library store refuses (missing / malformed /
//        not HTTPS / carrying credentials) with the store's words;
//        a non-owner/admin caller 403 with the workspace-level
//        words; a duplicate slug 409 with the store's conflict.
//        The gate is NOT a creation refusal: the entry is created
//        either way and the answer carries the check's state —
//        'verified' is the only state that reads as passed.

const OWNER_REFUSAL = 'this is a workspace-level change — it takes the workspace owner or an admin';
const DUPLICATE_REFUSAL = 'a custom connector is never edited in place — remove it and add it again (§1.4)';

const createdEntry = (over = {}) => ({
  seatId: 'grok', id: 'custom-weather-tools', kind: 'custom', name: 'Weather Tools',
  oneLiner: 'Weather lookups', vendorName: 'Custom', trustLabel: 'custom', category: null,
  brokerMode: 'helmian', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header',
  state: 'available', ...over,
});
const freshModel = () => customFormModel({ seatId: 'grok' });
const goodValues = (over = {}) => ({
  name: 'Weather Tools', mcpEndpointUrl: 'https://weather.example.com/mcp',
  oneLiner: 'Weather lookups', authMode: 'header', ...over,
});

test('fields: the form carries exactly the fields the creation road declares', () => {
  assert.deepEqual(CUSTOM_FORM_FIELDS.map((f) => [f.name, f.kind, f.type, f.required]), [
    ['name', 'text', 'text', true],
    ['mcpEndpointUrl', 'url', 'url', true],
    ['oneLiner', 'text', 'text', false],
    ['authMode', 'select', 'select', true],
  ], 'the name, the server address, the optional one line, and the sign-in picker — the road reads nothing else from a form');
  assert.deepEqual(CUSTOM_AUTH_MODES.map((m) => [m.value, m.label]), [
    ['none', 'No sign-in'],
    ['header', 'API key / header token'],
    ['oauth', 'OAuth sign-in'],
  ], 'the three auth modes the road accepts, worded as the removed Manage form worded them');
  const model = freshModel();
  assert.equal(model.fields, CUSTOM_FORM_FIELDS);
  assert.equal(model.authModes, CUSTOM_AUTH_MODES);
  assert.equal(model.defaultAuthMode, 'none');
  assert.match(model.intro, /Your own MCP server, added to this seat\u2019s library/, 'the intro is the removed Manage form\u2019s own words');
  assert.match(model.intro, /labelled \u201ccustom\u201d everywhere it shows/);
  assert.equal(model.button.label, 'Add it');
  assert.equal(customFormModel({}), null, 'no seat, no form — nothing invented');
  assert.equal(customFormModel(), null);
});

test('the client refusals are the road\u2019s own words, pinned against the server files', async () => {
  const route = await readFile(new URL('../../../src/cloud/connector-library-write-route.mjs', import.meta.url), 'utf8');
  const store = await readFile(new URL('../../../src/cloud/connector-library.mjs', import.meta.url), 'utf8');
  assert.ok(route.includes(MISSING_NAME_MESSAGE), 'the missing-name words are the entries action\u2019s own');
  assert.ok(route.includes(BAD_AUTH_MODE_MESSAGE), 'the auth-mode words are the entries action\u2019s own');
  assert.ok(route.includes("if (!['none', 'header', 'oauth'].includes(authMode))"), 'the road refuses an auth mode outside its three');
  assert.ok(store.includes(MISSING_URL_MESSAGE), 'the missing-address words are the store\u2019s own');
  assert.ok(store.includes(BAD_URL_MESSAGE), 'the malformed-address words are the store\u2019s own');
  assert.ok(store.includes(HTTPS_URL_MESSAGE.split('Helmian')[0].trimEnd()), 'the HTTPS words are the store\u2019s own');
  assert.ok(HTTPS_URL_MESSAGE.startsWith('mcpEndpointUrl must be HTTPS — connections are made from Helmian'), 'the client mirror carries the store\u2019s HTTPS refusal');
  assert.ok(store.includes(URL_CREDENTIALS_MESSAGE), 'the credentials-in-URL words are the store\u2019s own');
});

test('wire shape: the create body is exactly the server contract', () => {
  assert.deepEqual(
    createCustomBody({ seatId: 'grok', ...goodValues({ name: '  Weather Tools  ', mcpEndpointUrl: '  https://weather.example.com/mcp  ', oneLiner: '  Weather lookups  ' }) }),
    { seatId: 'grok', name: 'Weather Tools', mcpEndpointUrl: 'https://weather.example.com/mcp', oneLiner: 'Weather lookups', authMode: 'header' },
    'name, address and line ride trimmed, the way the road trims them',
  );
  assert.deepEqual(
    createCustomBody({ seatId: 'grok', ...goodValues({ oneLiner: '   ' }) }),
    { seatId: 'grok', name: 'Weather Tools', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header' },
    'a blank line rides not at all — the road names the entry by its name itself',
  );
  const body = createCustomBody({ seatId: 'grok', ...goodValues() });
  assert.ok(!('category' in body) && !('kind' in body) && !('brokerMode' in body) && !('vendorName' in body),
    'no field the form does not declare rides the body — kind, broker and vendor are the road\u2019s own record');
});

test('validation mirrors the road\u2019s refusals, in the road\u2019s order — nothing invalid is sent', async () => {
  const cases = [
    [{ name: '   ' }, MISSING_NAME_MESSAGE],
    [{ name: '' }, MISSING_NAME_MESSAGE],
    [{ authMode: 'magic' }, BAD_AUTH_MODE_MESSAGE],
    [{ authMode: '' }, BAD_AUTH_MODE_MESSAGE],
    [{ authMode: undefined }, BAD_AUTH_MODE_MESSAGE],
    [{ mcpEndpointUrl: '' }, MISSING_URL_MESSAGE],
    [{ mcpEndpointUrl: '   ' }, MISSING_URL_MESSAGE],
    [{ mcpEndpointUrl: 'not a url' }, BAD_URL_MESSAGE],
    [{ mcpEndpointUrl: 'weather.example.com/mcp' }, BAD_URL_MESSAGE],
    [{ mcpEndpointUrl: 'http://weather.example.com/mcp' }, HTTPS_URL_MESSAGE],
    [{ mcpEndpointUrl: 'https://user:pass@weather.example.com/mcp' }, URL_CREDENTIALS_MESSAGE],
  ];
  for (const [over, message] of cases) {
    const values = goodValues(over);
    assert.equal(customCreateValidationError({ seatId: 'grok', ...values }), message, `${JSON.stringify(over)} reads the road\u2019s refusal`);
    assert.equal(createCustomBody({ seatId: 'grok', ...values }), null, 'the shape is refused here, never built');
    let calls = 0;
    const post = async () => { calls += 1; throw new Error('must not be called'); };
    const out = await submitCustomForm({ post, model: freshModel(), values });
    assert.equal(out.ok, false);
    assert.equal(out.sent, false);
    assert.equal(out.error, message);
    assert.equal(out.created, null, 'a refused creation appears nowhere');
    assert.equal(calls, 0, 'nothing was sent');
  }
  // The road's order: a missing name outranks a bad address.
  assert.equal(
    customCreateValidationError({ seatId: 'grok', ...goodValues({ name: '', mcpEndpointUrl: 'nope' }) }),
    MISSING_NAME_MESSAGE,
  );
});

test('round trip: the submit posts the exact payload and the created entry is the road\u2019s returned record', async () => {
  const calls = [];
  // Stubbed road shaped exactly like the real one: the entry is
  // created standing in the library (state 'available', no
  // connection), and the answer carries the gate's state.
  const post = async (path, body) => {
    calls.push([path, body]);
    return { status: 'created', entry: createdEntry({ name: body.name, oneLiner: body.oneLiner ?? body.name, authMode: body.authMode }), gate: { state: 'verified', toolsCount: 3 } };
  };
  const out = await submitCustomForm({ post, model: freshModel(), values: goodValues() });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [[CUSTOM_CREATE_PATH, {
    seatId: 'grok', name: 'Weather Tools', mcpEndpointUrl: 'https://weather.example.com/mcp',
    oneLiner: 'Weather lookups', authMode: 'header',
  }]], 'the submit posts exactly { seatId, name, mcpEndpointUrl, oneLiner, authMode } to the entries road');
  assert.equal(out.created.entryId, 'custom-weather-tools', 'the entry id is the road\u2019s returned record\u2019s, never the form\u2019s slug guess');
  assert.equal(out.created.name, 'Weather Tools');
  assert.equal(out.created.kind, 'custom');
  assert.equal(out.created.state, 'not-connected', 'created is not connected — no connection was recorded');
  assert.equal(out.created.gate.passed, true);
  assert.equal(out.created.gate.line, 'Its safety check passed.');
});

test('the gate at creation is presented truthfully: a failed or unrun check never reads as passed', async () => {
  const postWithGate = (gate) => async () => ({ status: 'created', entry: createdEntry(), gate });
  const failed = await submitCustomForm({
    post: postWithGate({ state: 'failed', error: 'the server answered HTTP 500' }),
    model: freshModel(), values: goodValues(),
  });
  assert.equal(failed.ok, true, 'a failed check is not a creation refusal — the entry was created');
  assert.equal(failed.created.gate.passed, false);
  assert.equal(failed.created.gate.state, 'failed');
  assert.match(failed.created.gate.line, /safety check failed, so it cannot be connected yet/);
  assert.match(failed.created.gate.line, /HTTP 500/, 'the check\u2019s own recorded error rides the line');

  const notRun = await submitCustomForm({ post: postWithGate({ state: 'not-run' }), model: freshModel(), values: goodValues() });
  assert.equal(notRun.created.gate.passed, false);
  assert.match(notRun.created.gate.line, /has not run yet/);

  const errored = await submitCustomForm({ post: postWithGate({ state: 'error', error: 'store down' }), model: freshModel(), values: goodValues() });
  assert.equal(errored.created.gate.passed, false);
  assert.match(errored.created.gate.line, /could not be run/);

  assert.equal(gateModel(null).passed, false, 'no gate in the answer is not a passed gate');
  assert.equal(gateLine({ state: 'verified' }), 'Its safety check passed.');
  assert.equal(applyCustomCreate({ status: 'created', entry: createdEntry() }).gate.passed, false,
    'a created answer with no gate state folds to unpassed, never passed');
});

test('refusals: the server\u2019s plain words surface in the form and no entry appears', async () => {
  const throwing = (status, message, code) => async () => {
    throw Object.assign(new Error(String(status)), { status, body: { valid: false, error: message, ...(code ? { code } : {}) } });
  };
  const owner = await submitCustomForm({ post: throwing(403, OWNER_REFUSAL), model: freshModel(), values: goodValues() });
  assert.equal(owner.ok, false);
  assert.equal(owner.error, OWNER_REFUSAL, 'a member who is not owner/admin reads the road\u2019s workspace-level words word for word');
  assert.equal(owner.created, null);

  const dupe = await submitCustomForm({ post: throwing(409, DUPLICATE_REFUSAL), model: freshModel(), values: goodValues() });
  assert.equal(dupe.ok, false);
  assert.equal(dupe.error, DUPLICATE_REFUSAL, 'a duplicate name\u2019s conflict reaches the person word for word');
  assert.equal(dupe.created, null);

  const odd = await submitCustomForm({ post: async () => ({ status: 'ok' }), model: freshModel(), values: goodValues() });
  assert.equal(odd.ok, false, 'an answer that is not the created answer creates nothing here, however it is worded');
  assert.equal(odd.created, null);
  assert.equal(applyCustomCreate({ status: 'created' }), null, 'a created answer with no entry record folds to nothing');
  assert.equal(applyCustomCreate({ status: 'created', entry: createdEntry({ kind: 'custom' }) }).entryId, 'custom-weather-tools');
});

test('a header custom entry\u2019s key is a later road: creation carries no credential anywhere', async () => {
  const post = async (path, body) => {
    assert.ok(!('apiKey' in body) && !('token' in body) && !('secret' in body) && !('password' in body),
      'the creation body carries no credential value — the key form is the only road that ever receives one');
    return { status: 'created', entry: createdEntry(), gate: { state: 'verified', toolsCount: 1 } };
  };
  const out = await submitCustomForm({ post, model: freshModel(), values: goodValues({ authMode: 'header' }) });
  assert.equal(out.ok, true);
  assert.equal(out.created.authMode, 'header', 'the created entry is the kind the key form connects — through its connect start, afterwards');
});

test('panel wiring: the form opens in the panel at the Connectors list\u2019s last row, and the library re-read paints the entry', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const needle of [
    "from './connector-custom-form.mjs",
    'function openCustomForm',
    'function customFormNode',
    'function saveCustomForm',
    'submitCustomForm({',
    'ws.customForm',
    "'custom-add'",
    'Add a custom connector',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  const group = js.slice(js.indexOf("if (item.type === 'live-toggle-group')"), js.indexOf('let rows = boundRows(item);'));
  assert.ok(group.includes("out.push({ kind: 'custom-add', seatId })"), 'the Connectors list carries the add row');
  assert.ok(group.lastIndexOf("out.push({ kind: 'custom-add', seatId })") > group.indexOf("kind: 'row', row, rowShape"),
    'the add row stands after the entry rows — the end of the list the new entry joins');
  const node = js.slice(js.indexOf('function customFormNode'), js.indexOf('// ---------- composer "/" menu'));
  assert.ok(node.includes('model.intro') && node.includes('model.fields'), 'the form renders the model\u2019s intro and fields');
  assert.ok(node.includes('cf.created.gate.line'), 'after a creation the form states the safety check\u2019s own line');
  assert.ok(node.includes('not connected yet'), 'the created entry is stated as not connected');
  assert.ok(!/\.value\s*=[^=]/.test(node), 'the form node never writes a value back into an input');
  const save = js.slice(js.indexOf('async function saveCustomForm'), js.indexOf('function customFormNode'));
  assert.ok(save.includes('loadSeatLibrary(cf.seatId)'), 'after a creation the panel re-reads the seat\u2019s library — the list state is the stored record');
  assert.ok(save.includes('cf.error = result.error'), 'a refusal stays in the form as the server\u2019s words');
  // The removal road is not wired here: creation only, per scope.
  assert.ok(!js.includes('entries/remove'), 'no removal control is built in this bite');
});
