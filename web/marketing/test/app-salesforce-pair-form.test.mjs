import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pairFormFields,
  pairFormModel,
  pairStoreBody,
} from '../app/connector-tenant-pair-form.mjs';

// The Salesforce pair form (Salesforce bite, 2026-11-10): the
// same tenant-pair form as Box, with Salesforce's one extra fact
// — the endpoint is per org, so the pair is incomplete without
// the org's MCP server path, and the form carries that field.
// The wire contract is the write route's tenant-pair action:
//   { provider:'salesforce', clientId, clientSecret, serverPath }
// The route composes the endpoint from the path at the store;
// the form sends the path, never an address of its own devising.

test('the Salesforce form carries the server-path field; Box\u2019s does not', () => {
  const fields = pairFormFields('salesforce');
  assert.deepEqual(fields.map((f) => f.name), ['clientId', 'clientSecret', 'serverPath']);
  const path = fields[2];
  assert.equal(path.required, true);
  assert.match(path.label, /MCP server path/);
  assert.equal(path.placeholder, 'platform/sobject-reads');
  assert.deepEqual(pairFormFields('box').map((f) => f.name), ['clientId', 'clientSecret']);
});

test('the Salesforce model speaks Setup\u2019s words: External Client App, MCP Servers, the callback', () => {
  const model = pairFormModel({ provider: 'salesforce', name: 'Salesforce', pairConfigured: false });
  assert.match(model.intro, /Salesforce Setup/);
  assert.match(model.intro, /External Client App/);
  assert.match(model.intro, /your workspace/);
  assert.equal(model.callbackUrl, 'https://helmian.cloud/api/admin/connector-library/oauth/callback');
  assert.equal(model.stateLine, 'No client pair is stored for Salesforce yet.');
  assert.equal(model.button.label, 'Store the pair');
});

test('the store body carries the path for Salesforce and refuses an incomplete pair', () => {
  assert.deepEqual(
    pairStoreBody({ provider: 'salesforce', clientId: ' id-1 ', clientSecret: 'secret-1', serverPath: ' platform/sobject-reads ' }),
    { provider: 'salesforce', clientId: 'id-1', clientSecret: 'secret-1', serverPath: 'platform/sobject-reads' },
  );
  assert.equal(pairStoreBody({ provider: 'salesforce', clientId: 'id-1', clientSecret: 'secret-1' }), null,
    'no path, no body — the client mirror of the route\u2019s refusal');
  assert.equal(pairStoreBody({ provider: 'salesforce', clientId: 'id-1', clientSecret: 'secret-1', serverPath: '  ' }), null);
  // A Box body never carries a path, even if one is handed in.
  assert.deepEqual(
    pairStoreBody({ provider: 'box', clientId: 'id-1', clientSecret: 'secret-1', serverPath: 'platform/sobject-reads' }),
    { provider: 'box', clientId: 'id-1', clientSecret: 'secret-1' },
  );
});
