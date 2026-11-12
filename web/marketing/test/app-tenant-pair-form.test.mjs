import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  EMPTY_PAIR_MESSAGE,
  PAIR_CALLBACK_URL,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  applyPairStatus,
  applyPairStored,
  fetchPairStatus,
  isNeedsTenantPairAnswer,
  pairFormFields,
  pairFormModel,
  pairProviderFacts,
  pairStatusBody,
  pairStoreBody,
  submitPairForm,
} from '../app/connector-tenant-pair-form.mjs';
import { level2Model } from '../app/connector-panel.mjs';

// The tenant-pair form (Box bite, 2026-11-10): the panel face for
// the providers whose OAuth road runs on a client pair the
// customer's admin mints in the provider's own console. The
// model's contracts are the real server ones
// (src/cloud/connector-library-write-route.mjs):
//   POST /api/admin/connector-library/connect { seatId, entryId }
//        → no pair stored: { status:'needs-tenant-pair', provider, note }
//   POST /api/admin/connector-library/tenant-pair/status { provider }
//        → { status:'pair-status', provider, pairConfigured }
//   POST /api/admin/connector-library/tenant-pair
//        { provider, clientId, clientSecret }
//        → { status:'pair-stored', provider, pairConfigured:true }
//        refusals: non-admin 403; incomplete pair 400 with
//        EMPTY_PAIR_MESSAGE's words; a Guard-refused replacement
//        409; credential storage off 503.
// The pair is the TENANT's: the form names a provider, never a
// seat or a person, and no model here ever carries a pair value.

const boxModel = (pairConfigured = null) => pairFormModel({ provider: 'box', name: 'Box', pairConfigured });

test('the Box form: console words, the callback, and the pair fields', () => {
  const model = boxModel();
  assert.equal(model.provider, 'box');
  assert.equal(model.callbackUrl, PAIR_CALLBACK_URL);
  assert.equal(model.callbackUrl, 'https://helmian.cloud/api/admin/connector-library/oauth/callback');
  assert.match(model.intro, /Box Admin Console/);
  assert.match(model.intro, /your workspace/);
  assert.match(model.stateLine, /Checking whether a pair is stored/);
  const fields = pairFormFields('box');
  assert.deepEqual(fields.map((f) => f.name), ['clientId', 'clientSecret']);
  assert.equal(fields[0].type, 'text');
  assert.equal(fields[1].type, 'password');
  assert.equal(fields[1].kind, 'secret');
  assert.equal(model.button.label, 'Store the pair');
  assert.equal(model.replace, false);
});

test('a stored pair reads as stored state and a Replace button — never a value', () => {
  const model = boxModel(true);
  assert.equal(model.stateLine, 'A client pair is stored for Box.');
  assert.equal(model.button.label, 'Replace the stored pair');
  assert.equal(model.replace, true);
  // No field of the model carries anything that could be a value.
  assert.equal(JSON.stringify(model).includes('clientSecretValue'), false);
  assert.equal('values' in model, false);
});

test('unknown providers build no form and no bodies', () => {
  assert.equal(pairProviderFacts('nope'), null);
  assert.equal(pairFormModel({ provider: 'nope', name: 'Nope' }), null);
  assert.equal(pairStatusBody({ provider: 'nope' }), null);
  assert.equal(pairStoreBody({ provider: 'nope', clientId: 'x', clientSecret: 'y' }), null);
});

test('the connect answer signal is exactly needs-tenant-pair', () => {
  assert.equal(isNeedsTenantPairAnswer({ status: 'needs-tenant-pair', provider: 'box' }), true);
  assert.equal(isNeedsTenantPairAnswer({ status: 'needs-credential' }), false);
  assert.equal(isNeedsTenantPairAnswer(null), false);
});

test('wire bodies: status names the provider only; store carries the pair once', () => {
  assert.deepEqual(pairStatusBody({ provider: 'box' }), { provider: 'box' });
  assert.deepEqual(
    pairStoreBody({ provider: 'box', clientId: ' id-1 ', clientSecret: 'secret-1' }),
    { provider: 'box', clientId: 'id-1', clientSecret: 'secret-1' },
  );
  assert.equal(pairStoreBody({ provider: 'box', clientId: '', clientSecret: 's' }), null);
  assert.equal(pairStoreBody({ provider: 'box', clientId: 'i', clientSecret: '' }), null);
});

test('the status round trip fills the model from the server\u2019s boolean', async () => {
  const posts = [];
  const post = async (path, body) => {
    posts.push([path, body]);
    return { status: 'pair-status', provider: 'box', pairConfigured: true };
  };
  const result = await fetchPairStatus({ post, model: boxModel() });
  assert.equal(result.ok, true);
  assert.deepEqual(posts, [[PAIR_STATUS_PATH, { provider: 'box' }]]);
  assert.equal(result.model.pairConfigured, true);
  // A refusal lands as plain words and the model stands.
  const refused = await fetchPairStatus({
    post: async () => { throw Object.assign(new Error('x'), { body: { error: 'only the workspace owner or an admin can do that' } }); },
    model: boxModel(),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /only the workspace owner or an admin/);
  assert.equal(refused.model.pairConfigured, null);
});

test('applyPairStatus and applyPairStored take the model only from server answers', () => {
  const before = boxModel();
  assert.equal(applyPairStatus(before, { status: 'pair-status', pairConfigured: 'yes' }), before);
  assert.equal(applyPairStatus(before, { status: 'pair-status', pairConfigured: false }).pairConfigured, false);
  assert.equal(applyPairStored(before, { status: 'pair-stored', pairConfigured: true }).pairConfigured, true);
  assert.equal(applyPairStored(before, { status: 'something-else', pairConfigured: true }), before);
});

test('submit: success posts the pair once and the model re-derives from the answer', async () => {
  const posts = [];
  const post = async (path, body) => {
    posts.push([path, body]);
    return { status: 'pair-stored', provider: 'box', pairConfigured: true };
  };
  const result = await submitPairForm({ post, model: boxModel(false), values: { clientId: 'id-9', clientSecret: 'secret-9' } });
  assert.equal(result.ok, true);
  assert.deepEqual(posts, [[PAIR_PATH, { provider: 'box', clientId: 'id-9', clientSecret: 'secret-9' }]]);
  assert.equal(result.model.pairConfigured, true);
  assert.equal(result.model.replace, true);
});

test('submit: an incomplete pair is refused client-side with the road\u2019s own words and nothing is sent', async () => {
  let calls = 0;
  const post = async () => { calls += 1; return {}; };
  const result = await submitPairForm({ post, model: boxModel(false), values: { clientId: 'id-9', clientSecret: '' } });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, EMPTY_PAIR_MESSAGE);
  assert.equal(calls, 0);
});

test('submit: a Guard refusal surfaces in plain words and nothing reads stored', async () => {
  const post = async () => {
    throw Object.assign(new Error('x'), {
      body: { error: 'a client pair is already stored for this workspace, and replacing it needs a Guard approval first — the new pair was not stored' },
    });
  };
  const result = await submitPairForm({ post, model: boxModel(true), values: { clientId: 'id-2', clientSecret: 'secret-2' } });
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.match(result.error, /needs a Guard approval first/);
  assert.equal(result.model.pairConfigured, true, 'the model still shows the OLD pair\u2019s state — the refused one changed nothing');
});

test('the panel row model carries the pair marking from the read', () => {
  const level2 = level2Model({
    seatId: 'claude',
    rows: [{
      seatId: 'claude', entryId: 'helmian-box', name: 'Box',
      oneLiner: 'Read and search the files in Box', vendorLabel: 'Connector by Helmian',
      trustLabel: 'community', iconRef: 'icon:box', kind: 'catalog',
      brokerMode: 'helmian', authMode: 'oauth', state: 'not-connected',
      tenantPair: true, oauthProvider: 'box', starterActions: [],
    }],
  }, {}, 'channel:c1');
  const row = level2.catalog[0];
  assert.equal(row.tenantPair, true);
  assert.equal(row.oauthProvider, 'box');
  assert.equal(row.connectable, true);
});

test('the workspace wires the pair form: the answer, the row action, and the form node', async () => {
  const source = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(source, /isNeedsTenantPairAnswer\(out\)/);
  assert.match(source, /openPairForm\(which, row, \{ note: out\.note/);
  assert.match(source, /function pairActionRow\(which, row\)/);
  assert.match(source, /function pairFormNode\(which, row\)/);
  assert.match(source, /row\.tenantPair/);
});
